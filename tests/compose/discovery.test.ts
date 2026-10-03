import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { composeEntries, discoverGroups, serviceDependencies, serviceHasHealthcheck } from '../../src/compose/discovery.js';
import { makeGroup, removeGroup } from './support.js';

describe('discoverGroups', () => {
  it('uses normalized Compose config for interpolation, conditions, and profiles', async () => {
    const group = await makeGroup();
    const hidden = await makeGroup(`services:\n  shown:\n    image: ubuntu:24.04\n    command: ["true"]\n  hidden:\n    image: ubuntu:24.04\n    profiles: ["manual"]\n    command: ["true"]\n`);
    const short = await makeGroup(`services:\n  db:\n    image: ubuntu:24.04\n    command: ["true"]\n  app:\n    image: ubuntu:24.04\n    command: ["true"]\n    depends_on: ["db"]\n`);
    try {
      const found = await discoverGroups([group], { ...process.env, GREETING: 'probe' });
      const discovery = found.get(group.id);
      expect(discovery).toBeTruthy();
      if (!discovery?.services || typeof discovery.services !== 'object') throw new Error('missing services');
      const services = discovery.services;
      if (!('db' in services) || !services.db || typeof services.db !== 'object') throw new Error('missing db');
      const db = services.db;
      if (!('environment' in db) || !db.environment || typeof db.environment !== 'object' || !('GREETING' in db.environment)) throw new Error('missing greeting');
      expect(db.environment.GREETING).toBe('probe');
      expect(serviceDependencies(discovery, 'app')).toEqual([{ service: 'db', condition: 'service_healthy', required: true }]);
      expect(serviceDependencies(discovery, 'web')).toEqual([]);
      if (!('web' in services) || !services.web || typeof services.web !== 'object' || !('scale' in services.web)) throw new Error('missing scale');
      expect(services.web.scale).toBe(2);

      const omitted = await discoverGroups([hidden], process.env);
      const omittedServices = omitted.get(hidden.id)?.services;
      expect(omittedServices && typeof omittedServices === 'object' ? Object.keys(omittedServices) : []).toEqual(['shown']);
      const included = await discoverGroups([hidden], { ...process.env, COMPOSE_PROFILES: 'manual' });
      const includedServices = included.get(hidden.id)?.services;
      expect(includedServices && typeof includedServices === 'object' ? Object.keys(includedServices).sort() : []).toEqual(['hidden', 'shown']);

      const normalized = await discoverGroups([short], process.env);
      const normalizedDiscovery = normalized.get(short.id);
      if (!normalizedDiscovery) throw new Error('missing short discovery');
      expect(serviceDependencies(normalizedDiscovery, 'app')).toEqual([{ service: 'db', condition: 'service_started', required: true }]);
    } finally {
      await removeGroup(group);
      await removeGroup(hidden);
      await removeGroup(short);
    }
  });

  it('rejects unknown overrides, duplicate project names, invalid files, and a missing daemon', async () => {
    const group = await makeGroup();
    const other = await makeGroup();
    other.projectName = group.projectName;
    const broken = await makeGroup('services: [\n');
    try {
      group.overrides = { missing: { notes: 'no' } };
      await expect(discoverGroups([group], process.env)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      group.overrides = {};
      await expect(discoverGroups([group, other], process.env)).rejects.toBeInstanceOf(AppError);
      await expect(discoverGroups([group, other], process.env)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(discoverGroups([broken], process.env)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      const env = { ...process.env };
      delete env.PATH;
      await expect(discoverGroups([group], env)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    } finally {
      await removeGroup(group);
      await removeGroup(other);
      await removeGroup(broken);
    }
  });

  it('builds entry ids from overrides and leaves Compose dependencies to Compose', async () => {
    const group = await makeGroup();
    group.autostart = true;
    group.overrides = { app: { depends_on: ['setup'], notes: 'edge', autostart: false, readiness_seconds: 15 } };
    try {
      const discovery = (await discoverGroups([group], process.env)).get(group.id);
      expect(discovery).toBeTruthy();
      const entries = composeEntries(group, discovery!, { stopSeconds: 10, readinessSeconds: 60 });
      const app = entries.find((entry) => entry.composeService === 'app');
      const db = entries.find((entry) => entry.composeService === 'db');
      expect(app).toMatchObject({ id: 'demo/infra.app', composeGroupId: 'demo/infra', kind: 'compose', notes: 'edge', autostart: false, readinessSeconds: 15, dependsOn: ['demo/setup'] });
      expect(app?.dependsOn).not.toContain('demo/infra.db');
      expect(db).toMatchObject({ id: 'demo/infra.db', autostart: true, dependsOn: [] });
      expect(app?.execution).toMatchObject({ projectName: group.projectName, service: 'app', file: group.file });
    } finally {
      await removeGroup(group);
    }
  });
});

describe('serviceHasHealthcheck', () => {
  it('treats NONE and disable as no Docker health check', () => {
    const discovery = { services: { app: { healthcheck: { test: ['NONE'] } }, plain: { healthcheck: { test: 'NONE' } }, off: { healthcheck: { disable: true } }, web: { healthcheck: { test: ['CMD', 'true'] } } } };
    expect(serviceHasHealthcheck(discovery, 'app')).toBe(false);
    expect(serviceHasHealthcheck(discovery, 'plain')).toBe(false);
    expect(serviceHasHealthcheck(discovery, 'off')).toBe(false);
    expect(serviceHasHealthcheck(discovery, 'web')).toBe(true);
  });
});
