import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    throw new Error('package.json version is missing.');
  }
  return parsed.version;
}

/** Captured once at process start. A later package install must not change it. */
export const packageVersion = readPackageVersion();

/** Application requests are compatible only when this integer matches. */
export const applicationProtocol = 2;
