import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIcon, BoxIcon, CopyIcon, FolderIcon, RotateCwIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { useGroupRef, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import type { Action, EntryStatus, ErrorData, LogRecord, Operation, RuntimeEvent, Snapshot } from '../shared/types.js';
import { ApiError, getConfigPath, getLogs, getOperation, getStatus, isLogRecord, isOperation, parseEvent, reloadConfig, submitEntryAction, submitTargetAction } from './api.js';
import { Button } from './components/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/dropdown-menu.js';
import { Input } from './components/input.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/resizable.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/select.js';
import { TooltipProvider } from './components/tooltip.js';
import { commandLabel, displayHealth, entryLabel, HEALTH_LABEL, STATE_LABEL } from './labels.js';
import { LogPanel, type LogTab, type LogViewState } from './logs/log-panel.js';
import { appendLive, HISTORY_TAIL, joinHistory, rememberLive } from './logs/retain.js';
import { ServiceTable, type ServiceRow } from './table/service-table.js';

type Connection = 'loading' | 'connected' | 'disconnected';
type TargetKind = 'projects' | 'compose-groups';
type TargetStop = { kind: TargetKind; id: string };

const LOG_PANEL_PERCENT_KEY = 'servicemon.log-panel-percent';
const DEFAULT_LOG_PERCENT = 32;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [eventState, setEventState] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorData | null>(null);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('all');
  const [panelOpen, setPanelOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logPercent, setLogPercent] = useState(readLogPercent);
  const [tabs, setTabs] = useState<LogTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState<TargetStop | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const cursorRef = useRef(0);
  const liveLogs = useRef(new Map<string, LogRecord[]>());
  const tabsRef = useRef(tabs);
  const groupRef = useGroupRef();
  const splitRef = useRef({ open: false, expanded: false });
  const logPercentRef = useRef(logPercent);
  const entriesRef = useRef<EntryStatus[]>([]);
  tabsRef.current = tabs;
  logPercentRef.current = logPercent;
  entriesRef.current = snapshot?.entries ?? [];

  useLayoutEffect(() => {
    if (!panelOpen) return;
    const logs = logsExpanded ? 100 : logPercentRef.current;
    // Conditional panels register in a second layout update.
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout({ table: 100 - logs, logs });
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRef, logsExpanded, panelOpen]);

  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot((current) => !current || next.cursor >= current.cursor ? next : current);
    cursorRef.current = Math.max(cursorRef.current, next.cursor);
    setConnection('connected');
    setLoadError(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      applySnapshot(await getStatus());
    } catch (error) {
      setConnection('disconnected');
      setLoadError(error instanceof Error ? error.message : 'Manager is unavailable.');
    }
  }, [applySnapshot]);

  const refreshLogs = useCallback(async (entryId: string, after?: number) => {
    try {
      const history = await getLogs(entryId, after === undefined ? { tail: HISTORY_TAIL } : { after, tail: HISTORY_TAIL });
      setTabs((current) => current.map((tab) => {
        if (tab.entryId !== entryId) return tab;
        if (after === undefined) {
          const joined = joinHistory(history, liveLogs.current.get(entryId) ?? []);
          const arrivals = tab.loaded ? joined.records.filter(record => record.sequence > tab.cursor).length : 0;
          return { ...tab, ...joined, loaded: true, gap: tab.gap || joined.gap, trimmed: tab.trimmed || joined.trimmed, newRecords: tab.follow ? 0 : tab.newRecords + arrivals, error: history.error };
        }
        let next = tab;
        for (const record of history.records) {
          const appended = appendLive(next, record);
          if (appended === 'gap') {
            // Catch-up can include a server gap. Join the available records without inventing missing output.
            const joined = joinHistory({ ...history, records: [...next.records, record], gap: true }, []);
            next = { ...next, ...joined, trimmed: next.trimmed || joined.trimmed, newRecords: next.follow ? 0 : next.newRecords + 1 };
          } else {
            const accepted = appended.cursor > next.cursor;
            next = { ...next, ...appended, trimmed: next.trimmed || appended.trimmed, newRecords: next.follow ? 0 : next.newRecords + Number(accepted) };
          }
        }
        return { ...next, loaded: true, gap: next.gap || history.gap, error: history.error };
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Logs are unavailable.';
      setTabs((current) => current.map((tab) => tab.entryId === entryId ? { ...tab, loaded: true, error: message } : tab));
    }
  }, []);

  const logCatchUp = useRef(new Map<string, { busy: boolean; again: boolean }>());
  const requestLogs = useCallback((entryId: string, after?: number) => {
    const state = logCatchUp.current.get(entryId) ?? { busy: false, again: false };
    logCatchUp.current.set(entryId, state);
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    void (async () => {
      let nextAfter = after;
      try {
        do {
          state.again = false;
          await refreshLogs(entryId, nextAfter);
          const tab = tabsRef.current.find((item) => item.entryId === entryId);
          nextAfter = tab && tab.cursor > 0 ? tab.cursor : undefined;
        } while (state.again);
      } finally {
        state.busy = false;
      }
    })();
  }, [refreshLogs]);

  const applyChange = useCallback((event: RuntimeEvent) => {
    if (event.cursor > cursorRef.current + 1) {
      void refreshStatus();
      for (const tab of tabsRef.current) requestLogs(tab.entryId, tab.cursor > 0 ? tab.cursor : undefined);
      cursorRef.current = event.cursor;
      return;
    }
    cursorRef.current = Math.max(cursorRef.current, event.cursor);
    if (event.type === 'gap') {
      void refreshStatus();
      for (const tab of tabsRef.current) requestLogs(tab.entryId, tab.cursor > 0 ? tab.cursor : undefined);
      return;
    }
    if (event.type === 'log' && isLogRecord(event.data)) {
      const record = event.data;
      if (!['service', 'task'].includes(entriesRef.current.find((entry) => entry.id === record.entryId)?.kind ?? '')) return;
      if (record.stream !== 'gap') rememberLive(liveLogs.current, record);
      setTabs((current) => current.map((tab) => {
        if (tab.entryId !== record.entryId) return tab;
        const next = appendLive(tab, record);
        if (next === 'gap') {
          requestLogs(tab.entryId, tab.cursor > 0 ? tab.cursor : undefined);
          return tab;
        }
        return { ...tab, ...next, trimmed: tab.trimmed || next.trimmed, newRecords: tab.follow || !tab.loaded ? 0 : tab.newRecords + Number(next.cursor > tab.cursor) };
      }));
      return;
    }
    if (event.type === 'state') applyState(setSnapshot, event.data);
    if (event.type === 'operation' && isOperation(event.data)) applyOperation(setSnapshot, event.data);
  }, [refreshStatus, requestLogs]);

  useEffect(() => {
    void refreshStatus();
    const source = new EventSource('/api/events');
    let opened = false;
    source.addEventListener('snapshot', (event) => {
      const parsed = parseEvent((event as MessageEvent<string>).data);
      if (parsed && 'entries' in parsed && 'cursor' in parsed) applySnapshot(parsed);
    });
    source.addEventListener('change', (event) => {
      const parsed = parseEvent((event as MessageEvent<string>).data);
      if (parsed && 'type' in parsed && 'cursor' in parsed) applyChange(parsed);
      else void refreshStatus();
    });
    source.onopen = () => {
      if (opened) {
        void refreshStatus();
        for (const tab of tabsRef.current) requestLogs(tab.entryId, tab.cursor > 0 ? tab.cursor : undefined);
      }
      opened = true;
      setEventState('live');
    };
    source.onerror = () => {
      setEventState('reconnecting');
      void refreshStatus();
    };
    return () => source.close();
  }, [applyChange, applySnapshot, refreshStatus, requestLogs]);

  useEffect(() => {
    if (!panelOpen) return;
    const timer = setInterval(() => {
      for (const tab of tabsRef.current) {
        if (entriesRef.current.find((entry) => entry.id === tab.entryId)?.kind !== 'compose') continue;
        requestLogs(tab.entryId, tab.cursor > 0 ? tab.cursor : undefined);
      }
    }, 400);
    return () => clearInterval(timer);
  }, [panelOpen, requestLogs]);
  useEffect(() => {
    if (!snapshot) return;
    const valid = tabsRef.current.filter(tab => snapshot.entries.some(entry => entry.id === tab.entryId));
    if (valid.length === tabsRef.current.length) return;
    setTabs(valid);
    if (!valid.some(tab => tab.entryId === activeId)) setActiveId(valid[0]?.entryId ?? null);
    if (!valid.length) hideLogs();
  }, [snapshot, activeId]);



  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const saveSplit = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || !splitRef.current.open || splitRef.current.expanded) return;
    const logs = layout.logs;
    if (!isSplitPercent(logs)) return;
    setLogPercent(logs);
    writeLogPercent(logs);
  }, []);

  const projects = snapshot?.projects ?? [];
  const groups = snapshot?.groups ?? [];
  const entries = snapshot?.entries ?? [];
  const operations = snapshot?.operations ?? [];
  const projectNames = useMemo(() => Object.fromEntries(projects.map((project) => [project.id, project.name])), [projects]);
  const rows = useMemo<ServiceRow[]>(() => entries
    .filter((entry) => projectId === 'all' || entry.projectId === projectId)
    .map((entry) => ({ entry, projectName: projectNames[entry.projectId] ?? entry.projectId, commandLabel: commandLabel(entry, groups) })), [entries, groups, projectId, projectNames]);
  const selectedProject = projects.find((project) => project.id === projectId);
  const details = entries.find((entry) => entry.id === detailsId) ?? null;
  const stopPrompt = pendingStop ? stopCopy(pendingStop, projects, groups) : null;

  async function runAction(work: () => Promise<string>) {
    setActionError(null);
    try {
      const operationId = await work();
      const operation = await watchOperation(operationId);
      if (operation.state === 'failed' && operation.error) setActionError(operation.error);
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.error : { code: 'MANAGER_UNAVAILABLE', message: error instanceof Error ? error.message : 'The action failed.' });
    }
  }

  function requestTargetAction(kind: TargetKind, id: string, action: Exclude<Action, 'run'>) {
    if (action === 'stop') {
      setPendingStop({ kind, id });
      return;
    }
    void runAction(() => submitTargetAction(kind, id, action));
  }

  function confirmStop() {
    if (!pendingStop) return;
    const pending = pendingStop;
    setPendingStop(null);
    void runAction(() => submitTargetAction(pending.kind, pending.id, 'stop'));
  }

  async function openLogs(id: string) {
    splitRef.current.open = true;
    setPanelOpen(true);
    setActiveId(id);
    if (!tabsRef.current.some((tab) => tab.entryId === id)) {
      const blank: LogTab = { entryId: id, follow: true, loaded: false, newRecords: 0, query: '', mode: 'find', wrap: false, selectedMatch: null, anchor: null, filterAnchor: null, positionNotice: false, records: [], cursor: 0, gap: false, trimmed: false };
      setTabs((current) => current.some((tab) => tab.entryId === id) ? current : [...current, blank]);
      await refreshLogs(id);
    }
  }

  function hideLogs() {
    splitRef.current = { open: false, expanded: false };
    setLogsExpanded(false);
    setPanelOpen(false);
    requestAnimationFrame(() => {
      const label = entries.find(entry => entry.id === activeId);
      const name = label ? `Logs for ${entryLabel(label, projectNames[label.projectId] ?? label.projectId)}` : '';
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === name);
      (button ?? searchRef.current)?.focus();
    });
  }

  function onExpandLogs() {
    const next = !logsExpanded;
    splitRef.current = { open: panelOpen, expanded: next };
    setLogsExpanded(next);
  }


  async function copyPath() {
    try {
      const path = snapshot?.configPath || await getConfigPath();
      await navigator.clipboard.writeText(path);
      setNotice('Copied config path.');
    } catch (error) {
      const path = snapshot?.configPath;
      setNotice(path ? `Copy failed. Config path: ${path}` : error instanceof Error ? error.message : 'Copy failed.');
    }
  }

  const table = snapshot ? (
    <ServiceTable
      rows={rows}
      globalFilter={query}
      onGlobalFilter={setQuery}
      selectedId={panelOpen ? activeId : null}
      operations={operations}
      groups={groups}
      onAction={(id, action) => void runAction(() => submitEntryAction(id, action))}
      onTargetAction={requestTargetAction}
      onLogs={(id) => void openLogs(id)}
      onDetails={setDetailsId}
      pageResetKey={`${projectId}:${query}`}
    />
  ) : null;

  return (
    <TooltipProvider>
      <div className={`app-shell flex h-full flex-col ${logsExpanded ? 'logs-expanded' : ''}`}>
        <header className="app-header flex shrink-0 flex-wrap items-center gap-4 border-b bg-background px-6 py-3">
          <div className="mr-4 flex items-center gap-2.5 text-base font-semibold tracking-tight"><span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><ActivityIcon className="size-4" aria-hidden="true" /></span>service<span className="-ml-2 text-muted-foreground">mon</span></div>
          <div className="relative min-w-56 max-w-xl flex-1">
            <SearchIcon className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" />
            <Input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search services and tasks" placeholder="Search services…" className="pr-14 pl-8" />
            <kbd className="pointer-events-none absolute top-1.5 right-2 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘ K</kbd>
          </div>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="ml-auto w-48" aria-label="Project"><FolderIcon className="size-4 text-muted-foreground" aria-hidden="true" /><SelectValue placeholder="All projects" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" aria-label="Settings"><SettingsIcon aria-hidden="true" />Settings</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void copyPath()}><CopyIcon className="size-4" aria-hidden="true" />Copy config path</DropdownMenuItem>
              <DropdownMenuItem disabled={reloadBusy} onSelect={() => void runAction(async () => { setReloadBusy(true); try { return await reloadConfig(); } finally { setReloadBusy(false); } })}><RotateCwIcon className="size-4" aria-hidden="true" />Reload config</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        {connection === 'disconnected' ? <p role="alert" className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">Manager is unavailable. {loadError} <button type="button" className="underline" onClick={() => window.location.reload()}>Retry</button> Start the manager, then retry. If its port changed, run <code>servicemon dashboard</code> to open the current URL.</p> : null}
        {snapshot?.reloadError ? <p role="alert" className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">Config reload failed. {snapshot.reloadError.message} The previous config is still active.</p> : null}
        {actionError ? <p role="alert" className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError.message}{actionError.operationId ? ` Operation ${actionError.operationId}.` : ''}</p> : null}
        {notice ? <p role="status" className="border-b px-3 py-2 text-sm">{notice}</p> : null}
        <div className="page-heading flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 py-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{selectedProject?.name ?? 'All services and tasks'}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage local services, tasks, and Compose groups.</p>
          </div>
        </div>
        <div className="page-content min-h-0 flex-1 px-6 pb-5">
          {connection === 'loading' && !snapshot ? <p className="px-3 py-8 text-sm text-muted-foreground" role="status">Loading services.</p> : null}
          {snapshot && projects.length === 0 ? <div className="flex h-full flex-col items-center justify-center rounded-xl border bg-background p-6 text-center"><BoxIcon className="mb-4 size-8 text-muted-foreground" aria-hidden="true" /><h2 className="text-base font-semibold">No projects are registered.</h2><p className="mt-2 max-w-sm text-sm text-muted-foreground">Add a project to your config file, then use Settings to reload the config.</p></div> : null}
          {snapshot && projects.length > 0 ? (
            <ResizablePanelGroup groupRef={groupRef} orientation="vertical" onLayoutChanged={saveSplit}>
              <ResizablePanel
                id="table"
                minSize="0%"
                maxSize="100%"
                inert={logsExpanded}
                defaultSize={panelOpen ? `${100 - logPercent}%` : '100%'}
              >{table}</ResizablePanel>
              {panelOpen ? <ResizableHandle withHandle disabled={logsExpanded} aria-label="Resize log panel" /> : null}
              {panelOpen ? (
                <ResizablePanel id="logs" minSize="0%" defaultSize={`${logPercent}%`} className="min-h-0">
                  <LogPanel
                    tabs={tabs}
                    activeId={activeId}
                    entries={entries}
                    projectNames={projectNames}
                    eventState={eventState}
                    onOpenEntry={(id) => void openLogs(id)}
                    expanded={logsExpanded}
                    onExpand={onExpandLogs}
                    onSelect={setActiveId}
                    onClose={(id) => {
                      const next = tabs.filter((tab) => tab.entryId !== id);
                      setTabs(next);
                      if (activeId === id) setActiveId(next[0]?.entryId ?? null);
                      if (next.length === 0) hideLogs();
                    }}
                    onHide={hideLogs}
                    onViewChange={(id: string, patch: Partial<LogViewState>) => setTabs((current) => current.map((tab) => tab.entryId === id ? { ...tab, ...patch } : tab))}
                  />
                </ResizablePanel>
              ) : null}
            </ResizablePanelGroup>
          ) : null}
        </div>
        <Dialog open={details !== null} onOpenChange={(open) => { if (!open) setDetailsId(null); }}>
          <DialogContent>
            {details ? <Details entry={details} projectName={projectNames[details.projectId] ?? details.projectId} groups={groups} operations={operations} /> : null}
          </DialogContent>
        </Dialog>
        <Dialog open={stopPrompt !== null} onOpenChange={(open) => { if (!open) setPendingStop(null); }}>
          <DialogContent>
            {stopPrompt ? (
              <>
                <DialogTitle>{stopPrompt.label}</DialogTitle>
                <DialogDescription>{stopPrompt.detail}</DialogDescription>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPendingStop(null)}>Cancel</Button>
                  <Button variant="destructive" onClick={confirmStop}>{stopPrompt.label}</Button>
                </div>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function stopCopy(pending: TargetStop, projects: Snapshot['projects'], groups: Snapshot['groups']): { label: string; detail: string } {
  if (pending.kind === 'projects') {
    const name = projects.find((project) => project.id === pending.id)?.name ?? pending.id;
    return { label: `Stop ${name} services`, detail: `This stops every service and task in ${name}.` };
  }
  const name = groups.find((group) => group.id === pending.id)?.name ?? pending.id;
  return { label: `Stop ${name} group`, detail: `This stops every service in Compose group ${name}.` };
}

function Details({ entry, projectName, groups, operations }: { entry: EntryStatus; projectName: string; groups: Snapshot['groups']; operations: Operation[] }) {
  const failed = operations.filter((operation) => operation.state === 'failed' && (operation.target.entry === entry.id || operation.affected.includes(entry.id) || operation.error?.entryId === entry.id));
  const group = groups.find((item) => item.id === entry.composeGroupId);
  const command = entry.command || executionCommand(entry.execution);
  const check = checkText(entry);
  return (
    <>
      <DialogTitle>{entryLabel(entry, projectName)}</DialogTitle>
      <DialogDescription>{entry.id}</DialogDescription>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">State</dt><dd>{STATE_LABEL[entry.state]}</dd>
        <dt className="text-muted-foreground">Health</dt><dd>{HEALTH_LABEL[displayHealth(entry)]}</dd>
        {check ? <><dt className="text-muted-foreground">Check</dt><dd className="break-all">{check}</dd></> : null}
        <dt className="text-muted-foreground">Command</dt><dd className="break-all font-mono text-xs">{command || '—'}</dd>
        <dt className="text-muted-foreground">Directory</dt><dd className="break-all">{entry.directory}</dd>
        {group ? (
          <>
            <dt className="text-muted-foreground">Compose file</dt><dd className="break-all">{composeFilePath(group)}</dd>
            <dt className="text-muted-foreground">Compose directory</dt><dd className="break-all">{group.directory}</dd>
            <dt className="text-muted-foreground">Compose project</dt><dd>{group.projectName}</dd>
            <dt className="text-muted-foreground">Compose service</dt><dd>{entry.composeService || '—'}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Notes</dt><dd>{entry.notes || '—'}</dd>
        <dt className="text-muted-foreground">Links</dt>
        <dd>
          {entry.links.length === 0 ? '—' : (
            <ul className="space-y-1">
              {entry.links.map((link) => <li key={link}><a className="break-all text-ring underline" href={link} target="_blank" rel="noreferrer">{link}</a></li>)}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground">Exit</dt>
        <dd>{entry.exit ? `${entry.exit.code === null ? entry.exit.signal ?? 'no code' : `code ${entry.exit.code}`} at ${entry.exit.at}` : '—'}</dd>
        <dt className="text-muted-foreground">Blocked</dt>
        <dd>{entry.error || failed.map((operation) => operation.error?.message).filter(Boolean).join(' ') || '—'}</dd>
      </dl>
    </>
  );
}


function checkText(entry: EntryStatus): string | null {
  const check = entry.healthcheck;
  if (!check) return null;
  if (check.type === 'http') return `HTTP ${check.url}`;
  if (check.type === 'tcp') return `TCP ${check.host}:${check.port}`;
  return `Command ${check.command}`;
}


function executionCommand(execution: unknown): string {
  if (!execution || typeof execution !== 'object') return '';
  const record = execution as Record<string, unknown>;
  const direct = commandText(record.command);
  if (direct) return direct;
  const nested = record.discovered ?? record.definition;
  if (!nested || typeof nested !== 'object') return '';
  const fields = nested as Record<string, unknown>;
  const command = commandText(fields.command);
  const entrypoint = commandText(fields.entrypoint);
  if (entrypoint && command) return `${entrypoint} ${command}`;
  return command || entrypoint;
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
  return '';
}

function composeFilePath(group: Snapshot['groups'][number]): string {
  if (group.file.startsWith('/')) return group.file;
  return `${group.directory.replace(/\/$/, '')}/${group.file}`;
}

function readLogPercent(): number {
  try {
    const raw = localStorage.getItem(LOG_PANEL_PERCENT_KEY);
    if (raw == null || raw.trim() === '') return DEFAULT_LOG_PERCENT;
    const value = Number(raw);
    return isSplitPercent(value) ? value : DEFAULT_LOG_PERCENT;
  } catch {
    return DEFAULT_LOG_PERCENT;
  }
}

function writeLogPercent(value: number): void {
  if (!isSplitPercent(value)) return;
  try {
    localStorage.setItem(LOG_PANEL_PERCENT_KEY, String(value));
  } catch {
    // Private mode or a full store must not break the split.
  }
}

function isSplitPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}



async function watchOperation(id: string): Promise<Operation> {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const operation = await getOperation(id);
    if (operation.state === 'succeeded' || operation.state === 'failed') return operation;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  return getOperation(id);
}

function applyState(setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | null>>, data: unknown) {
  if (!data || typeof data !== 'object') return;
  if ('entries' in data && Array.isArray((data as Snapshot).entries)) {
    setSnapshot((current) => current ? { ...current, ...(data as Partial<Snapshot>), entries: (data as Snapshot).entries } : current);
    return;
  }
  const entry = data as Partial<EntryStatus>;
  if (typeof entry.id !== 'string' || typeof entry.state !== 'string') return;
  setSnapshot((current) => current ? { ...current, entries: current.entries.map((item) => item.id === entry.id ? { ...item, ...entry } : item) } : current);
}

function applyOperation(setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | null>>, operation: Operation) {
  setSnapshot((current) => {
    if (!current) return current;
    const exists = current.operations.some((item) => item.id === operation.id);
    return { ...current, operations: exists ? current.operations.map((item) => item.id === operation.id ? operation : item) : [operation, ...current.operations] };
  });
}
