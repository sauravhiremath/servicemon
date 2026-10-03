import { isAbsolute, resolve } from 'node:path';
import type { ComposeGroup, Entry } from '../shared/types.js';
import { AppError } from '../shared/errors.js';
import { dockerCompose } from './command.js';

export interface ComposeDependency { service: string; condition: string; required: boolean }
export interface ComposeEntryDefaults { stopSeconds: number; readinessSeconds: number }

const EXECUTION_KEYS = ['image', 'command', 'entrypoint', 'environment', 'volumes', 'ports', 'depends_on', 'healthcheck', 'scale', 'deploy', 'build', 'user', 'working_dir', 'networks'] as const;

export function composeFile(group: ComposeGroup): string {
  return isAbsolute(group.file) ? group.file : resolve(group.directory, group.file);
}

export function composeServiceId(projectId: string, groupKey: string, serviceName: string): string {
  return `${projectId}/${groupKey}.${serviceName}`;
}

export function servicesOf(discovery: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const services = discovery.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(services)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) record[key] = item;
    result[name] = record;
  }
  return result;
}

export function serviceRecord(discovery: Record<string, unknown>, serviceName: string): Record<string, unknown> {
  const service = servicesOf(discovery)[serviceName];
  if (!service) throw new AppError('INVALID_CONFIG', `Compose service ${serviceName} is not in the normalized config.`);
  return service;
}

export function serviceDependencies(discovery: Record<string, unknown>, serviceName: string): ComposeDependency[] {
  const raw = serviceRecord(discovery, serviceName).depends_on;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const dependencies: ComposeDependency[] = [];
  for (const [service, value] of Object.entries(raw)) {
    const condition = value && typeof value === 'object' && 'condition' in value && typeof value.condition === 'string' ? value.condition : 'service_started';
    const required = !(value && typeof value === 'object' && 'required' in value && value.required === false);
    dependencies.push({ service, condition, required });
  }
  return dependencies;
}

export function replicaCount(discovery: Record<string, unknown>, serviceName: string): number {
  const service = serviceRecord(discovery, serviceName);
  if (typeof service.scale === 'number' && service.scale > 0) return service.scale;
  const deploy = service.deploy;
  if (deploy && typeof deploy === 'object' && !Array.isArray(deploy) && 'replicas' in deploy && typeof deploy.replicas === 'number' && deploy.replicas > 0) return deploy.replicas;
  return 1;
}

export function serviceHasHealthcheck(discovery: Record<string, unknown>, serviceName: string): boolean {
  const healthcheck = serviceRecord(discovery, serviceName).healthcheck;
  if (!healthcheck || typeof healthcheck !== 'object' || Array.isArray(healthcheck)) return false;
  if ('disable' in healthcheck && healthcheck.disable === true) return false;
  if (!('test' in healthcheck)) return true;
  const test = healthcheck.test;
  if (test === 'NONE') return false;
  return !(Array.isArray(test) && test.length === 1 && test[0] === 'NONE');
}

export function serviceExecution(group: ComposeGroup, discovery: Record<string, unknown>, serviceName: string): Record<string, unknown> {
  const service = serviceRecord(discovery, serviceName);
  const picked: Record<string, unknown> = {};
  for (const key of EXECUTION_KEYS) if (service[key] !== undefined) picked[key] = service[key];
  return { file: composeFile(group), projectName: group.projectName, service: serviceName, definition: picked };
}

export function overrideMap(group: ComposeGroup): Record<string, Record<string, unknown>> {
  const merged = { ...(group.services ?? {}), ...(group.overrides ?? {}) };
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_CONFIG', `Compose override ${name} in ${group.id} must be a mapping.`, { groupId: group.id, service: name });
    if ('image' in value || 'build' in value) continue;
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) record[key] = item;
    overrides[name] = record;
  }
  return overrides;
}

export function validateProjectName(group: ComposeGroup): void {
  if (!group.projectName || /[\s/\\]/.test(group.projectName)) {
    throw new AppError('INVALID_CONFIG', `Compose project name is missing or invalid for ${group.id}.`, { groupId: group.id });
  }
}

export function validateComposeProjectNames(groups: ComposeGroup[]): void {
  const seen = new Map<string, string>();
  for (const group of groups) {
    validateProjectName(group);
    const previous = seen.get(group.projectName);
    if (previous) throw new AppError('INVALID_CONFIG', `Compose project name ${group.projectName} is used by ${previous} and ${group.id}.`, { projectName: group.projectName, groups: [previous, group.id] });
    seen.set(group.projectName, group.id);
  }
}

