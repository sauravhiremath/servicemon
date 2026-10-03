import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './manager.js';

test('serves custom HTML and JSON directly while rejecting private sibling and escaped files', async ({
  page,
  installedCli,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-ui-'));
  const custom = path.join(directory, 'custom');
  await mkdir(custom);
  const configPath = path.join(directory, 'config.yaml');
  const stateDir = path.join(directory, 'state');
  const env = { ...process.env, SERVICEMON_CONFIG: configPath, SERVICEMON_STATE_DIR: stateDir };
  await writeFile(
    path.join(custom, 'panel.html'),
    '<!doctype html><title>Custom panel</title><p>Custom panel text</p><script src="/local.js"></script>',
  );
  await writeFile(
    path.join(custom, 'local.js'),
    'fetch("/data.json").then(r=>r.json()).then(data=>document.body.append(data.message))',
  );
  await writeFile(path.join(custom, 'data.json'), '{"message":"custom-json-marker"}');
  await writeFile(path.join(custom, '.env'), 'PRIVATE=fixture-secret');
  await writeFile(path.join(custom, 'private.yaml'), 'private: fixture-secret');
  await writeFile(path.join(directory, 'outside.json'), '{"private":"fixture-secret"}');
  await symlink(path.join(directory, 'outside.json'), path.join(custom, 'escape.json'));
  await writeFile(configPath, 'version: 1\nprojects: {}\n');
  const child = spawn(
    installedCli,
    ['serve', '--ui', path.join(custom, 'panel.html'), '--port', '0'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(path.join(stateDir, 'instance.json'), 'utf8')).endpoint;
        } catch {
          return '';
        }
      })
      .toMatch(/^http:/);
    const { endpoint } = JSON.parse(await readFile(path.join(stateDir, 'instance.json'), 'utf8'));
    await page.goto(endpoint);
    await expect(page.getByText('Custom panel text')).toBeVisible();
    await expect(page.locator('body')).toContainText('custom-json-marker');
    for (const route of [
      '/.env',
      '/%2eenv',
      '/private.yaml',
      '/escape.json',
      '/%2e%2e%2foutside.json',
    ]) {
      const response = await page.request.get(endpoint + route);
      expect(response.status()).toBe(404);
      expect(await response.text()).not.toContain('fixture-secret');
    }
  } finally {
    child.kill('SIGTERM');
    await exit;
    await rm(directory, { recursive: true, force: true });
  }
});
