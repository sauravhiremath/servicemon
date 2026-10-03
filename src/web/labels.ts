import type { ComposeGroup, EntryState, EntryStatus, Health } from '../shared/types.js';

export const PAGE_SIZE = 20;

export const STATE_LABEL: Record<EntryState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exited: 'Exited',
  idle: 'Idle',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

type DisplayHealth = Exclude<Health, 'no-check'> | 'none';

export function displayHealth(entry: EntryStatus): DisplayHealth {
  if (entry.kind === 'task') return 'not-applicable';
  if ((entry.kind === 'service' && !entry.healthcheck) || entry.health === 'no-check') return 'none';
  if (entry.state === 'stopped' || entry.state === 'exited' || entry.state === 'failed') return 'none';
  return entry.health;
}

export const HEALTH_LABEL: Record<DisplayHealth, string> = {
  'not-applicable': 'N/A',
  none: '-',
  checking: 'Checking',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
};

export const KIND_LABEL: Record<EntryStatus['kind'], string> = {
  service: 'Service',
  task: 'Task',
  compose: 'Compose',
};

export const STATE_OPTIONS = (Object.keys(STATE_LABEL) as EntryState[]).map((value) => ({ value, label: STATE_LABEL[value] }));
export const HEALTH_OPTIONS = (Object.keys(HEALTH_LABEL) as DisplayHealth[]).map((value) => ({ value, label: HEALTH_LABEL[value] }));
export const TYPE_OPTIONS = (Object.keys(KIND_LABEL) as Array<EntryStatus['kind']>).map((value) => ({ value, label: KIND_LABEL[value] }));

export type StatusTone = 'neutral' | 'progress' | 'good' | 'bad';

export function stateTone(state: EntryState): StatusTone {
  if (state === 'stopped' || state === 'idle') return 'neutral';
  if (state === 'starting' || state === 'stopping') return 'progress';
  if (state === 'running' || state === 'succeeded') return 'good';
  return 'bad';
}

export function healthTone(health: DisplayHealth): StatusTone {
  if (health === 'healthy') return 'good';
  if (health === 'unhealthy') return 'bad';
  if (health === 'checking') return 'progress';
  return 'neutral';
}

export function actionProgress(action: string): string {
  if (action === 'start') return 'Starting';
  if (action === 'stop') return 'Stopping';
  if (action === 'restart') return 'Restarting';
  if (action === 'run') return 'Run in progress';
  return 'In progress';
}

export function commandLabel(entry: EntryStatus, groups: readonly ComposeGroup[]): string {
  if (entry.kind === 'compose') {
    const group = groups.find((item) => item.id === entry.composeGroupId);
    return group?.file || group?.name || entry.composeService || entry.command || '';
  }
  return entry.command ?? '';
}

export function entryLabel(entry: EntryStatus, projectName: string): string {
  return `${projectName}/${entry.name}`;
}
