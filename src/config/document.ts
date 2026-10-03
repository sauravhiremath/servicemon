import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMap, parseDocument, YAMLMap } from 'yaml';
import { AppError } from '../shared/errors.js';
import type { CompiledConfig } from '../shared/types.js';
import { compileConfig, qualifyReference } from './compile.js';
import { ownStartedAt, processIdentity } from './process-identity.js';

export interface ConfigEdit {
  kind: 'project' | 'service' | 'task' | 'compose';
  action: 'add' | 'remove';
  projectId?: string;
  key: string;
  fields?: Record<string, unknown>;
}

const NAME = /^[A-Za-z0-9_-]+$/;

function assertName(value: string, label: string): void {
  if (!NAME.test(value)) {
    throw new AppError(
      'INVALID_CONFIG',
      `${label} must use letters, digits, underscores, and hyphens.`,
    );
  }
}

function mapping(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) {
    throw new AppError('INVALID_CONFIG', `${label} is not a mapping.`);
  }
  return value;
}

function childMap(parent: YAMLMap, key: string): YAMLMap {
  const current = parent.get(key, true);
  if (current == null) {
    const created = new YAMLMap();
    parent.set(key, created);
    return created;
  }
  return mapping(current, key);
}

function collection(
  parent: YAMLMap,
  projectId: string | undefined,
  kind: ConfigEdit['kind'],
): YAMLMap {
  const projects = childMap(mapping(parent, 'root'), 'projects');
  if (kind === 'project') {
    return projects;
  }
  if (!projectId) {
    throw new AppError('INVALID_INPUT', 'projectId is required.');
  }
  const project = projects.get(projectId, true);
  if (!isMap(project)) {
    throw new AppError('UNKNOWN_ENTRY', `Unknown project ${projectId}.`);
  }
  const field = kind === 'service' ? 'services' : kind === 'task' ? 'tasks' : 'compose_groups';
  return childMap(project, field);
}

function removedId(edit: ConfigEdit): string {
  if (edit.kind === 'project') {
    return edit.key;
  }
  if (!edit.projectId) {
    throw new AppError('INVALID_INPUT', 'projectId is required.');
  }
  return edit.kind === 'compose'
    ? `${edit.projectId}/${edit.key}.`
    : `${edit.projectId}/${edit.key}`;
}

function dependsOnValues(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('depends_on' in value)) {
    return [];
  }
  const depends = value.depends_on;
  if (!Array.isArray(depends)) {
    return [];
  }
  return depends.filter((item): item is string => typeof item === 'string');
}

function referencesRemoved(edit: ConfigEdit, qualified: string, target: string): boolean {
  if (edit.kind === 'project') {
    return qualified.startsWith(`${target}/`);
  }
  if (edit.kind === 'compose') {
    return qualified.startsWith(target);
  }
  return qualified === target;
}

function assertUnreferenced(source: string, edit: ConfigEdit): void {
  if (edit.action !== 'remove') {
    return;
  }
  const raw = parseDocument(source, { uniqueKeys: true }).toJS({ maxAliasCount: 100 });
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !('projects' in raw) ||
    !raw.projects ||
    typeof raw.projects !== 'object' ||
    Array.isArray(raw.projects)
  ) {
    return;
  }
  const target = removedId(edit);
  for (const [projectId, project] of Object.entries(raw.projects)) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      continue;
    }
    for (const [section, entries] of Object.entries(project)) {
      if (section !== 'services' && section !== 'tasks' && section !== 'compose_groups') {
        continue;
      }
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        continue;
      }
      for (const [key, entry] of Object.entries(entries)) {
        for (const ref of dependsOnValues(entry)) {
          const qualified = qualifyReference(projectId, ref);
          if (referencesRemoved(edit, qualified, target)) {
            throw new AppError(
              'INVALID_CONFIG',
              `Cannot remove ${edit.kind} ${edit.key}; ${projectId}/${key} still depends on ${qualified}.`,
            );
          }
        }
        if (
          section !== 'compose_groups' ||
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          !('services' in entry) ||
          !entry.services ||
          typeof entry.services !== 'object' ||
          Array.isArray(entry.services)
        ) {
          continue;
        }
        for (const [service, override] of Object.entries(entry.services)) {
          for (const ref of dependsOnValues(override)) {
            const qualified = qualifyReference(projectId, ref);
            if (referencesRemoved(edit, qualified, target)) {
              throw new AppError(
                'INVALID_CONFIG',
                `Cannot remove ${edit.kind} ${edit.key}; ${projectId}/${key}.${service} still depends on ${qualified}.`,
              );
            }
          }
        }
      }
    }
  }
}

