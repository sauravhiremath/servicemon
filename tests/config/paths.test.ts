import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, stateDirectory } from '../../src/config/paths.js';

describe('config paths', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses an explicit path before the environment and the default', () => {
    vi.stubEnv('SERVICEMON_CONFIG', '/env/config.yaml');
    vi.stubEnv('SERVICEMON_STATE_DIR', '/env/state');
    expect(configPath('/explicit/config.yaml')).toBe('/explicit/config.yaml');
    expect(stateDirectory('/explicit/state')).toBe('/explicit/state');
  });

  it('uses environment overrides before the home defaults', () => {
    vi.stubEnv('SERVICEMON_CONFIG', '~/svc/config.yaml');
    vi.stubEnv('SERVICEMON_STATE_DIR', '~/svc/state');
    expect(configPath()).toBe(path.join(homedir(), 'svc/config.yaml'));
    expect(stateDirectory()).toBe(path.join(homedir(), 'svc/state'));
  });

  it('expands only a leading tilde in the defaults', () => {
    expect(configPath()).toBe(path.join(homedir(), '.config/servicemon/config.yaml'));
    expect(stateDirectory()).toBe(path.join(homedir(), 'Library/Application Support/servicemon'));
  });
});
