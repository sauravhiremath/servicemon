import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Operations } from '../manager/operations.js';
import { errorData, AppError } from '../shared/errors.js';
import type {
  Action,
  LogHistory,
  Operation,
  RuntimeEvent,
  Snapshot,
  Target,
} from '../shared/types.js';
import { assetRoot, readAsset } from './assets.js';
import type { EventHub } from './events.js';

export interface ControlServerOptions {
  operations: Operations;
  history: (id: string, query: { after?: number; tail?: number }) => Promise<LogHistory>;
  events: EventHub;
  port: number;
  ui?: string;
  reload: () => Operation;
  edit: (edit: unknown) => Operation;
  shutdown: () => Promise<void>;
  reloadError: () => Snapshot['reloadError'];
}
export interface ControlServer {
  server: Server;
  endpoint: string;
  close: () => Promise<void>;
}
export async function startServer(options: ControlServerOptions): Promise<ControlServer> {
  const assets = await assetRoot(options.ui);
  const app = new Hono();
  let endpoint = '';
  const snapshot = (): Snapshot => ({
    projects: options.operations.config.projects,
    entries: options.operations.config.entries.map((entry) => options.operations.status(entry)),
    groups: options.operations.config.groups,
    operations: [...options.operations.records.values()],
    configPath: options.operations.config.path,
    reloadError: options.reloadError(),
    cursor: options.events.cursor,
  });
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!endpoint || host !== new URL(endpoint).host) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: 'ACCESS_DENIED', message: 'Invalid Host header.' },
        },
        403,
      );
    }
    const origin = c.req.header('origin');
    if (origin && origin !== endpoint) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: 'ACCESS_DENIED', message: 'Foreign Origin is not allowed.' },
        },
        403,
      );
    }
    if (!['GET', 'HEAD'].includes(c.req.method) && origin !== endpoint) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: 'ACCESS_DENIED', message: 'A matching Origin header is required.' },
        },
        403,
      );
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, c) => {
    const data = errorData(error);
    return c.json(
      { ok: false, data: null, error: data },
      data.code === 'OPERATION_BUSY'
        ? 409
        : data.code === 'INVALID_INPUT' || data.code === 'INVALID_TARGET'
          ? 400
          : 500,
    );
  });
  app.get('/api/status', (c) => c.json({ ok: true, data: snapshot(), error: null }));
  app.get('/api/projects', (c) =>
    c.json({ ok: true, data: options.operations.config.projects, error: null }),
  );
  app.get('/api/entries', (c) => c.json({ ok: true, data: snapshot().entries, error: null }));
  app.get('/api/config/path', (c) =>
    c.json({ ok: true, data: { path: options.operations.config.path }, error: null }),
  );
  app.post('/api/config/reload', (c) =>
    c.json({ ok: true, data: { operationId: options.reload().id }, error: null }, 202),
  );
  app.post('/api/config/edit', async (c) => {
    let edit: unknown;
    try {
      edit = await c.req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'Config edit must be JSON.');
    }
    return c.json({ ok: true, data: { operationId: options.edit(edit).id }, error: null }, 202);
  });
  app.post('/api/entries/:id/:action', (c) => {
    const action = c.req.param('action');
    if (!['start', 'stop', 'restart', 'run'].includes(action)) {
      throw new AppError('INVALID_INPUT', 'Unknown action.');
    }
    const operation = options.operations.submit(action as Action, { entry: c.req.param('id') });
    return c.json({ ok: true, data: { operationId: operation.id }, error: null }, 202);
  });
  for (const [route, selector] of [
    ['/api/projects/:id/actions', 'project'],
    ['/api/compose-groups/:id/actions', 'compose'],
  ] as const) {
    app.post(route, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new AppError('INVALID_INPUT', 'Unknown aggregate action.');
      }
      const action =
        body && typeof body === 'object' && 'action' in body && typeof body.action === 'string'
          ? body.action
          : undefined;
      if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        throw new AppError('INVALID_INPUT', 'Unknown aggregate action.');
      }
      const operation = options.operations.submit(action, {
        [selector]: c.req.param('id'),
      } as Target);
      return c.json({ ok: true, data: { operationId: operation.id }, error: null }, 202);
    });
  }
  app.get('/api/operations/:id', (c) => {
    const operation = options.operations.records.get(c.req.param('id'));
    if (!operation) {
      throw new AppError('INVALID_INPUT', 'Unknown operation ID.');
    }
    return c.json({ ok: true, data: operation, error: null });
  });
  app.get('/api/entries/:id/logs', async (c) => {
    const id = c.req.param('id');
    if (!options.operations.config.entries.some((entry) => entry.id === id)) {
      throw new AppError('INVALID_TARGET', 'Entry does not exist.', undefined, id);
    }
    const after = c.req.query('after'),
      tail = c.req.query('tail');
    if (
      [after, tail].some(
        (value) =>
          value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))),
      )
    ) {
      throw new AppError('INVALID_INPUT', 'Log cursor and tail must be non-negative integers.');
    }
    return c.json({
      ok: true,
      data: await options.history(id, {
        after: after === undefined ? undefined : Number(after),
        tail: tail === undefined ? undefined : Number(tail),
      }),
      error: null,
    });
  });
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let active = true;
      let queue: RuntimeEvent[] = [];
      const unsubscribe = options.events.subscribe((event) => {
        if (queue.length >= 512) {
          queue = [
            {
              cursor: event.cursor,
              type: 'gap',
              data: { message: 'Slow client missed events. Refresh snapshot and log history.' },
            },
          ];
        } else {
          queue.push(event);
        }
      });
      stream.onAbort(() => {
        active = false;
        unsubscribe();
      });
      try {
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify(snapshot()),
          id: String(options.events.cursor),
        });
        while (active) {
          const events = queue;
          queue = [];
          for (const event of events) {
            await stream.writeSSE({
              event: 'change',
              data: JSON.stringify(event),
              id: String(event.cursor),
            });
          }
          await stream.sleep(100);
        }
      } finally {
        unsubscribe();
      }
    }),
  );
  app.post('/api/manager/stop', (c) => {
    setTimeout(
      () =>
        void options.shutdown().catch((error) => {
          console.error(errorData(error));
          process.exitCode = 1;
        }),
      50,
    );
    return c.json({ ok: true, data: { stopping: true }, error: null });
  });
  app.get('*', async (c) => {
    const asset = await readAsset(assets, c.req.path);
    if (!asset) {
      return c.notFound();
    }
    c.header('Content-Type', asset.type);
    return c.body(new Uint8Array(asset.body));
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    endpoint,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
