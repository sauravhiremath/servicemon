import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

const DEFAULT_LAUNCH_AGENT_LABEL = 'com.servicemon.manager';

export interface StartupRegistration {
  label: string;
  plistPath: string;
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
    const value = JSON.parse(await readFile(recordPath(stateDir), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || !('label' in value) || !('plistPath' in value)) {
      return undefined;
    }
    if (typeof value.label !== 'string' || typeof value.plistPath !== 'string') {
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

export async function enableStartup(
  configPath: string,
  stateDir: string,
): Promise<StartupRegistration> {
  const script = process.argv[1];
  if (!script) {
    throw new AppError('INVALID_INPUT', 'Cannot find the servicemon executable path.');
  }
  const launcher = process.env.SERVICEMON_STARTUP_EXECUTABLE;
  if (launcher && !path.isAbsolute(launcher)) {
    throw new AppError('INVALID_INPUT', 'The startup launcher must have an absolute path.');
  }
  const argumentsList = launcher
    ? [launcher, 'serve']
    : [process.execPath, path.resolve(script), 'serve'];
  const selected = label();
  const directory = agentsDir();
  const plistPath = path.join(directory, `${selected}.plist`);
  const absoluteConfig = path.resolve(configPath);
  const absoluteState = path.resolve(stateDir);
  const shellSettings = ['SERVICEMON_LOGIN_SHELL', 'SERVICEMON_ENV_CAPTURE_TIMEOUT_MS']
    .map((key) =>
      process.env[key] === undefined
        ? ''
        : `    <key>${key}</key>\n    <string>${xml(process.env[key]!)}</string>\n`,
    )
    .join('');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
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
${shellSettings}
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
  const running = loaded !== undefined && /^\s*(?:pid = \d+|state = running)\s*$/m.test(loaded);
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
  if (loaded !== undefined && !/^\s*(?:pid = \d+|state = running)\s*$/m.test(loaded)) {
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
