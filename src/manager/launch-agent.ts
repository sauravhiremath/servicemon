import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { processIdentity } from '../config/process-identity.js';
import { assetRoot } from '../server/assets.js';
import { AppError } from '../shared/errors.js';
import type { EnvironmentCaptureSelectors } from '../shared/types.js';
import { readInstance, readLock } from './instance.js';

const DEFAULT_LAUNCH_AGENT_LABEL = 'com.servicemon.manager';

export interface StartupRegistration {
  label: string;
  plistPath: string;
}
export interface StartupSettings {
  port?: number;
  ui?: string | null;
  environmentCapture?: EnvironmentCaptureSelectors;
}
export interface StartupInspection {
  registered: boolean;
  loaded: boolean;
  label?: string;
  plistPath?: string;
  registrationKey: string;
}
export interface StartupRenewal {
  configPath: string;
  stateDir: string;
  port: number;
  ui: string | null;
  environmentCapture?: EnvironmentCaptureSelectors;
}

function label(): string {
  const value = process.env.SERVICEMON_LAUNCH_AGENT_LABEL || DEFAULT_LAUNCH_AGENT_LABEL;
  if (value.includes('/') || /\s/.test(value)) {
    throw new AppError('INVALID_INPUT', 'LaunchAgent label must not contain spaces or slashes.');
  }
  return value;
}

function agentsDir(): string {
  return (
    process.env.SERVICEMON_LAUNCH_AGENTS_DIR || path.join(homedir(), 'Library', 'LaunchAgents')
  );
}

function userId(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new AppError('TOOL_UNAVAILABLE', 'LaunchAgent requires a user id.');
  }
  return uid;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function recordPath(stateDir: string): string {
  return path.join(stateDir, 'launch-agent.json');
}

