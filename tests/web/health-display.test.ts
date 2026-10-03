import { describe, expect, it } from 'vitest';
import type { EntryStatus } from '../../src/shared/types.js';
import { displayHealth } from '../../src/web/labels.js';

const service: EntryStatus = {
  id: 'demo/api', projectId: 'demo', key: 'api', name: 'api', kind: 'service', directory: '.',
  links: [], dependsOn: [], autostart: false, restartDependencies: false, restartDependents: false,
  stopSeconds: 10, readinessSeconds: 60, state: 'running', health: 'healthy',
  healthcheck: { type: 'tcp', host: '127.0.0.1', port: 8000 },
};

describe('health display', () => {
  it.each(['stopped', 'exited', 'failed'] as const)('does not show a stale health result for a %s service', state => {
    expect(displayHealth({ ...service, state })).toBe('none');
  });
  it.each(['running', 'stopped'] as const)('shows no check when a %s service has no configured check', state => {
    expect(displayHealth({ ...service, state, healthcheck: undefined })).toBe('none');
  });
  it('uses Docker check status rather than a process check for Compose entries', () => {
    const compose = { ...service, kind: 'compose' as const, healthcheck: undefined };
    expect(displayHealth(compose)).toBe('healthy');
    expect(displayHealth({ ...compose, state: 'stopped' })).toBe('none');
    expect(displayHealth({ ...compose, state: 'stopped', health: 'no-check' })).toBe('none');
  });
  it('keeps the current result for live checked services', () => {
    for (const health of ['checking', 'healthy', 'unhealthy', 'unknown'] as const) {
      expect(displayHealth({ ...service, health })).toBe(health);
    }
  });
  it('keeps tasks separate from service health', () => {
    expect(displayHealth({ ...service, kind: 'task', state: 'succeeded' })).toBe('not-applicable');
  });
});
