import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ownStartedAt, processIdentity } from '../config/process-identity.js';
import { applicationProtocol, packageVersion } from '../shared/build-info.js';
import { AppError } from '../shared/errors.js';
import type { InstanceMetadata } from '../shared/types.js';
import { environmentCaptureSelectors } from './environment.js';

const lockSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  token: z.string(),
  configPath: z.string(),
});
const environmentCaptureSchema = z
  .strictObject({
    loginShell: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((value) => value.loginShell !== undefined || value.timeoutMs !== undefined);
const metadataSchema: z.ZodType<InstanceMetadata> = z.strictObject({
  version: z.string().min(1),
  applicationProtocol: z.number().int().positive(),
  launchSettings: z.strictObject({
    ui: z.union([z.string().refine((value) => path.isAbsolute(value)), z.null()]),
    port: z.number().int().min(0).max(65535),
    environmentCapture: environmentCaptureSchema.optional(),
  }),
});
const instanceSchema = z.object({
  configPath: z.string(),
  endpoint: z.string(),
  pid: z.number(),
  startedAt: z.string(),
  token: z.string(),
  metadata: metadataSchema,
});

export type InstanceRecord = z.infer<typeof instanceSchema>;

export interface InstanceLock {
  record: InstanceRecord;
  owned: boolean;
  release(): Promise<void>;
}

function lockPath(stateDir: string): string {
  return path.join(stateDir, 'manager.lock');
}

function instancePath(stateDir: string): string {
  return path.join(stateDir, 'instance.json');
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function readInstance(stateDir: string): Promise<InstanceRecord | undefined> {
  const value = await readJson(instancePath(stateDir));
  if (value === undefined) {
    return undefined;
  }
  const parsed = instanceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('OWNERSHIP_CONFLICT', 'Manager instance record is unreadable.');
  }
  return parsed.data;
}

async function writePrivate(filePath: string, body: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  await writeFile(temporary, body, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export async function writeInstance(stateDir: string, record: InstanceRecord): Promise<void> {
  const current = lockSchema.safeParse(await readJson(lockPath(stateDir)));
  if (
    !current.success ||
    current.data.token !== record.token ||
    current.data.pid !== process.pid ||
    current.data.startedAt !== record.startedAt ||
    path.resolve(current.data.configPath) !== path.resolve(record.configPath)
  ) {
    throw new AppError(
      'OWNERSHIP_CONFLICT',
      'Refusing to replace a manager instance this process does not own.',
    );
  }
  await writePrivate(instancePath(stateDir), `${JSON.stringify(record)}\n`);
}
async function releaseOwned(stateDir: string, token: string): Promise<void> {
  const current = lockSchema.safeParse(await readJson(lockPath(stateDir)).catch(() => undefined));
  if (!current.success || current.data.token !== token) {
    return;
  }
  const record = instanceSchema.safeParse(
    await readJson(instancePath(stateDir)).catch(() => undefined),
  );
  if (record.success && record.data.token === token) {
    await rm(instancePath(stateDir), { force: true });
  }
  await rm(lockPath(stateDir), { force: true });
}

export async function acquireInstance(
  stateDir: string,
  configPath: string,
  metadata: InstanceMetadata = currentMetadata(),
): Promise<InstanceLock> {
  const absoluteConfig = path.resolve(configPath);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const startedAt = await ownStartedAt();
  const file = lockPath(stateDir);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, 'wx', 0o600);
      const token = randomBytes(16).toString('hex');
      const record: InstanceRecord = {
        configPath: absoluteConfig,
        endpoint: '',
        pid: process.pid,
        startedAt,
        token,
        metadata,
      };
      try {
        await handle.writeFile(
          JSON.stringify({ pid: record.pid, startedAt, token, configPath: absoluteConfig }),
        );
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      await chmod(file, 0o600);
      await writePrivate(instancePath(stateDir), `${JSON.stringify(record)}\n`);
      return { record, owned: true, release: () => releaseOwned(stateDir, token) };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
      const current = lockSchema.safeParse(await readJson(file).catch(() => undefined));
      if (!current.success) {
        const info = await stat(file).catch(() => undefined);
        if (!info || Date.now() - info.mtimeMs > 5000) {
          await rm(file, { force: true });
        }
        await delay(50);
        continue;
      }
      const identity = await processIdentity(current.data.pid);
      if (identity.state === 'uncertain') {
        throw new AppError(
          'OWNERSHIP_CONFLICT',
          'Manager lock owner is uncertain. No process was signalled.',
        );
      }
      if (identity.state === 'dead' || identity.startedAt !== current.data.startedAt) {
        await rm(file, { force: true });
        continue;
      }
      if (path.resolve(current.data.configPath) !== absoluteConfig) {
        throw new AppError(
          'MANAGER_CONFLICT',
          `Manager already running for ${current.data.configPath}.`,
          { configPath: current.data.configPath, pid: current.data.pid },
        );
      }
      const stored = instanceSchema.safeParse(
        await readJson(instancePath(stateDir)).catch(() => undefined),
      );
      if (!stored.success || stored.data.token !== current.data.token || !stored.data.endpoint) {
        await delay(50);
        continue;
      }
      return { record: stored.data, owned: false, release: async () => {} };
    }
  }
  throw new AppError('MANAGER_CONFLICT', 'Could not acquire the manager lock.');
}
export async function readLock(
  stateDir: string,
): Promise<{ pid: number; startedAt: string; configPath: string } | undefined> {
  const value = await readJson(lockPath(stateDir));
  if (value === undefined) {
    return undefined;
  }
  const parsed = lockSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Manager lock is unreadable. No replacement was launched.',
    );
  }
  return {
    pid: parsed.data.pid,
    startedAt: parsed.data.startedAt,
    configPath: parsed.data.configPath,
  };
}
function currentMetadata(): InstanceMetadata {
  const environmentCapture = environmentCaptureSelectors();
  return {
    version: packageVersion,
    applicationProtocol,
    launchSettings: {
      ui: null,
      port: 0,
      ...(environmentCapture ? { environmentCapture } : {}),
    },
  };
}
