import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateGraphs } from '../manager/graphs.js';
import { AppError } from '../shared/errors.js';
import type { Check, CompiledConfig, ComposeGroup, Entry, Project } from '../shared/types.js';
import { resolveAgainst } from './paths.js';
import {
  parseConfig,
  type ParsedCheck,
  type ParsedGroup,
  type ParsedOverride,
  type ParsedService,
  type ParsedTask,
} from './schema.js';

const NAME = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_PORT = 7331;
const DEFAULT_PER_ENTRY = 268435456;
const DEFAULT_TOTAL = 4294967296;
const DEFAULT_STOP = 10;
const DEFAULT_READY = 60;
const DEFAULT_INTERVAL = 2;
const DEFAULT_CHECK_TIMEOUT = 3;

function assertName(value: string, label: string): void {
  if (!NAME.test(value)) {
    throw new AppError(
      'INVALID_CONFIG',
      `${label} must use letters, digits, underscores, and hyphens.`,
    );
  }
}

export function qualifyReference(projectId: string, ref: string): string {
  const parts = ref.split('/');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new AppError('INVALID_CONFIG', `Invalid reference ${ref}.`);
  }
  const project = parts.length === 2 ? parts[0]! : projectId;
  const local = parts.length === 2 ? parts[1]! : parts[0]!;
  assertName(project, `Reference project ${project}`);
  const segments = local.split('.');
  if (segments.length > 2) {
    throw new AppError('INVALID_CONFIG', `Invalid reference ${ref}.`);
  }
  for (const segment of segments) {
    assertName(segment, `Reference ${ref}`);
  }
  return `${project}/${local}`;
}

function checkOf(check: ParsedCheck | undefined): Check | undefined {
  if (!check) {
    return undefined;
  }
  const interval = check.interval_seconds ?? DEFAULT_INTERVAL;
  const timeout = check.timeout_seconds ?? DEFAULT_CHECK_TIMEOUT;
  if (check.type === 'http') {
    return {
      type: 'http',
      url: check.url,
      expected_status: check.expected_status ?? 200,
      interval_seconds: interval,
      timeout_seconds: timeout,
    };
  }
  if (check.type === 'tcp') {
    return {
      type: 'tcp',
      host: check.host,
      port: check.port,
      interval_seconds: interval,
      timeout_seconds: timeout,
    };
  }
  return {
    type: 'command',
    command: check.command,
    interval_seconds: interval,
    timeout_seconds: timeout,
  };
}

function refs(projectId: string, values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => qualifyReference(projectId, value)))];
}

function commandEntry(
  project: Project,
  key: string,
  kind: 'service' | 'task',
  value: ParsedService | ParsedTask,
  stopSeconds: number,
  restartDependencies: boolean,
  restartDependents: boolean,
  healthcheck: Check | undefined,
  entryReadiness: number,
): Entry {
  assertName(key, `${project.id} entry ${key}`);
  const directory = value.directory
    ? resolveAgainst(project.directory, value.directory)
    : project.directory;
  return {
    id: `${project.id}/${key}`,
    projectId: project.id,
    key,
    name: value.name ?? key,
    kind,
    directory,
    command: value.command,
    notes: value.notes,
    links: value.links ?? [],
    dependsOn: refs(project.id, value.depends_on),
    autostart: value.autostart ?? false,
    restartDependencies,
    restartDependents,
    healthcheck,
    stopSeconds: value.stop_seconds ?? stopSeconds,
    readinessSeconds: entryReadiness,
    execution: { kind, command: value.command, directory },
  };
}