async function readRegistration(stateDir: string): Promise<StartupRegistration | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(recordPath(stateDir), 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('label' in value) ||
      !('plistPath' in value) ||
      typeof value.label !== 'string' ||
      typeof value.plistPath !== 'string'
    ) {
      return undefined;
    }
    return { label: value.label, plistPath: value.plistPath };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function launchctl(args: string[], allowMissing = false): Promise<string | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
  execFile(
    process.env.SERVICEMON_LAUNCHCTL || '/bin/launchctl',
    args,
    { timeout: 10000 },
    (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      if (allowMissing && /Could not find (?:specified )?service/i.test(stderr)) {
        resolve(undefined);
        return;
      }
      reject(new AppError('TOOL_UNAVAILABLE', stderr.trim() || error.message, { args }));
    },
  );
  return promise;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function replaceFile(file: string, content: string | undefined, mode: number): Promise<void> {
  if (content === undefined) {
    await rm(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function programArguments(settings?: StartupSettings): string[] {
  const script = process.argv[1];
  if (!script) {
    throw new AppError('INVALID_INPUT', 'Cannot find the servicemon executable path.');
  }
  const launcher = process.env.SERVICEMON_STARTUP_EXECUTABLE;
  if (launcher && !path.isAbsolute(launcher)) {
    throw new AppError('INVALID_INPUT', 'The startup launcher must have an absolute path.');
  }
  const args = launcher ? [launcher, 'serve'] : [process.execPath, path.resolve(script), 'serve'];
  if (!settings) {
    return args;
  }
  if (settings.port !== undefined) {
    if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
      throw new AppError('INVALID_INPUT', 'Port must be an integer from 0 to 65535.');
    }
    args.push('--port', String(settings.port));
  }
  if (settings.ui) {
    if (!path.isAbsolute(settings.ui)) {
      throw new AppError('INVALID_INPUT', 'The dashboard path must be absolute.');
    }
    args.push('--ui', settings.ui);
  }
  return args;
}

function shellSettings(settings?: StartupSettings): string {
  if (!settings) {
    return ['SERVICEMON_LOGIN_SHELL', 'SERVICEMON_ENV_CAPTURE_TIMEOUT_MS']
      .map((key) =>
        process.env[key] === undefined
          ? ''
          : `    <key>${key}</key>\n    <string>${xml(process.env[key]!)}</string>\n`,
      )
      .join('');
  }
  const capture = settings.environmentCapture;
  const lines: string[] = [];
  if (capture?.loginShell) {
    lines.push(
      `    <key>SERVICEMON_LOGIN_SHELL</key>\n    <string>${xml(capture.loginShell)}</string>\n`,
    );
  }
  if (capture?.timeoutMs !== undefined) {
    lines.push(
      `    <key>SERVICEMON_ENV_CAPTURE_TIMEOUT_MS</key>\n    <string>${xml(String(capture.timeoutMs))}</string>\n`,
    );
  }
  return lines.join('');
}

function plistDocument(
  selected: string,
  absoluteConfig: string,
  absoluteState: string,
  settings?: StartupSettings,
): string {
  const argumentsList = programArguments(settings);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(selected)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((value) => `    <string>${xml(value)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SERVICEMON_CONFIG</key>
    <string>${xml(absoluteConfig)}</string>
    <key>SERVICEMON_STATE_DIR</key>
    <string>${xml(absoluteState)}</string>
${shellSettings(settings)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(absoluteState, 'manager.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(absoluteState, 'manager.err.log'))}</string>
</dict>
</plist>
`;
}

function plistValue(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match?.[1]?.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function launchdPid(text: string): number | undefined {
  const match = /^\s*pid = (\d+)\s*$/m.exec(text);
  return match ? Number(match[1]) : undefined;
}

function jobRunning(text: string | undefined): boolean {
  return text !== undefined && /^\s*(?:pid = \d+|state = running)\s*$/m.test(text);
}

export async function enableStartup(
  configPath: string,
  stateDir: string,
  settings?: StartupSettings,
): Promise<StartupRegistration> {
  const selected = label();
  const directory = agentsDir();
  const plistPath = path.join(directory, `${selected}.plist`);
  const absoluteConfig = path.resolve(configPath);
  const absoluteState = path.resolve(stateDir);
  const plist = plistDocument(selected, absoluteConfig, absoluteState, settings);
  await mkdir(directory, { recursive: true });
  await mkdir(absoluteState, { recursive: true, mode: 0o700 });
  await chmod(absoluteState, 0o700);
  const domain = `gui/${userId()}`;
  const target = `${domain}/${selected}`;
  const saved = await readRegistration(absoluteState);
  if (saved && (saved.label !== selected || saved.plistPath !== plistPath)) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Disable the previous startup registration before selecting another label or folder.',
    );
  }
  const oldPlist = await readOptional(plistPath);
  const oldRecord = await readOptional(recordPath(absoluteState));
  const loaded = await launchctl(['print', target], true);
  const registration = `${JSON.stringify({ label: selected, plistPath })}\n`;
  const running = jobRunning(loaded);
  if (loaded !== undefined && oldPlist === plist && running) {
    await launchctl(['enable', target]);
    await replaceFile(recordPath(absoluteState), registration, 0o600);
    return { label: selected, plistPath };
  }
  if (running) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Startup changes require an explicit stop. Run servicemon manager stop, then startup enable.',
    );
  }
  if (loaded !== undefined) {
    await launchctl(['bootout', target]);
  }
  try {
    await replaceFile(plistPath, plist, 0o644);
    await replaceFile(recordPath(absoluteState), registration, 0o600);
    await launchctl(['enable', target]);
    await launchctl(['bootstrap', domain, plistPath]);
  } catch (error) {
    await replaceFile(plistPath, oldPlist, 0o644);
    await replaceFile(recordPath(absoluteState), oldRecord, 0o600);
    if (loaded !== undefined && oldPlist !== undefined) {
      try {
        await launchctl(['bootstrap', domain, plistPath]);
      } catch (restoreError) {
        throw new AppError(
          'TOOL_UNAVAILABLE',
          'Startup replacement failed. The old files are restored, but launchd could not reload them. Run startup enable after stopping the manager.',
          { replacement: String(error), restore: String(restoreError) },
        );
      }
    }
    throw error;
  }
  return { label: selected, plistPath };
}

