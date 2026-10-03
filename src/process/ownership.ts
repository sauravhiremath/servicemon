import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunIdentity {
  entryId: string;
  runId: string;
  pid: number;
  pgid: number;
  startedAt: string | null;
  command: string;
  cwd: string;
  kind: 'service' | 'task';
  live: boolean;
}

export type IdentityState = 'alive' | 'dead' | 'uncertain';

export function identityPath(stateDir: string, entryId: string): string {
  return join(stateDir, 'runs', `${encodeURIComponent(entryId)}.json`);
}

export function readIdentity(stateDir: string, entryId: string): RunIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(identityPath(stateDir, entryId), 'utf8')) as Partial<RunIdentity>;
    if (typeof parsed.pid !== 'number' || typeof parsed.pgid !== 'number' || typeof parsed.runId !== 'string') return null;
    return {
      entryId: parsed.entryId ?? entryId,
      runId: parsed.runId,
      pid: parsed.pid,
      pgid: parsed.pgid,
      startedAt: parsed.startedAt ?? null,
      command: parsed.command ?? '',
      cwd: parsed.cwd ?? '',
      kind: parsed.kind === 'task' ? 'task' : 'service',
      live: parsed.live === true,
    };
  } catch {
    return null;
  }
}

export function writeIdentity(stateDir: string, identity: RunIdentity): void {
  const path = identityPath(stateDir, identity.entryId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
  renameSync(temporary, path);
}

export function cleanEnv(environment: NodeJS.ProcessEnv, runId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (runId) env.SERVICEMON_RUN_ID = runId;
  return env;
}

export async function captureStart(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: psEnv() });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

interface GroupMember {
  pid: number;
  pgid: number;
  startedAt: string;
}

export async function listGroup(pgid: number): Promise<GroupMember[] | null> {
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-g', String(pgid), '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', env: psEnv() });
    return parseGroup(stdout);
  } catch (error) {
    const stdout = textOf(error, 'stdout');
    const stderr = textOf(error, 'stderr');
    if (!stdout.trim() && !stderr.trim()) return [];
    return null;
  }
}

export async function inspectIdentity(identity: RunIdentity): Promise<IdentityState> {
  if (!identity.live) return 'dead';
  const members = await listGroup(identity.pgid);
  if (members === null) return 'uncertain';
  if (members.length === 0) return 'dead';
  const leader = members.find((member) => member.pid === identity.pid);
  if (leader) {
    if (!identity.startedAt) return 'uncertain';
    return leader.startedAt === identity.startedAt ? 'alive' : 'dead';
  }
  const reused = members.find((member) => member.pid === identity.pgid);
  if (reused && identity.startedAt && reused.startedAt !== identity.startedAt) return 'dead';
  return 'alive';
}

export function signalAttached(pid: number, signal: NodeJS.Signals): 'signaled' | 'gone' {
  if (!Number.isInteger(pid) || pid <= 1) return 'gone';
  try {
    process.kill(-pid, signal);
    return 'signaled';
  } catch (error) {
    if (codeOf(error) === 'ESRCH') return 'gone';
    throw error;
  }
}

export async function signalOwnedGroup(identity: RunIdentity, signal: NodeJS.Signals): Promise<'signaled' | 'gone' | 'uncertain'> {
  const state = await inspectIdentity({ ...identity, live: true });
  if (state === 'dead') return 'gone';
  if (state === 'uncertain') return 'uncertain';
  try {
    process.kill(-identity.pgid, signal);
    return 'signaled';
  } catch (error) {
    if (codeOf(error) === 'ESRCH') return 'gone';
    if (codeOf(error) === 'EPERM') return 'uncertain';
    throw error;
  }
}

export async function waitUntilGone(identity: RunIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const state = await inspectIdentity({ ...identity, live: true });
    if (state === 'dead') return true;
    if (state === 'uncertain') return false;
    if (Date.now() >= deadline) return false;
    await delay(40);
  } while (Date.now() < deadline);
  return (await inspectIdentity({ ...identity, live: true })) === 'dead';
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C' };
}

function parseGroup(stdout: string): GroupMember[] {
  const members: GroupMember[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    members.push({ pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3].trim() });
  }
  return members;
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function textOf(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object' || !(key in error)) return '';
  const value = (error as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  return value instanceof Buffer ? value.toString('utf8') : '';
}
