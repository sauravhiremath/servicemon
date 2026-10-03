import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { expect, it } from 'vitest';
import { addDefinitionCommands } from '../../src/cli/definitions.js';
import { loadCandidate } from '../../src/config/reload.js';
import { exitCode } from '../../src/shared/errors.js';

it('reports a missing config as config-not-found for validate and startup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-missing-'));
  const missing = path.join(directory, 'missing.yaml');
  const program = new Command().name('servicemon').option('--config <path>').exitOverride();
  program.configureOutput({ writeErr() {}, writeOut() {} });
  addDefinitionCommands(program);
  const validate = await program.parseAsync(['config', 'validate', '--config', missing], { from: 'user' }).then(() => undefined, (error: unknown) => error);
  if (!validate || typeof validate !== 'object' || !('code' in validate) || validate.code !== 'CONFIG_NOT_FOUND') throw validate;
  expect(exitCode(validate.code)).toBe(2);
  await expect(loadCandidate(missing)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
});
