import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const script = path.resolve('scripts/release-notes.mjs');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'servicemon-release-notes-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'release@example.test');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      version: '1.1.0',
      repository: { url: 'https://github.com/example/servicemon.git' },
    }),
  );
  git('add', 'package.json');
  git('commit', '-m', 'feat: initial manager');
  return {
    root,
    git,
    notes: async () => {
      const commit = git('rev-parse', 'HEAD');
      const manifest = path.join(root, 'manifest.json');
      await writeFile(manifest, JSON.stringify({ version: '1.1.0', commit }));
      execFileSync(process.execPath, [script, '--manifest', manifest], { cwd: root, env });
      return readFile(path.join(root, 'release-notes.md'), 'utf8');
    },
  };
}

it('includes the complete first-release history and preserves literal commit subjects', async () => {
  const { root, git, notes } = await fixture();
  try {
    git('commit', '--allow-empty', '-m', 'fix: display [task] <state>');
    const commit = git('rev-parse', 'HEAD');
    const result = await notes();
    expect(result).toContain('feat: initial manager');
    expect(result).toContain('fix: display \\[task\\] \\<state\\>');
    expect(result).toContain(`https://github.com/example/servicemon/commit/${commit}`);
    expect(result).toContain(`https://github.com/example/servicemon/commits/${commit}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('excludes earlier releases and unreachable tags without treating the current tag as the baseline', async () => {
  const { root, git, notes } = await fixture();
  try {
    git('tag', 'v1.0.0');
    git('checkout', '-b', 'unreleased');
    git('commit', '--allow-empty', '-m', 'feat: unrelated branch');
    git('tag', 'v9.0.0');
    git('checkout', 'main');
    git('commit', '--allow-empty', '-m', 'fix: retain service logs');
    git('tag', 'v1.1.0');
    const commit = git('rev-parse', 'HEAD');
    const result = await notes();
    expect(result).toContain('fix: retain service logs');
    expect(result).not.toContain('feat: initial manager');
    expect(result).not.toContain('feat: unrelated branch');
    expect(result).toContain(`https://github.com/example/servicemon/compare/v1.0.0...${commit}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