export function validateOverrides(group: ComposeGroup, discovery: Record<string, unknown>): void {
  const names = new Set(Object.keys(servicesOf(discovery)));
  for (const name of Object.keys(overrideMap(group))) {
    if (!names.has(name)) throw new AppError('INVALID_CONFIG', `Unknown Compose service override ${name} in ${group.id}.`, { groupId: group.id, service: name });
  }
  for (const name of names) {
    if (name.includes('/') || name.includes('.')) throw new AppError('INVALID_CONFIG', `Compose service name ${name} in ${group.id} cannot contain '.' or '/'.`, { groupId: group.id, service: name });
  }
}

function field(override: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (override[key] !== undefined) return override[key];
  return undefined;
}

function booleanField(override: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  const value = field(override, ...keys);
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError('INVALID_CONFIG', `Expected a boolean for ${keys[0]}.`);
  return value;
}

function resolveDepends(projectId: string, groupKey: string, serviceNames: Set<string>, ref: unknown): string {
  if (typeof ref !== 'string' || !ref) throw new AppError('INVALID_CONFIG', 'Compose override dependency must be a service reference.');
  if (ref.includes('/')) return ref;
  if (ref.includes('.')) {
    const service = ref.slice(ref.indexOf('.') + 1);
    if (ref.startsWith(`${groupKey}.`) && !serviceNames.has(service)) throw new AppError('INVALID_CONFIG', `Unknown Compose dependency ${ref}.`);
    return `${projectId}/${ref}`;
  }
  if (serviceNames.has(ref)) return `${projectId}/${groupKey}.${ref}`;
  return `${projectId}/${ref}`;
}

export function composeEntries(group: ComposeGroup, discovery: Record<string, unknown>, defaults: ComposeEntryDefaults): Entry[] {
  validateOverrides(group, discovery);
  const names = new Set(Object.keys(servicesOf(discovery)));
  const overrides = overrideMap(group);
  return [...names].map((serviceName) => {
    const override = overrides[serviceName] ?? {};
    const links = field(override, 'links') ?? [];
    if (!Array.isArray(links) || links.some((link) => typeof link !== 'string')) throw new AppError('INVALID_CONFIG', `Links for ${serviceName} must be strings.`);
    const depends = field(override, 'depends_on', 'dependsOn') ?? [];
    if (!Array.isArray(depends)) throw new AppError('INVALID_CONFIG', `Dependencies for ${serviceName} must be a list.`);
    const readiness = field(override, 'readiness_seconds', 'readinessSeconds');
    if (readiness !== undefined && typeof readiness !== 'number') throw new AppError('INVALID_CONFIG', `Readiness timeout for ${serviceName} must be a number.`);
    const notes = field(override, 'notes');
    if (notes !== undefined && typeof notes !== 'string') throw new AppError('INVALID_CONFIG', `Notes for ${serviceName} must be a string.`);
    const name = field(override, 'name');
    return {
      id: composeServiceId(group.projectId, group.key, serviceName),
      projectId: group.projectId,
      key: `${group.key}.${serviceName}`,
      name: typeof name === 'string' ? name : serviceName,
      kind: 'compose',
      directory: group.directory,
      ...(typeof notes === 'string' ? { notes } : {}),
      links,
      dependsOn: depends.map((ref) => resolveDepends(group.projectId, group.key, names, ref)),
      autostart: booleanField(override, group.autostart, 'autostart'),
      restartDependencies: booleanField(override, false, 'restart_dependencies', 'restartDependencies'),
      restartDependents: booleanField(override, false, 'restart_dependents', 'restartDependents'),
      stopSeconds: defaults.stopSeconds,
      readinessSeconds: typeof readiness === 'number' ? readiness : defaults.readinessSeconds,
      composeGroupId: group.id,
      composeService: serviceName,
      execution: serviceExecution(group, discovery, serviceName),
    };
  });
}

export function composeArgs(group: ComposeGroup, args: string[]): string[] {
  validateProjectName(group);
  return ['--project-name', group.projectName, '--project-directory', group.directory, '--file', composeFile(group), ...args];
}

export async function readGroupConfig(group: ComposeGroup, environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const result = await dockerCompose(composeArgs(group, ['config', '--format', 'json']), { cwd: group.directory, env: environment, timeoutMs: 30000 });
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AppError('INVALID_CONFIG', `Docker Compose config for ${group.id} was not JSON.`, { message: error instanceof Error ? error.message : String(error) });
  }
}

export async function discoverGroups(groups: ComposeGroup[], environment: NodeJS.ProcessEnv): Promise<Map<string, Record<string, unknown>>> {
  validateComposeProjectNames(groups);
  const discoveries = new Map<string, Record<string, unknown>>();
  await Promise.all(groups.map(async (group) => {
    const discovery = await readGroupConfig(group, environment);
    validateOverrides(group, discovery);
    discoveries.set(group.id, discovery);
  }));
  return discoveries;
}
