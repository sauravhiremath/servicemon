import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileConfig, loadConfig } from '../../src/config/compile.js';
import { AppError } from '../../src/shared/errors.js';

const base = `
version: 1
projects:
  jobs:
    directory: work
    services:
      api:
        command: echo api
        depends_on: [setup, shared/db]
    tasks:
      setup:
        command: echo setup
    compose_groups:
      infra:
        file: infra.yaml
        services:
          postgres:
            notes: database
  shared:
    directory: shared
    services:
      db:
        command: echo db
`;

function code(error: unknown): string {
  if (!(error instanceof AppError)) {
    throw error;
  }
  return error.code;
}

describe('compileConfig', () => {
  it('resolves folders from the config and project and does not expand environment strings', () => {
    const compiled = compileConfig(base, '/tmp/cfg/config.yaml');
    const project = compiled.projects[0]!;
    const api = compiled.entries.find((entry) => entry.id === 'jobs/api')!;
    const group = compiled.groups[0]!;
    expect(project.directory).toBe('/tmp/cfg/work');
    expect(api.directory).toBe('/tmp/cfg/work');
    expect(api.dependsOn).toEqual(['jobs/setup', 'shared/db']);
    expect(group.file).toBe('/tmp/cfg/work/infra.yaml');
    expect(group.projectName).toBe('sm-jobs-infra');
    expect(compiled.entries.some((entry) => entry.id === 'jobs/infra.postgres')).toBe(false);
    const literal = compileConfig(
      'version: 1\nprojects:\n  jobs:\n    directory: $HOME/work\n',
      '/tmp/cfg/config.yaml',
    );
    expect(literal.projects[0]!.directory).toBe('/tmp/cfg/$HOME/work');
    const home = compileConfig(
      'version: 1\nprojects:\n  jobs:\n    directory: ~/work\n',
      '/tmp/cfg/config.yaml',
    );
    expect(home.projects[0]!.directory).not.toBe('/tmp/cfg/~/work');
  });

  it('rejects unknown keys, duplicate keys, invalid names, and shared service-task ids', () => {
    expect(code(catching(() => compileConfig('version: 1\nenv: {}\n', '/tmp/c.yaml')))).toBe(
      'INVALID_CONFIG',
    );
    expect(
      code(
        catching(() => compileConfig('version: 1\nserver:\n  port: 1\n  port: 2\n', '/tmp/c.yaml')),
      ),
    ).toBe('INVALID_CONFIG');
    expect(
      code(
        catching(() =>
          compileConfig('version: 1\nprojects:\n  bad/name:\n    directory: /tmp\n', '/tmp/c.yaml'),
        ),
      ),
    ).toBe('INVALID_CONFIG');
    expect(
      code(
        catching(() =>
          compileConfig(
            'version: 1\nprojects:\n  jobs:\n    directory: /tmp\n    services:\n      api:\n        command: echo\n    tasks:\n      api:\n        command: echo\n',
            '/tmp/c.yaml',
          ),
        ),
      ),
    ).toBe('INVALID_CONFIG');
  });

  it('rejects a process cycle and keeps an undiscovered compose reference', () => {
    expect(
      code(
        catching(() =>
          compileConfig(
            `
version: 1
projects:
  jobs:
    directory: /tmp
    services:
      a:
        command: echo a
        depends_on: [b]
      b:
        command: echo b
        depends_on: [a]
`,
            '/tmp/c.yaml',
          ),
        ),
      ),
    ).toBe('INVALID_CONFIG');
    const deferred = compileConfig(
      `
version: 1
projects:
  jobs:
    directory: /tmp
    services:
      api:
        command: echo api
        depends_on: [infra.postgres]
    compose_groups:
      infra:
        file: infra.yaml
`,
      '/tmp/c.yaml',
    );
    expect(deferred.entries[0]!.dependsOn).toEqual(['jobs/infra.postgres']);
  });

  it('merges discovery, rejects unknown overrides, and rejects duplicate compose project names', () => {
    const discoveries = new Map<string, Record<string, unknown>>([
      ['jobs/infra', { services: { postgres: { image: 'postgres' }, logto: {} } }],
    ]);
    const compiled = compileConfig(
      `
version: 1
projects:
  jobs:
    directory: /tmp/jobs
    compose_groups:
      infra:
        file: infra.yaml
        autostart: true
        services:
          postgres:
            autostart: false
            notes: db
`,
      '/tmp/c.yaml',
      discoveries,
    );
    const postgres = compiled.entries.find((entry) => entry.id === 'jobs/infra.postgres')!;
    const logto = compiled.entries.find((entry) => entry.id === 'jobs/infra.logto')!;
    expect(postgres.autostart).toBe(false);
    expect(postgres.notes).toBe('db');
    expect(logto.autostart).toBe(true);
    expect(postgres.execution).toMatchObject({
      kind: 'compose',
      service: 'postgres',
      projectName: 'sm-jobs-infra',
    });
    expect(
      code(
        catching(() =>
          compileConfig(
            `
version: 1
projects:
  jobs:
    directory: /tmp
    compose_groups:
      infra:
        file: infra.yaml
        services:
          missing:
            notes: no
`,
            '/tmp/c.yaml',
            discoveries,
          ),
        ),
      ),
    ).toBe('INVALID_CONFIG');
    expect(
      code(
        catching(() =>
          compileConfig(
            `
version: 1
projects:
  jobs:
    directory: /tmp
    compose_groups:
      one:
        file: a.yaml
        project_name: same-name
      two:
        file: b.yaml
        project_name: same-name
`,
            '/tmp/c.yaml',
          ),
        ),
      ),
    ).toBe('INVALID_CONFIG');
  });

  it('reports a missing config file without reading a default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-load-'));
    await expect(loadConfig(path.join(root, 'missing.yaml'))).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    });
    await writeFile(path.join(root, 'config.yaml'), 'version: 1\n');
    await expect(loadConfig(path.join(root, 'config.yaml'))).resolves.toMatchObject({
      port: 7331,
      entries: [],
    });
  });
});

function catching(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}