export function proposeEdit(source: string, edit: ConfigEdit): string {
  assertName(edit.key, 'Key');
  if (edit.projectId) {
    assertName(edit.projectId, 'Project');
  }
  const doc = parseDocument(source.trim() === '' ? 'version: 1\n' : source, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new AppError('INVALID_CONFIG', doc.errors[0]!.message);
  }
  const root = mapping(doc.contents, 'Config');
  const target = collection(root, edit.projectId, edit.kind);
  if (edit.action === 'add') {
    if (target.has(edit.key)) {
      throw new AppError('INVALID_CONFIG', `${edit.kind} ${edit.key} already exists.`);
    }
    target.set(edit.key, edit.fields ?? {});
  } else if (!target.has(edit.key)) {
    throw new AppError('UNKNOWN_ENTRY', `Unknown ${edit.kind} ${edit.key}.`);
  } else {
    target.delete(edit.key);
  }
  const proposed = doc.toString();
  assertUnreferenced(proposed, edit);
  return proposed;
}
function isCompiledConfig(value: unknown): value is CompiledConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<CompiledConfig>;
  return (
    Array.isArray(record.entries) &&
    Array.isArray(record.projects) &&
    typeof record.path === 'string'
  );
}

function isEdit(value: unknown): value is ConfigEdit {
  if (
    !value ||
    typeof value !== 'object' ||
    !('kind' in value) ||
    !('action' in value) ||
    !('key' in value)
  ) {
    return false;
  }
  const { kind, action, key } = value;
  return (
    (kind === 'project' || kind === 'service' || kind === 'task' || kind === 'compose') &&
    (action === 'add' || action === 'remove') &&
    typeof key === 'string'
  );
}

export function proposedEdit(source: string, edit: unknown): string {
  if (!isEdit(edit)) {
    throw new AppError('INVALID_INPUT', 'Config edit is not valid.');
  }
  return proposeEdit(source, edit);
}

export async function commitConfig(
  filePath: string,
  expectedSource: string,
  proposed: string,
): Promise<void> {
  const absolute = path.resolve(filePath);
  const release = await acquireConfigLock(absolute);
  try {
    let current: string | undefined;
    try {
      current = await readFile(absolute, 'utf8');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (current !== expectedSource) {
      throw new AppError(
        'STALE_CONFIG',
        'Config changed before replacement. The new file was kept.',
      );
    }
    const mode = current === undefined ? 0o600 : (await stat(absolute)).mode & 0o777;
    await atomicWrite(absolute, proposed, mode);
  } finally {
    await release();
  }
}

async function fingerprint(filePath: string): Promise<string | undefined> {
  try {
    const body = await readFile(filePath);
    const info = await stat(filePath);
    return `${info.ino}:${createHash('sha256').update(body).digest('hex')}`;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicWrite(filePath: string, body: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await chmod(filePath, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function lockFields(body: string): { pid?: number; startedAt?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  const pid = 'pid' in parsed && typeof parsed.pid === 'number' ? parsed.pid : undefined;
  const startedAt =
    'startedAt' in parsed && typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
  return { pid, startedAt };
}

async function acquireConfigLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const startedAt = await ownStartedAt();
  const token = randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid: process.pid, startedAt, token });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(body);
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readFile(lockPath, 'utf8').catch(() => '');
        if (current.includes(token)) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
      const { pid, startedAt: ownerStarted } = lockFields(
        await readFile(lockPath, 'utf8').catch(() => ''),
      );
      if (pid === undefined || ownerStarted === undefined) {
        const info = await stat(lockPath).catch(() => undefined);
        if (!info || Date.now() - info.mtimeMs > 5000) {
          await rm(lockPath, { force: true });
        } else {
          await delay(50);
        }
        continue;
      }
      const identity = await processIdentity(pid);
      if (identity.state === 'uncertain') {
        throw new AppError(
          'CONFIG_BUSY',
          'Config lock owner is uncertain. The file was not changed.',
        );
      }
      if (identity.state === 'alive' && identity.startedAt === ownerStarted) {
        throw new AppError('CONFIG_BUSY', 'Config is being edited by another process.');
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new AppError('CONFIG_BUSY', 'Could not acquire the config lock.');
}

export async function editConfig(
  filePath: string,
  edit: ConfigEdit,
  validate?: (source: string) => Promise<unknown>,
): Promise<CompiledConfig> {
  const absolute = path.resolve(filePath);
  const release = await acquireConfigLock(absolute);
  try {
    const before = await fingerprint(absolute);
    let source = 'version: 1\n';
    let mode = 0o600;
    if (before) {
      source = await readFile(absolute, 'utf8');
      mode = (await stat(absolute)).mode & 0o777;
    } else if (edit.action === 'remove') {
      throw new AppError('CONFIG_NOT_FOUND', `Config not found: ${absolute}`);
    }
    const proposed = proposeEdit(source, edit);
    const validated = validate ? await validate(proposed) : undefined;
    const compiled = isCompiledConfig(validated) ? validated : compileConfig(proposed, absolute);
    if ((await fingerprint(absolute)) !== before) {
      throw new AppError(
        'STALE_CONFIG',
        'Config changed before replacement. The new file was kept.',
      );
    }
    await atomicWrite(absolute, proposed, mode);
    return compiled;
  } finally {
    await release();
  }
}