export async function disableStartup(
  stateDir: string,
): Promise<{ label: string; removed: boolean }> {
  const saved = await readRegistration(stateDir);
  const selected = saved?.label ?? label();
  const plistPath = saved?.plistPath ?? path.join(agentsDir(), `${selected}.plist`);
  const target = `gui/${userId()}/${selected}`;
  await launchctl(['disable', target]);
  const loaded = await launchctl(['print', target], true);
  if (loaded !== undefined && !jobRunning(loaded)) {
    await launchctl(['bootout', target]);
  }
  let removed = false;
  try {
    await rm(plistPath);
    removed = true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await rm(recordPath(stateDir), { force: true });
  return { label: selected, removed };
}

export async function inspectStartupRegistration(
  configPath: string,
  stateDir: string,
): Promise<StartupInspection> {
  const absoluteConfig = path.resolve(configPath);
  const absoluteState = path.resolve(stateDir);
  const saved = await readRegistration(absoluteState);
  const selected = label();
  const expectedPlist = path.join(agentsDir(), `${selected}.plist`);
  const loadedText = await launchctl(['print', `gui/${userId()}/${selected}`], true);
  const plist = await readOptional(expectedPlist);
  if (!saved) {
    const pid = loadedText ? launchdPid(loadedText) : undefined;
    let unrelated = plist !== undefined;
    if (loadedText !== undefined && !unrelated) {
      const disabledJobs = await launchctl(['print-disabled', `gui/${userId()}`]);
      const disabled = disabledJobs
        ?.split('\n')
        .some((line) => line.trim() === `"${selected}" => disabled`);
      const instance = pid === undefined ? undefined : await readInstance(absoluteState);
      const identity = pid === undefined ? undefined : await processIdentity(pid);
      unrelated =
        !disabled ||
        (jobRunning(loadedText) &&
          (!instance ||
            instance.pid !== pid ||
            path.resolve(instance.configPath) !== absoluteConfig ||
            identity?.state !== 'alive' ||
            identity.startedAt !== instance.startedAt));
    }
    if (unrelated) {
      throw new AppError(
        'MANAGER_CONFLICT',
        'An unrelated startup registration is loaded for this label.',
      );
    }
    return {
      registered: false,
      loaded: loadedText !== undefined,
      registrationKey: registrationSnapshot({
        saved: null,
        plist: null,
        launchd: {
          loaded: loadedText !== undefined,
          running: jobRunning(loadedText),
          pid: pid ?? null,
        },
      }),
    };
  }
  if (saved.label !== selected || path.resolve(saved.plistPath) !== path.resolve(expectedPlist)) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Disable the previous startup registration before selecting another label or folder.',
    );
  }
  if (!plist) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'The saved startup registration does not match the installed launch agent.',
    );
  }
  const recordedConfig = plistValue(plist, 'SERVICEMON_CONFIG');
  const recordedState = plistValue(plist, 'SERVICEMON_STATE_DIR');
  if (
    recordedConfig === undefined ||
    recordedState === undefined ||
    path.resolve(recordedConfig) !== absoluteConfig ||
    path.resolve(recordedState) !== absoluteState
  ) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'The startup registration belongs to a different config or state folder.',
    );
  }
  const pid = loadedText ? launchdPid(loadedText) : undefined;
  const instance = await readInstance(absoluteState);
  if (pid !== undefined && (!instance || instance.pid !== pid)) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Launchd is running a different process. No process was signalled.',
    );
  }
  const launchdPidValue = pid ?? null;
  return {
    registered: true,
    loaded: loadedText !== undefined,
    label: saved.label,
    plistPath: saved.plistPath,
    registrationKey: registrationSnapshot({
      saved: { label: saved.label, plistPath: path.resolve(saved.plistPath) },
      plist,
      launchd: {
        loaded: loadedText !== undefined,
        running: jobRunning(loadedText),
        pid: launchdPidValue,
      },
    }),
  };
}
function registrationSnapshot(snapshot: {
  saved: { label: string; plistPath: string } | null;
  plist: string | null;
  launchd: { loaded: boolean; running: boolean; pid: number | null };
}): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function renewAndStartRegistration(
  request: StartupRenewal,
): Promise<StartupRegistration> {
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    throw new AppError('INVALID_INPUT', 'Registered restart requires the current port.');
  }
  if (request.ui !== null) {
    if (!path.isAbsolute(request.ui)) {
      throw new AppError('INVALID_INPUT', 'The dashboard path must be absolute.');
    }
    try {
      await assetRoot(request.ui);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('INVALID_INPUT', 'Custom UI is not a file.');
    }
  }
  const inspection = await inspectStartupRegistration(request.configPath, request.stateDir);
  if (!inspection.registered || !inspection.label) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'No startup registration belongs to this state folder. No replacement was launched.',
    );
  }
  const loaded = await launchctl(['print', `gui/${userId()}/${inspection.label}`], true);
  if (jobRunning(loaded)) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'Startup renewal requires the existing launch agent to exit first.',
    );
  }
  const holder = await readLock(request.stateDir);
  if (holder) {
    const identity = await processIdentity(holder.pid);
    if (identity.state !== 'dead') {
      throw new AppError(
        'MANAGER_CONFLICT',
        'The previous manager lock is still held. No replacement was launched.',
      );
    }
  }
  return enableStartup(request.configPath, request.stateDir, {
    port: request.port,
    ui: request.ui,
    ...(request.environmentCapture ? { environmentCapture: request.environmentCapture } : {}),
  });
}
