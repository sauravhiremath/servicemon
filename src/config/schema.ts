import { parseDocument } from 'yaml';
import { ZodError, z } from 'zod';
import { AppError } from '../shared/errors.js';

const seconds = z.number().positive();
const text = z.string().min(1);
const links = z.array(text);
const dependsOn = z.array(text);
const httpCheck = z.strictObject({
  type: z.literal('http'),
  url: text,
  expected_status: z.number().int().min(100).max(599).optional(),
  interval_seconds: seconds.optional(),
  timeout_seconds: seconds.optional(),
});
const tcpCheck = z.strictObject({
  type: z.literal('tcp'),
  host: text,
  port: z.number().int().min(1).max(65535),
  interval_seconds: seconds.optional(),
  timeout_seconds: seconds.optional(),
});
const commandCheck = z.strictObject({
  type: z.literal('command'),
  command: text,
  interval_seconds: seconds.optional(),
  timeout_seconds: seconds.optional(),
});
const healthcheck = z.discriminatedUnion('type', [httpCheck, tcpCheck, commandCheck]);
const serviceSchema = z.strictObject({
  name: text.optional(),
  command: text,
  directory: text.optional(),
  notes: z.string().optional(),
  links: links.optional(),
  depends_on: dependsOn.optional(),
  autostart: z.boolean().optional(),
  restart_dependencies: z.boolean().optional(),
  restart_dependents: z.boolean().optional(),
  healthcheck: healthcheck.optional(),
  stop_seconds: seconds.optional(),
  readiness_seconds: seconds.optional(),
});
const taskSchema = z.strictObject({
  name: text.optional(),
  command: text,
  directory: text.optional(),
  notes: z.string().optional(),
  links: links.optional(),
  depends_on: dependsOn.optional(),
  autostart: z.boolean().optional(),
  stop_seconds: seconds.optional(),
});
const composeOverrideSchema = z.strictObject({
  name: text.optional(),
  notes: z.string().optional(),
  links: links.optional(),
  depends_on: dependsOn.optional(),
  autostart: z.boolean().optional(),
  restart_dependencies: z.boolean().optional(),
  restart_dependents: z.boolean().optional(),
  readiness_seconds: seconds.optional(),
});
const groupSchema = z.strictObject({
  name: text.optional(),
  file: text,
  directory: text.optional(),
  project_name: text.optional(),
  autostart: z.boolean().optional(),
  services: z.record(z.string(), composeOverrideSchema).optional(),
});
const projectSchema = z.strictObject({
  name: text.optional(),
  directory: text,
  notes: z.string().optional(),
  services: z.record(z.string(), serviceSchema).optional(),
  tasks: z.record(z.string(), taskSchema).optional(),
  compose_groups: z.record(z.string(), groupSchema).optional(),
});
const configSchema = z.strictObject({
  version: z.literal(1),
  server: z.strictObject({ port: z.number().int().min(0).max(65535) }).optional(),
  logs: z
    .strictObject({
      per_entry_bytes: z.number().int().positive().optional(),
      total_bytes: z.number().int().positive().optional(),
    })
    .optional(),
  timeouts: z
    .strictObject({
      stop_seconds: seconds.optional(),
      readiness_seconds: seconds.optional(),
    })
    .optional(),
  projects: z.record(z.string(), projectSchema).optional(),
});
export type ParsedConfig = z.infer<typeof configSchema>;
export type ParsedService = z.infer<typeof serviceSchema>;
export type ParsedTask = z.infer<typeof taskSchema>;
export type ParsedGroup = z.infer<typeof groupSchema>;
export type ParsedOverride = z.infer<typeof composeOverrideSchema>;
export type ParsedCheck = z.infer<typeof healthcheck>;

function linePos(value: unknown): { line?: number; col?: number } {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const point = Array.isArray(value) ? value[0] : 'start' in value ? value.start : value;
  if (!point || typeof point !== 'object') {
    return {};
  }
  const line = 'line' in point && typeof point.line === 'number' ? point.line : undefined;
  const col = 'col' in point && typeof point.col === 'number' ? point.col : undefined;
  return { line, col };
}

export function parseConfig(source: string): ParsedConfig {
  const doc = parseDocument(source, { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length > 0) {
    const error = doc.errors[0]!;
    const where = linePos(error.linePos);
    const prefix = where.line === undefined ? '' : `line ${where.line}: `;
    throw new AppError('INVALID_CONFIG', `${prefix}${error.message}`, where);
  }
  const raw = doc.toJS({ maxAliasCount: 100 });
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_CONFIG', 'Config must be a YAML mapping.');
  }
  try {
    return configSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new AppError('INVALID_CONFIG', message, {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    throw error;
  }
}
