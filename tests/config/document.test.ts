import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileConfig } from '../../src/config/compile.js';
import { editConfig, proposeEdit } from '../../src/config/document.js';
import { AppError } from '../../src/shared/errors.js';

const exec = promisify(execFile);
const commented = `version: 1
# keep-project
projects:
  jobs:
    directory: /tmp/jobs
    services:
      api:
        command: echo api # keep-api
`;

describe('config edits', () => {
  it('creates the first project in a version-only config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-first-project-'));
    const file = path.join(root, 'config.yaml');
    await writeFile(file, 'version: 1\n');
    const compiled = await editConfig(file, {
      kind: 'project',
      action: 'add',
      key: 'demo',
      fields: { directory: '/tmp/demo', name: 'Demo' },
    });
    expect(compiled.projects).toEqual([{ id: 'demo', name: 'Demo', directory: '/tmp/demo' }]);
  });

  it.each(['service', 'task', 'compose'] as const)(
    'adds the first %s to an empty project',
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), 'servicemon-first-entry-'));
      const file = path.join(root, 'config.yaml');
      await writeFile(file, 'version: 1\nprojects:\n  demo:\n    directory: /tmp/demo\n');
      const compiled = await editConfig(file, {
        kind,
        action: 'add',
        projectId: 'demo',
        key: 'first',
        fields: kind === 'compose' ? { file: 'compose.yaml' } : { command: 'printf first' },
      });
      if (kind === 'compose') {
        expect(compiled.groups.map((group) => ({ id: group.id, file: group.file }))).toEqual([
          { id: 'demo/first', file: '/tmp/demo/compose.yaml' },
        ]);
      } else {
        expect(
          compiled.entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            command: entry.command,
          })),
        ).toEqual([{ id: 'demo/first', kind, command: 'printf first' }]);
      }
    },
  );

  it('adds and removes an entry without dropping unrelated comments or settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-edit-'));
    const file = path.join(root, 'config.yaml');
    await writeFile(file, commented);
    const added = await editConfig(file, {
      kind: 'service',
      action: 'add',
      projectId: 'jobs',
      key: 'ui',
      fields: { command: 'echo ui', directory: '/tmp/ui' },
    });
    const afterAdd = await readFile(file, 'utf8');
    expect(afterAdd).toContain('# keep-project');
    expect(afterAdd).toContain('echo api # keep-api');
    expect(afterAdd).toContain('echo ui');
    expect(added.entries.map((entry) => entry.id).sort()).toEqual(['jobs/api', 'jobs/ui']);
    await editConfig(file, { kind: 'service', action: 'remove', projectId: 'jobs', key: 'ui' });
    const afterRemove = await readFile(file, 'utf8');
    expect(afterRemove).toContain('# keep-project');
    expect(afterRemove).toContain('echo api # keep-api');
    expect(afterRemove).not.toContain('echo ui');
    expect((await readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('refuses a referenced removal and a stale replacement without changing the file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-stale-'));
    const file = path.join(root, 'config.yaml');
    const source = `${commented}        depends_on: [api]\n`;
    const linked = source.replace(
      'command: echo api # keep-api',
      'command: echo setup\n      api:\n        command: echo api # keep-api\n        depends_on: [setup]',
    );
    await writeFile(
      file,
      `version: 1
projects:
  jobs:
    directory: /tmp/jobs
    tasks:
      setup:
        command: echo setup
    services:
      api:
        command: echo api
        depends_on: [setup]
`,
    );
    await expect(
      editConfig(file, { kind: 'task', action: 'remove', projectId: 'jobs', key: 'setup' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await readFile(file, 'utf8')).toContain('echo setup');
    const external = 'version: 1\n# external edit\n';
    await expect(
      editConfig(
        file,
        {
          kind: 'service',
          action: 'add',
          projectId: 'jobs',
          key: 'ui',
          fields: { command: 'echo ui' },
        },
        async () => {
          await writeFile(file, external);
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_CONFIG' });
    expect(await readFile(file, 'utf8')).toBe(external);
    expect(linked).toContain('depends_on');
  });

  it('does not write an invalid add and does not steal a live config lock', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-lock-'));
    const file = path.join(root, 'config.yaml');
    await writeFile(file, commented);
    await expect(
      editConfig(file, {
        kind: 'service',
        action: 'add',
        projectId: 'jobs',
        key: 'ui',
        fields: { env: 'no', command: 'echo ui' },
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await readFile(file, 'utf8')).toBe(commented);
    const { stdout } = await exec('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']);
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: stdout.trim(), token: 'held' }),
    );
    await expect(
      editConfig(file, {
        kind: 'service',
        action: 'add',
        projectId: 'jobs',
        key: 'ui',
        fields: { command: 'echo ui' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_BUSY' });
    expect(await readFile(file, 'utf8')).toBe(commented);
    expect(
      proposeEdit(commented, {
        kind: 'service',
        action: 'add',
        projectId: 'jobs',
        key: 'ui',
        fields: { command: 'echo ui' },
      }),
    ).toContain('echo api # keep-api');
  });

  it('does not take a lock that is still empty and does replace an abandoned one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-empty-lock-'));
    const file = path.join(root, 'config.yaml');
    await writeFile(file, commented);
    await writeFile(`${file}.lock`, '');
    await expect(
      editConfig(file, {
        kind: 'service',
        action: 'add',
        projectId: 'jobs',
        key: 'ui',
        fields: { command: 'echo ui' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_BUSY' });
    expect(await readFile(file, 'utf8')).toBe(commented);
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('');
    const old = new Date(Date.now() - 10_000);
    await utimes(`${file}.lock`, old, old);
    await editConfig(file, {
      kind: 'service',
      action: 'add',
      projectId: 'jobs',
      key: 'ui',
      fields: { command: 'echo ui' },
    });
    expect(await readFile(file, 'utf8')).toContain('echo ui');
  });

  it('returns the validator config so discovered entries are not dropped', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-validated-'));
    const file = path.join(root, 'config.yaml');
    await writeFile(file, 'version: 1\nprojects:\n  demo:\n    directory: /tmp/demo\n');
    const result = await editConfig(
      file,
      {
        kind: 'service',
        action: 'add',
        projectId: 'demo',
        key: 'api',
        fields: { command: 'echo api' },
      },
      async (proposed) => {
        const compiled = compileConfig(proposed, file);
        const service = compiled.entries[0]!;
        return {
          ...compiled,
          entries: [
            ...compiled.entries,
            { ...service, id: 'demo/infra.db', key: 'infra.db', kind: 'compose' },
          ],
        };
      },
    );
    expect(result.entries.map((entry) => entry.id)).toEqual(['demo/api', 'demo/infra.db']);
  });
});
