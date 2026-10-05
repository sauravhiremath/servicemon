import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function cli(args: string[]) {
  return spawnSync(process.execPath, ['dist/cli/main.js', ...args], { encoding: 'utf8' });
}

it.each([[], ['manager'], ['config']])('shows help for an incomplete command: %j', (...args) => {
  const result = cli(args);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`Usage: servicemon${args.length ? ' ' + args.join(' ') : ''}`);
  expect(result.stderr).toContain('Commands:');
  expect(result.stderr).not.toContain('INVALID_INPUT');
  expect(result.stderr).not.toContain('(outputHelp)');
});

it.each([['--help'], ['manager', '--help'], ['help', 'config']])(
  'shows explicitly requested help successfully: %j',
  (...args) => {
    const result = cli(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: servicemon');
    expect(result.stdout).toContain('Commands:');
    expect(result.stderr).toBe('');
  },
);

it('keeps real input errors separate from help and preserves JSON output', () => {
  const human = cli(['manager', '--unknown-option']);
  expect(human.status).toBe(2);
  expect(human.stdout).toBe('');
  expect(human.stderr).toMatch(/^INVALID_INPUT:.*--unknown-option/m);
  expect(human.stderr).not.toContain('Usage:');

  const json = cli(['service', 'remove', '--json']);
  expect(json.status).toBe(2);
  expect(json.stderr).toBe('');
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    data: null,
    error: { code: 'INVALID_INPUT' },
  });
});
