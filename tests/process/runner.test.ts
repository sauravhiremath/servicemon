import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogStore } from '../../src/logs/store.js';
import { captureStart, identityPath, writeIdentity } from '../../src/process/ownership.js';
import { ProcessAdapter } from '../../src/process/runner.js';
import type { Entry } from '../../src/shared/types.js';

const directories: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* The group is already gone. */
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('owned processes', () => {
  it('runs in the entry folder with the supplied environment and retains both streams', async () => {
    const directory = await tempDir();
    const work = join(directory, 'work');
    await mkdir(work, { recursive: true });
    const marker = join(directory, 'marker');
    const { adapter, logs } = open(directory, [
      service(
        work,
        `node -e 'require("fs").writeFileSync(process.env.OUT, process.cwd()+"\\n"+process.env.FOO); process.stdout.write("out\\n"); process.stderr.write("err\\n")'`,
        { stopSeconds: 2 },
      ),
    ]);
    await adapter.start(
      service(
        work,
        `node -e 'require("fs").writeFileSync(process.env.OUT, process.cwd()+"\\n"+process.env.FOO); process.stdout.write("out\\n"); process.stderr.write("err\\n")'`,
      ),
      { ...process.env, OUT: marker, FOO: 'from-snapshot' },
    );
    await waitFor(() => adapter.status('proj/api').state === 'exited');
    expect(await readFile(marker, 'utf8')).toBe(`${await realpath(work)}\nfrom-snapshot`);
    logs.close();
    const reopened = new LogStore(directory, { perEntryBytes: 1_000_000, totalBytes: 1_000_000 });
    const history = reopened.history('proj/api');
    expect(
      history.records.some((record) => record.stream === 'stdout' && record.text.includes('out')),
    ).toBe(true);
    expect(
      history.records.some((record) => record.stream === 'stderr' && record.text.includes('err')),
    ).toBe(true);
    expect(history.records.some((record) => record.stream === 'boundary')).toBe(true);
    expect(history.records.some((record) => record.text.includes('from-snapshot'))).toBe(false);
    reopened.close();
    await adapter.shutdown();
  });

  it('stops the owned group when the shell exits before its children', async () => {
    const directory = await tempDir();
    const pidfile = join(directory, 'child.pid');
    const entry = service(directory, `sleep 30 & echo $! > "$PIDFILE"; exit 0`, { stopSeconds: 2 });
    const { adapter } = open(directory, [entry]);
    await adapter.start(entry, { ...process.env, PIDFILE: pidfile });
    const shell = adapter.status(entry.id).pid!;
    groups.push(shell);
    await waitFor(async () => !alive(shell) && alive(Number(await readFile(pidfile, 'utf8'))));
    expect(adapter.status(entry.id).state).toBe('running');
    const child = Number(await readFile(pidfile, 'utf8'));
    await adapter.stop(entry);
    await waitFor(() => !alive(child) && !alive(shell));
    expect(adapter.status(entry.id).state).toBe('stopped');
    expect(alive(child)).toBe(false);
  });

  it('kills a group that ignores SIGTERM and does not restart an unexpected exit', async () => {
    const directory = await tempDir();
    const stubborn = service(
      directory,
      `node -e 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},500)'`,
      { stopSeconds: 1 },
    );
    const { adapter, logs } = open(directory, [stubborn]);
    await adapter.start(stubborn, process.env);
    const pid = adapter.status(stubborn.id).pid!;
    groups.push(pid);
    await waitFor(() =>
      logs.history(stubborn.id).records.some((record) => record.text.includes('ready')),
    );
    const started = Date.now();
    await adapter.stop(stubborn);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(alive(pid)).toBe(false);
    expect(adapter.status(stubborn.id).state).toBe('stopped');

    const exiting = service(directory, 'exit 3');
    adapter.update([exiting]);
    await adapter.start(exiting, process.env);
    await waitFor(() => adapter.status(exiting.id).state === 'exited');
    const status = adapter.status(exiting.id);
    await delay(200);
    expect(adapter.status(exiting.id)).toMatchObject({
      state: 'exited',
      pid: status.pid,
      exit: { code: 3 },
    });
    await adapter.shutdown();
  });

  it('ignores a stale exit after a later run starts', async () => {
    const directory = await tempDir();
    const task = command(directory, 'exit 0', 'task');
    const { adapter } = open(directory, [task]);
    await adapter.start(task, process.env);
    const first = await adapter.waitTask(task.id);
    expect(first.state).toBe('succeeded');
    adapter.update([command(directory, 'exit 1', 'task')]);
    await adapter.start(command(directory, 'exit 1', 'task'), process.env);
    const second = await adapter.waitTask(task.id);
    expect(second.state).toBe('failed');
    expect(second.exit?.code).toBe(1);
    expect(second.runId).not.toBe(first.runId);
    await delay(100);
    expect(adapter.status(task.id).state).toBe('failed');
    await adapter.shutdown();
  });

  it('reports a live previous run without signaling it and blocks a duplicate start', async () => {
    const directory = await tempDir();
    const entry = service(directory, 'sleep 30');
    const first = open(directory, [entry]);
    await first.adapter.start(entry, process.env);
    const pid = first.adapter.status(entry.id).pid!;
    groups.push(pid);
    const second = open(directory, [entry]);
    await second.adapter.recover();
    const status = second.adapter.status(entry.id);
    expect(status.error).toContain('Ownership conflict');
    expect(status.pid).toBe(pid);
    expect(status.runId).toBe(first.adapter.status(entry.id).runId);
    await expect(second.adapter.start(entry, process.env)).rejects.toMatchObject({
      code: 'OWNERSHIP_CONFLICT',
    });
    await expect(second.adapter.stop(entry)).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });
    expect(alive(pid)).toBe(true);
    await first.adapter.stop(entry);
    expect(alive(pid)).toBe(false);
    first.logs.close();
    second.logs.close();
  });

  it('does not signal a reused PID and does not stop an unrelated process', async () => {
    const directory = await tempDir();
    const external = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    groups.push(external.pid!);
    external.unref();
    const startedAt = await captureStart(external.pid!);
    writeIdentity(directory, {
      entryId: 'proj/api',
      runId: 'old-run',
      pid: external.pid!,
      pgid: external.pid!,
      startedAt: 'Thu Jan  1 00:00:00 1970',
      command: 'sleep 30',
      cwd: directory,
      kind: 'service',
      live: true,
    });
    const entry = service(directory, 'sleep 5');
    const { adapter, logs } = open(directory, [entry]);
    await adapter.recover();
    expect(adapter.status(entry.id).error).toBeUndefined();
    await adapter.start(entry, process.env);
    groups.push(adapter.status(entry.id).pid!);
    expect(alive(external.pid!)).toBe(true);
    await adapter.shutdown();
    expect(alive(external.pid!)).toBe(true);
    expect(startedAt).toBeTruthy();
    const mode = (await stat(identityPath(directory, entry.id))).mode & 0o777;
    expect(mode).toBe(0o600);
    logs.close();
  });

  it('emits bounded no-newline output and shuts down every owned group', async () => {
    const directory = await tempDir();
    const noisy = service(
      directory,
      `node -e 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'`,
    );
    const other = { ...service(directory, 'sleep 30'), id: 'proj/other', key: 'other' };
    const { adapter, logs } = open(directory, [noisy, other]);
    await adapter.start(noisy, process.env);
    await adapter.start(other, process.env);
    groups.push(adapter.status(noisy.id).pid!, adapter.status(other.id).pid!);
    await waitFor(
      () =>
        logs
          .history(noisy.id)
          .records.filter((record) => record.stream === 'stdout')
          .reduce((sum, record) => sum + record.text.length, 0) === 100000,
    );
    const records = logs.history(noisy.id).records.filter((record) => record.stream === 'stdout');
    expect(records.every((record) => Buffer.byteLength(record.text) <= 16 * 1024)).toBe(true);
    const owned = [adapter.status(noisy.id).pid!, adapter.status(other.id).pid!];
    await adapter.shutdown();
    expect(owned.every((pid) => !alive(pid))).toBe(true);
    logs.close();
  });

  it('stops a task without recording success', async () => {
    const directory = await tempDir();
    const task = command(directory, 'sleep 30', 'task');
    const { adapter, logs } = open(directory, [task]);
    await adapter.start(task, process.env);
    groups.push(adapter.status(task.id).pid!);
    const pending = adapter.waitTask(task.id);
    await adapter.stop(task);
    await expect(pending).resolves.toMatchObject({ state: 'stopped' });
    expect(adapter.status(task.id).state).not.toBe('succeeded');
    logs.close();
  });
});

function open(directory: string, entries: Entry[]) {
  const logs = new LogStore(directory, { perEntryBytes: 1_000_000, totalBytes: 4_000_000 });
  return {
    logs,
    adapter: new ProcessAdapter(entries, process.env, logs, directory, () => undefined),
  };
}

function service(directory: string, command: string, extra: Partial<Entry> = {}): Entry {
  return commandEntry(directory, command, 'service', extra);
}

function command(directory: string, text: string, kind: Entry['kind']): Entry {
  return commandEntry(directory, text, kind);
}

function commandEntry(
  directory: string,
  command: string,
  kind: Entry['kind'],
  extra: Partial<Entry> = {},
): Entry {
  return {
    id: 'proj/api',
    projectId: 'proj',
    key: 'api',
    name: 'API',
    kind,
    directory,
    command,
    links: [],
    dependsOn: [],
    autostart: false,
    restartDependencies: false,
    restartDependents: false,
    stopSeconds: 2,
    readinessSeconds: 5,
    ...extra,
  };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'servicemon-process-'));
  directories.push(directory);
  return directory;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(30);
  }
  throw new Error('Condition was not met.');
}
