export type Health =
  | 'not-applicable'
  | 'no-check'
  | 'checking'
  | 'healthy'
  | 'unhealthy'
  | 'unknown';
export type EntryState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'idle'
  | 'succeeded'
  | 'failed';
export type Check =
  | {
      type: 'http';
      url: string;
      expected_status?: number;
      interval_seconds?: number;
      timeout_seconds?: number;
    }
  | { type: 'tcp'; host: string; port: number; interval_seconds?: number; timeout_seconds?: number }
  | { type: 'command'; command: string; interval_seconds?: number; timeout_seconds?: number };
export interface Entry {
  id: string;
  projectId: string;
  key: string;
  name: string;
  kind: 'service' | 'task' | 'compose';
  directory: string;
  command?: string;
  notes?: string;
  links: string[];
  dependsOn: string[];
  autostart: boolean;
  restartDependencies: boolean;
  restartDependents: boolean;
  healthcheck?: Check;
  stopSeconds: number;
  readinessSeconds: number;
  composeGroupId?: string;
  composeService?: string;
  execution?: unknown;
}
export interface Project {
  id: string;
  name: string;
  directory: string;
  notes?: string;
}
export interface ComposeGroup {
  id: string;
  projectId: string;
  key: string;
  name: string;
  directory: string;
  file: string;
  projectName: string;
  autostart: boolean;
  overrides: Record<string, Record<string, unknown>>;
  services?: Record<string, unknown>;
}
export interface CompiledConfig {
  path: string;
  source: string;
  raw: Record<string, unknown>;
  port: number;
  logs: { perEntryBytes: number; totalBytes: number };
  stopSeconds: number;
  readinessSeconds: number;
  projects: Project[];
  entries: Entry[];
  groups: ComposeGroup[];
}
export interface ExitDetails {
  code: number | null;
  signal: string | null;
  at: string;
}
export interface EntryStatus extends Entry {
  state: EntryState;
  health: Health;
  runId?: string;
  pid?: number;
  exit?: ExitDetails;
  error?: string;
  containers?: unknown[];
}
export interface LogRecord {
  entryId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'boundary' | 'gap';
  text: string;
  containerId?: string;
}
export interface LogHistory {
  records: LogRecord[];
  cursor: number;
  oldestCursor: number;
  gap: boolean;
  error?: string;
}
export type Action = 'start' | 'stop' | 'restart' | 'run';
export interface Target {
  entry?: string;
  project?: string;
  compose?: string;
}
export interface ErrorData {
  code: string;
  message: string;
  entryId?: string;
  operationId?: string;
  details?: unknown;
}
export interface Operation {
  id: string;
  action: string;
  target: Target;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  affected: string[];
  startedAt: string;
  finishedAt?: string;
  error?: ErrorData;
  data?: unknown;
}
export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: ErrorData };
export interface Snapshot {
  projects: Project[];
  entries: EntryStatus[];
  groups: ComposeGroup[];
  operations: Operation[];
  configPath: string;
  reloadError?: ErrorData;
  cursor: number;
}
export interface RuntimeEvent {
  cursor: number;
  type: 'state' | 'operation' | 'log' | 'gap';
  data: unknown;
}
export interface Adapter {
  status(id: string): EntryStatus;
  start(entry: Entry, environment: NodeJS.ProcessEnv): Promise<void>;
  stop(entry: Entry): Promise<void>;
  ready(entry: Entry): Promise<boolean>;
  update?(entries: Entry[]): void;
  shutdown(): Promise<void>;
}
