import { expect, it } from 'vitest';
import { request } from 'node:http';
import { fixtureManager, persistentCommand } from '../helpers/runtime.js';

it('serves the dashboard and controls tasks and config without authentication', async () => {
  const manager = await fixtureManager({ app: { tasks: { probe: { command: 'echo task-marker' } } } });
  try {
    const page = await fetch(manager.endpoint);
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie')).toBeNull();
    const html = await page.text();
    const asset = html.match(/src="([^"]+\.js)"/)![1];
    expect((await fetch(new URL(asset, manager.endpoint))).status).toBe(200);
    expect((await manager.operation('/api/entries/app%2Fprobe/run')).state).toBe('succeeded');
    const logs = await fetch(manager.endpoint + '/api/entries/app%2Fprobe/logs');
    expect(logs.status).toBe(200);
    expect(await logs.text()).toContain('task-marker');
    expect((await manager.operation('/api/config/edit', { kind: 'task', action: 'add', projectId: 'app', key: 'added', fields: { command: 'true' } })).state).toBe('succeeded');
    expect((await manager.snapshot()).entries.map(entry => entry.id)).toContain('app/added');
  } finally { await manager.close(); }
});

it('rejects foreign Host and Origin headers and mutations without Origin', async () => {
  const manager = await fixtureManager({ app: { services: { api: { command: persistentCommand } } } });
  try {
    const action = '/api/entries/app%2Fapi/start';
    for (const origin of [undefined, 'null', 'https://foreign.example']) {
      const response = await fetch(manager.endpoint + action, { method: 'POST', headers: { ...(origin === undefined ? {} : { Origin: origin }), 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(403);
    }
    expect((await fetch(manager.endpoint + '/api/status', { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(manager.endpoint + '/api/status', { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.once('error', reject); req.end();
    });
    expect(invalidHost).toBe(403);
    expect((await manager.snapshot()).entries[0].state).toBe('stopped');
    expect((await manager.operation(action)).state).toBe('succeeded');
    expect((await manager.snapshot()).entries[0].state).toBe('running');
  } finally { await manager.close(); }
});

it('rejects malformed control JSON instead of reporting an internal error', async () => {
  const manager = await fixtureManager({ app: { tasks: { probe: { command: 'true' } } } });
  try {
    const headers = { Origin: manager.endpoint, 'Content-Type': 'application/json' };
    for (const [route, body] of [['/api/projects/app/actions', '{'], ['/api/projects/app/actions', 'null'], ['/api/config/edit', '{']] as const) {
      const response = await fetch(manager.endpoint + route, { method: 'POST', headers, body });
      expect(response.status).toBe(400);
      const payload = await response.json() as { ok: boolean; error: { code: string } };
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('INVALID_INPUT');
    }
  } finally { await manager.close(); }
});
