import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_CONFIG = path.join('.config', 'servicemon', 'config.yaml');
const DEFAULT_STATE = path.join('Library', 'Application Support', 'servicemon');

function expandHome(value: string): string {
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveAgainst(base: string, value: string): string {
  return path.resolve(base, expandHome(value));
}

function selected(
  explicit: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  for (const value of [explicit, envValue, fallback]) {
    if (value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return fallback;
}

export function configPath(explicit?: string): string {
  return path.resolve(
    expandHome(
      selected(explicit, process.env.SERVICEMON_CONFIG, path.join(homedir(), DEFAULT_CONFIG)),
    ),
  );
}

export function stateDirectory(explicit?: string): string {
  return path.resolve(
    expandHome(
      selected(explicit, process.env.SERVICEMON_STATE_DIR, path.join(homedir(), DEFAULT_STATE)),
    ),
  );
}