function discoveredServices(
  record: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!record) {
    return undefined;
  }
  const services = record.services;
  if (services === undefined) {
    return {};
  }
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new AppError('INVALID_CONFIG', 'Compose discovery services must be a mapping.');
  }
  const found: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(services)) {
    assertName(name, `Discovered Compose service ${name}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError('INVALID_CONFIG', `Discovered Compose service ${name} must be a mapping.`);
    }
    found[name] = Object.fromEntries(Object.entries(value));
  }
  return found;
}

function composeProjectName(
  projectId: string,
  groupKey: string,
  explicit: string | undefined,
): string {
  if (explicit) {
    if (!COMPOSE_PROJECT.test(explicit)) {
      throw new AppError(
        'INVALID_CONFIG',
        `Compose project name ${explicit} must be lowercase letters, digits, underscores, or hyphens.`,
      );
    }
    return explicit;
  }
  const derived = `sm-${projectId}-${groupKey}`.toLowerCase();
  if (!COMPOSE_PROJECT.test(derived)) {
    throw new AppError('INVALID_CONFIG', `Derived Compose project name ${derived} is not valid.`);
  }
  return derived;
}

function composeEntry(
  project: Project,
  group: ComposeGroup,
  serviceName: string,
  override: ParsedOverride | undefined,
  discovered: Record<string, unknown>,
  stopSeconds: number,
  readinessSeconds: number,
): Entry {
  const key = `${group.key}.${serviceName}`;
  return {
    id: `${project.id}/${key}`,
    projectId: project.id,
    key,
    name: override?.name ?? serviceName,
    kind: 'compose',
    directory: group.directory,
    notes: override?.notes,
    links: override?.links ?? [],
    dependsOn: refs(project.id, override?.depends_on),
    autostart: override?.autostart ?? group.autostart,
    restartDependencies: override?.restart_dependencies ?? false,
    restartDependents: override?.restart_dependents ?? false,
    stopSeconds,
    readinessSeconds: override?.readiness_seconds ?? readinessSeconds,
    composeGroupId: group.id,
    composeService: serviceName,
    execution: {
      kind: 'compose',
      directory: group.directory,
      file: group.file,
      projectName: group.projectName,
      service: serviceName,
      discovered,
    },
  };
}

function deferredComposeRef(
  id: string,
  groups: ComposeGroup[],
  discovered: ReadonlySet<string>,
): boolean {
  return groups.some((group) => !discovered.has(group.id) && id.startsWith(`${group.id}.`));
}

function compileGroup(
  project: Project,
  key: string,
  value: ParsedGroup,
  discoveries: Map<string, Record<string, unknown>> | undefined,
  discoveredGroups: Set<string>,
  composeNames: Map<string, string>,
  entries: Entry[],
  stopSeconds: number,
  readinessSeconds: number,
): ComposeGroup {
  assertName(key, `${project.id} Compose group ${key}`);
  const directory = value.directory
    ? resolveAgainst(project.directory, value.directory)
    : project.directory;
  const projectName = composeProjectName(project.id, key, value.project_name);
  const id = `${project.id}/${key}`;
  const owner = composeNames.get(projectName);
  if (owner) {
    throw new AppError(
      'INVALID_CONFIG',
      `Compose project name ${projectName} is used by ${owner} and ${id}.`,
      { groups: [owner, id] },
    );
  }
  composeNames.set(projectName, id);
  for (const overrideName of Object.keys(value.services ?? {})) {
    assertName(overrideName, `${id} override ${overrideName}`);
  }
  const group: ComposeGroup = {
    id,
    projectId: project.id,
    key,
    name: value.name ?? key,
    directory,
    file: resolveAgainst(directory, value.file),
    projectName,
    autostart: value.autostart ?? false,
    overrides: value.services ?? {},
  };
  const discovery = discoveries?.get(id);
  const services = discoveredServices(discovery);
  if (discovery) {
    discoveredGroups.add(id);
  }
  if (services) {
    for (const overrideName of Object.keys(value.services ?? {})) {
      if (!(overrideName in services)) {
        throw new AppError(
          'INVALID_CONFIG',
          `Unknown Compose service override ${overrideName} in ${id}.`,
        );
      }
    }
    for (const [serviceName, discovered] of Object.entries(services)) {
      entries.push(
        composeEntry(
          project,
          group,
          serviceName,
          value.services?.[serviceName],
          discovered,
          stopSeconds,
          readinessSeconds,
        ),
      );
    }
    group.services = services;
  }
  return group;
}

export function compileConfig(
  source: string,
  configPath: string,
  discoveries?: Map<string, Record<string, unknown>>,
): CompiledConfig {
  const parsed = parseConfig(source);
  const absolutePath = path.resolve(configPath);
  const configDir = path.dirname(absolutePath);
  const stopSeconds = parsed.timeouts?.stop_seconds ?? DEFAULT_STOP;
  const readinessSeconds = parsed.timeouts?.readiness_seconds ?? DEFAULT_READY;
  const projects: Project[] = [];
  const groups: ComposeGroup[] = [];
  const entries: Entry[] = [];
  const composeNames = new Map<string, string>();
  const discoveredGroups = new Set<string>();
  for (const [projectId, projectValue] of Object.entries(parsed.projects ?? {})) {
    assertName(projectId, `Project ${projectId}`);
    const project: Project = {
      id: projectId,
      name: projectValue.name ?? projectId,
      directory: resolveAgainst(configDir, projectValue.directory),
      notes: projectValue.notes,
    };
    projects.push(project);
    for (const [key, value] of Object.entries(projectValue.services ?? {})) {
      entries.push(
        commandEntry(
          project,
          key,
          'service',
          value,
          stopSeconds,
          value.restart_dependencies ?? false,
          value.restart_dependents ?? false,
          checkOf(value.healthcheck),
          value.readiness_seconds ?? readinessSeconds,
        ),
      );
    }
    for (const [key, value] of Object.entries(projectValue.tasks ?? {})) {
      entries.push(
        commandEntry(
          project,
          key,
          'task',
          value,
          stopSeconds,
          false,
          false,
          undefined,
          readinessSeconds,
        ),
      );
    }
    for (const [key, value] of Object.entries(projectValue.compose_groups ?? {})) {
      groups.push(
        compileGroup(
          project,
          key,
          value,
          discoveries,
          discoveredGroups,
          composeNames,
          entries,
          stopSeconds,
          readinessSeconds,
        ),
      );
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new AppError('INVALID_CONFIG', `Duplicate entry ID ${entry.id}.`);
    }
    seen.add(entry.id);
  }
  const deferred = new Set(
    entries.flatMap((entry) =>
      entry.dependsOn.filter(
        (id) => !seen.has(id) && deferredComposeRef(id, groups, discoveredGroups),
      ),
    ),
  );
  validateGraphs(
    deferred.size === 0
      ? entries
      : entries.map((entry) => ({
          ...entry,
          dependsOn: entry.dependsOn.filter((id) => !deferred.has(id)),
        })),
  );
  return {
    path: absolutePath,
    source,
    raw: Object.fromEntries(Object.entries(parsed)),
    port: parsed.server?.port ?? DEFAULT_PORT,
    logs: {
      perEntryBytes: parsed.logs?.per_entry_bytes ?? DEFAULT_PER_ENTRY,
      totalBytes: parsed.logs?.total_bytes ?? DEFAULT_TOTAL,
    },
    stopSeconds,
    readinessSeconds,
    projects,
    entries,
    groups,
  };
}

export async function readConfigText(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new AppError('CONFIG_NOT_FOUND', `Config not found: ${absolute}`);
    }
    throw error;
  }
}

export async function loadConfig(
  filePath: string,
  discoveries?: Map<string, Record<string, unknown>>,
): Promise<CompiledConfig> {
  const absolute = path.resolve(filePath);
  return compileConfig(await readConfigText(absolute), absolute, discoveries);
}
