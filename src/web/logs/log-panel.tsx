import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Filter, Maximize2, Minimize2, Minus, Plus, Search, Terminal, WrapText, X } from 'lucide-react';
import type { EntryStatus } from '../../shared/types.js';
import { Button } from '../components/button.js';
import { Input } from '../components/input.js';
import { Tabs, TabsList, TabsTrigger } from '../components/tabs.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/dropdown-menu.js';
import { entryLabel, STATE_LABEL } from '../labels.js';
import type { RetainedLogs } from './retain.js';
import { displayLines, explicitSeverity, filterRecords, findMatches, formatTime, responseTokens, type DisplayLine, type Match, type ReadingAnchor } from './view.js';

export type LogViewState = {
  follow: boolean; newRecords: number; query: string; mode: 'find' | 'filter'; wrap: boolean;
  selectedMatch: string | null; anchor: ReadingAnchor | null; filterAnchor: ReadingAnchor | null; positionNotice: boolean;
};
export type LogTab = RetainedLogs & LogViewState & { entryId: string; loaded: boolean };

export function LogPanel({ tabs, activeId, entries, projectNames, onSelect, onClose, onHide, onViewChange, eventState, onOpenEntry, expanded = false, onExpand }: {
  tabs: LogTab[]; activeId: string | null; entries: EntryStatus[]; projectNames: Record<string, string>;
  onSelect: (id: string) => void; onClose: (id: string) => void; onHide: () => void;
  onViewChange: (id: string, patch: Partial<LogViewState>) => void;
  eventState: 'connecting' | 'live' | 'reconnecting'; onOpenEntry: (id: string) => void;
  expanded?: boolean; onExpand?: () => void;
}) {
  const active = tabs.find(tab => tab.entryId === activeId);
  const entry = entries.find(item => item.id === activeId);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const dock = useRef<HTMLElement>(null);
  const programmaticTop = useRef<number | null>(null);
  const [below, setBelow] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const [searchNotice, setSearchNotice] = useState('');
  const visible = useMemo(() => active?.mode === 'filter' ? filterRecords(active.records, active.query) : active?.records ?? [], [active?.records, active?.mode, active?.query]);
  const lines = useMemo(() => displayLines(visible), [visible]);
  const matches = useMemo(() => findMatches(lines, active?.query ?? ''), [lines, active?.query]);
  const matchesByLine = useMemo(() => {
    const result = new Map<string, Match[]>();
    for (const match of matches) { const group = result.get(match.lineKey) ?? []; group.push(match); result.set(match.lineKey, group); }
    return result;
  }, [matches]);
  let selectedIndex = matches.findIndex(match => match.key === active?.selectedMatch);
  if (selectedIndex < 0 && active?.selectedMatch) {
    const previous = active.selectedMatch.split(':').slice(-3).map(Number);
    selectedIndex = matches.findIndex(match => {
      const next = match.key.split(':').slice(-3).map(Number);
      return next[0]! > previous[0]! || (next[0] === previous[0] && (next[1]! > previous[1]! || (next[1] === previous[1] && next[2]! >= previous[2]!)));
    });
  }
  selectedIndex = Math.max(0, selectedIndex);
  const selected = matches[selectedIndex];
  function update(patch: Partial<LogViewState>) { if (active) onViewChange(active.entryId, patch); }
  function assignScroll(top: number) {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = top;
    programmaticTop.current = node.scrollTop;
    setBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 24);
  }
  function capture(): ReadingAnchor | null {
    const node = scroller.current;
    if (!node) return null;
    const children = Array.from(node.querySelectorAll<HTMLElement>('[data-line-key]'));
    const line = children.find(child => child.offsetTop + child.offsetHeight > node.scrollTop);
    return line ? { key: line.dataset.lineKey!, offset: line.offsetTop - node.scrollTop } : null;
  }
  useLayoutEffect(() => {
    dock.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setCopyNotice('');
    setSearchNotice('');
  }, [activeId]);
  useLayoutEffect(() => {
    if (!active || !scroller.current) return;
    const node = scroller.current;
    const restore = () => {
      if (active.follow) { assignScroll(node.scrollHeight); return; }
      const anchor = active.mode === 'filter' ? active.filterAnchor : active.anchor;
      const children = Array.from(node.querySelectorAll<HTMLElement>('[data-line-key]'));
      const line = children.find(child => child.dataset.lineKey === anchor?.key);
      if (line && anchor) assignScroll(line.offsetTop - anchor.offset);
      else if (anchor && children.length) {
        assignScroll(0);
        // A filter can hide a valid line. Only retention warrants a loss notice.
        const retained = displayLines(active.records).some(item => item.key === anchor.key);
        const next = { key: children[0]!.dataset.lineKey!, offset: 0 };
        update({ [active.mode === 'filter' ? 'filterAnchor' : 'anchor']: next, ...(!retained ? { positionNotice: true } : {}) });
      } else assignScroll(0);
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeId, active?.records, active?.follow, active?.mode, active?.query, active?.wrap, active?.anchor, active?.filterAnchor, expanded]);
  useLayoutEffect(() => {
    if (!active || !active.query) return;
    if (active.selectedMatch !== (selected?.key ?? null)) update({ selectedMatch: selected?.key ?? null });
  }, [selected?.key, active?.selectedMatch, activeId]);
  if (!active || !entry) return null;
  const label = entryLabel(entry, projectNames[entry.projectId] ?? entry.projectId);
  const anchorField = active.mode === 'filter' ? 'filterAnchor' : 'anchor';
  function latest() { update({ follow: true, newRecords: 0 }); assignScroll(scroller.current?.scrollHeight ?? 0); }
  function navigate(direction: number) {
    if (!matches.length) return;
    const index = active!.selectedMatch ? (selectedIndex + direction + matches.length) % matches.length : direction > 0 ? 0 : matches.length - 1;
    const match = matches[index]!;
    update({ follow: false, selectedMatch: match.key });
    setSearchNotice(`Selected match ${index + 1} of ${matches.length}.`);
    const node = scroller.current;
    const line = Array.from(node?.querySelectorAll<HTMLElement>('[data-line-key]') ?? []).find(item => item.dataset.lineKey === match.lineKey);
    if (node && line) {
      assignScroll(Math.max(0, line.offsetTop - node.clientHeight / 3));
      const occurrence = Array.from(line.querySelectorAll<HTMLElement>('[data-match-key]')).find(item => item.dataset.matchKey === match.key);
      if (occurrence) {
        const bounds = occurrence.getBoundingClientRect();
        const viewport = node.getBoundingClientRect();
        if (bounds.left < viewport.left || bounds.right > viewport.right) node.scrollLeft += bounds.left - viewport.left - node.clientWidth / 3;
      }
      update({ [anchorField]: capture() });
    }
  }
  function mode(value: 'find' | 'filter') {
    if (value !== active!.mode) update({ mode: value, [anchorField]: capture(), follow: false });
  }
  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(visible.map(record => `${formatTime(record.timestamp)} ${record.containerId ? `[${record.containerId}] ` : ''}${record.text || (record.stream === 'gap' ? 'Log history has a gap.' : '')}`).join('\n'));
      setCopyNotice('Copied displayed logs.');
    } catch { setCopyNotice('Could not copy logs. Check browser clipboard access.'); }
  }
  return <section ref={dock} className="log-dock flex h-full min-h-0 flex-col" aria-label="Service logs" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); }
  }}>
    <div className="log-header">
      <Tabs value={active.entryId} onValueChange={onSelect} className="min-w-0 flex-1">
        <TabsList className="log-tabs" aria-label="Open service logs">{tabs.map(tab => {
          const item = entries.find(item => item.id === tab.entryId);
          if (!item) return null;
          const name = entryLabel(item, projectNames[item.projectId] ?? item.projectId);
          return <div key={tab.entryId} className="log-tab" data-active={tab.entryId === active.entryId}>
            <TabsTrigger value={tab.entryId} aria-label={name} title={name} className="log-tab-trigger"><Terminal aria-hidden="true" /><span className="log-tab-name">{item.name}<span className="log-tab-project">{projectNames[item.projectId] ?? item.projectId}</span></span></TabsTrigger>
            <button type="button" className="log-close" aria-label={`Close logs for ${name}`} title={`Close logs for ${name}`} onClick={() => onClose(tab.entryId)}><X aria-hidden="true" /></button>
          </div>;
        })}</TabsList>
      </Tabs>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Open logs" title="Open logs"><Plus aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-80 max-w-[90vw] overflow-auto">{entries.map(item => <DropdownMenuItem key={item.id} onSelect={() => onOpenEntry(item.id)}><Terminal aria-hidden="true" className="size-4" />{entryLabel(item, projectNames[item.projectId] ?? item.projectId)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      <div className="log-panel-actions">
        <Button variant="ghost" size="icon" aria-label={expanded ? 'Restore logs' : 'Maximize logs'} title={expanded ? 'Restore logs' : 'Maximize logs'} onClick={onExpand}>{expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</Button>
        <Button variant="ghost" size="icon" aria-label="Hide log panel" title="Hide log panel" onClick={onHide}><Minus aria-hidden="true" /></Button>
      </div>
    </div>
    <div className="log-toolbar">
      <div className="log-search-row">
        <div className="log-modes" role="group" aria-label="Search mode"><Button variant="ghost" size="sm" aria-pressed={active.mode === 'find'} onClick={() => mode('find')}><Search aria-hidden="true" />Find</Button><Button variant="ghost" size="sm" aria-pressed={active.mode === 'filter'} onClick={() => mode('filter')}><Filter aria-hidden="true" />Filter</Button></div>
        <div className="log-search"><Search className="log-search-icon" aria-hidden="true" /><Input ref={search} aria-label="Search logs" placeholder={active.mode === 'find' ? 'Find in logs…' : 'Filter logs…'} value={active.query} spellCheck={false} onChange={event => {
        const query = event.target.value;
        update({ query });
        if (!query) setSearchNotice('Search cleared.');
        else if (active.mode === 'filter') setSearchNotice(`Filter active. ${filterRecords(active.records, query).filter(record => record.stream !== 'boundary' && record.stream !== 'gap').length} matching records.`);
        else setSearchNotice(`${findMatches(displayLines(active.records), query).length} text matches.`);
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); update({ query: '', selectedMatch: null }); setSearchNotice('Search cleared.'); }
        if (event.key === 'Enter' && active.mode === 'find') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
      }} />
      <span aria-live="off" className="log-match-count">{active.mode === 'filter' ? `Filter active · ${visible.filter(record => record.stream !== 'boundary' && record.stream !== 'gap').length} matching records` : active.query ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : '0 matches' : ''}</span>
      {active.mode === 'find' ? <><Button variant="ghost" size="icon" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => navigate(-1)}><ArrowUp aria-hidden="true" /></Button><Button variant="ghost" size="icon" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => navigate(1)}><ArrowDown aria-hidden="true" /></Button></> : null}
      <Button variant="ghost" size="icon" aria-label="Clear search" title="Clear search (Escape)" disabled={!active.query} onClick={() => { update({ query: '', selectedMatch: null }); setSearchNotice('Search cleared.'); }}><X aria-hidden="true" /></Button></div>
      </div>
      <div className="log-options">
        <div className="log-reading-controls" role="group" aria-label="Log display"><Button variant="ghost" size="sm" aria-label="Wrap lines" aria-pressed={active.wrap} onClick={() => update({ wrap: !active.wrap })}><WrapText aria-hidden="true" />Wrap lines</Button>
        <Button variant="ghost" size="sm" aria-label="Follow latest" aria-pressed={active.follow} onClick={() => active.follow ? update({ follow: false, [anchorField]: capture() }) : latest()}><ArrowDown aria-hidden="true" />Follow latest</Button></div>
        <Button variant="ghost" size="sm" aria-label="Copy displayed logs" disabled={!visible.length} title="Copy all displayed records, including output outside the viewport. Find keeps all records; Filter copies matching records and history boundaries." onClick={() => void copyLogs()}><Copy aria-hidden="true" />Copy logs</Button></div>
    </div>
    {active.gap || active.trimmed ? <p className="log-notice">{active.gap ? 'Some earlier records are unavailable. ' : ''}{active.trimmed ? 'Older records were removed from this viewer. ' : ''}Showing {active.records.length} retained records.</p> : null}
    {active.positionNotice ? <p className="log-notice">The saved reading position is no longer available. Showing the oldest available output. <button onClick={() => update({ positionNotice: false })}>Dismiss</button></p> : null}
    {active.error ? <p role="alert" className="log-notice">Logs are unavailable. {active.error}</p> : null}
    {copyNotice ? <p role="status" className="log-notice">{copyNotice}</p> : null}
    <p role="status" className="sr-only">{searchNotice}</p>
    <div className="log-viewport min-h-0 flex-1">
      <div ref={scroller} role="log" aria-live="off" aria-label={`Logs for ${label}`} className={`log-output ${active.wrap ? 'log-wrap' : ''}`} onScroll={event => {
        const node = event.currentTarget;
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
        setBelow(!atBottom);
        if (programmaticTop.current !== null && Math.abs(node.scrollTop - programmaticTop.current) <= 1) { programmaticTop.current = null; return; }
        programmaticTop.current = null;
        update({ [anchorField]: capture(), ...(active.follow && !atBottom ? { follow: false } : {}), ...(atBottom ? { newRecords: 0 } : {}) });
      }}>
        {lines.map(line => <LogLine key={line.key} line={line} matches={matchesByLine.get(line.key) ?? []} selected={selected?.key} />)}
        {!active.loaded && !active.error ? <p>Loading logs.</p> : active.loaded && !active.records.length && !active.error ? <p>No retained output.</p> : null}
        {active.mode === 'filter' && active.query && !visible.some(record => record.stream !== 'gap' && record.stream !== 'boundary') && active.records.length > 0 ? <p>No records match this filter.</p> : null}
      </div>
      {!active.follow && (below || active.newRecords > 0) ? <Button className="log-latest" size="sm" title="Count includes all accepted new records, including records hidden by Filter." onClick={latest}><ArrowDown aria-hidden="true" />{active.newRecords > 0 ? `${active.newRecords} new records · ` : ''}Go to latest</Button> : null}
    </div>
    <footer className="log-footer"><span className="log-status-group"><span className="log-service-state" data-state={entry.state} aria-label="Service state"><span className="log-status-dot" aria-hidden="true" />{STATE_LABEL[entry.state]}</span><span className="log-connection" data-state={eventState} role="status" aria-label="Event connection">{eventState === 'live' ? 'Live' : eventState === 'connecting' ? 'Connecting' : 'Reconnecting'}</span><span>{active.follow ? 'Following' : 'Paused'}</span></span><span className="log-footer-context" title={label}>{label}</span><span className="log-record-count">{active.records.length} retained records</span></footer>
  </section>;
}

function LogLine({ line, matches, selected }: { line: DisplayLine; matches: Match[]; selected?: string }) {
  const prefix = line.time.length + 1 + line.container.length;
  const tokens = responseTokens(line.message).map(token => ({ ...token, start: token.start + prefix, end: token.end + prefix }));
  const render = (start: number, end: number) => {
    const boundaries = [...new Set([start, end, ...matches.flatMap(m => [m.start, m.end]), ...tokens.flatMap(t => [t.start, t.end])])].filter(value => value >= start && value <= end).sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((offset, index) => {
      const match = matches.find(m => m.start <= offset && m.end > offset);
      const token = tokens.find(t => t.start <= offset && t.end > offset);
      return <span key={offset} data-match-key={match?.key} className={[match ? 'log-match' : '', match && match.key === selected ? 'log-match-selected' : '', token ? `log-http-${token.kind}` : ''].join(' ')}>{line.text.slice(offset, boundaries[index + 1])}</span>;
    });
  };
  const date = new Date(line.record.timestamp);
  const title = Number.isNaN(date.getTime()) ? line.record.timestamp : `${date.toLocaleString([], { hour12: false, timeZoneName: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  const severity = explicitSeverity(line.message);
  return <p data-line-key={line.key} className={`log-display-line ${line.record.stream === 'boundary' || line.record.stream === 'gap' ? 'log-line-boundary' : ''} ${severity ? `log-line-${severity}` : ''}`}>
    <time className="log-line-time" title={title} dateTime={line.record.timestamp}>{render(0, line.time.length)}</time><span className="log-line-container">{render(line.time.length, prefix)}</span><span className="log-message">{render(prefix, line.text.length)}</span>
  </p>;
}
