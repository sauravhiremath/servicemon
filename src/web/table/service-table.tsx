import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  createColumnHelper,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createSortedRowModel,
  columnFacetingFeature,
  columnFilteringFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  FlexRender,
  type Header,
  type Row,
  type SortingState,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpIcon, BoxIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, FolderIcon, LayersIcon, LoaderCircleIcon, PlayIcon, RotateCwIcon, SearchXIcon, ServerIcon, SquareIcon, TerminalIcon, ScrollTextIcon } from 'lucide-react';
import type { Action, EntryState, EntryStatus, Operation, Snapshot } from '../../shared/types.js';
import { Button } from '../components/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/dropdown-menu.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/tooltip.js';
import { HEALTH_LABEL, HEALTH_OPTIONS, KIND_LABEL, PAGE_SIZE, STATE_LABEL, STATE_OPTIONS, TYPE_OPTIONS, actionProgress, displayHealth, entryLabel, healthTone, stateTone, type StatusTone } from '../labels.js';
import { cn } from '../lib/utils.js';
import { ColumnMenu, CountFilter, FacetedFilter, TextFilter, ViewToggle, type FilterColumn, type FilterOption } from './filters.js';

export type ServiceRow = {
  entry: EntryStatus;
  projectName: string;
  commandLabel: string;
};

type TargetKind = 'projects' | 'compose-groups';
type TargetAction = Exclude<Action, 'run'>;

type TableMeta = {
  busy: (id: string) => Operation | undefined;
  onAction: (id: string, action: Action) => void;
  onLogs: (id: string) => void;
  onDetails: (id: string) => void;
  onCopy: (value: string) => void;
  grouped: boolean;
};

const features = tableFeatures({
  columnFilteringFeature,
  columnFacetingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  tableMeta: {} as TableMeta,
});

const helper = createColumnHelper<typeof features, ServiceRow>();
const GROUPED_SORT: SortingState = [
  { id: 'project', desc: false },
  { id: 'projectId', desc: false },
  { id: 'composeGroup', desc: false },
  { id: 'name', desc: false },
];

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  progress: 'text-amber-700',
  good: 'text-green-700',
  bad: 'text-red-700',
};
const TONE_DOT: Record<StatusTone, string> = {
  neutral: 'bg-zinc-400',
  progress: 'bg-amber-500',
  good: 'bg-green-500',
  bad: 'bg-red-500',
};

function matchesSelection(row: Row<typeof features, ServiceRow>, columnId: string, value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.includes(String(row.getValue(columnId)));
}

function asFilterColumn(column: { getFilterValue?: () => unknown; setFilterValue?: (value: unknown) => void; getFacetedUniqueValues?: () => Map<unknown, number> }): FilterColumn {
  return column as FilterColumn;
}

function resetPage(table: { setPageIndex: (index: number) => void }): void {
  table.setPageIndex(0);
}

function columnTitle(title: string, context: { column: { getCanSort: () => boolean; getIsSorted: () => false | 'asc' | 'desc'; getToggleSortingHandler: () => ((event: unknown) => void) | undefined }; table: { options: { meta?: TableMeta } } }, filter: ReactNode) {
  const grouped = context.table.options.meta?.grouped ?? true;
  const sorted = context.column.getIsSorted();
  const canSort = !grouped && context.column.getCanSort();
  return (
    <div className="column-heading flex min-w-0 items-center gap-1">
      {canSort ? (
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 rounded-sm font-medium focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={sorted ? `Sort ${title} ${sorted === 'asc' ? 'ascending' : 'descending'}` : `Sort ${title}`}
          onClick={context.column.getToggleSortingHandler()}
        >
          <span className="truncate">{title}</span>
          {sorted === 'asc' ? <ArrowUpIcon aria-hidden="true" /> : sorted === 'desc' ? <ArrowDownIcon aria-hidden="true" /> : null}
        </button>
      ) : (
        <span className="truncate font-medium">{title}</span>
      )}
      {filter}
    </div>
  );
}

const columns = helper.columns([
  helper.accessor('entry.name', {
    id: 'name',
    header: (context) => columnTitle('Service / task', context, <TextFilter compact column={asFilterColumn(context.column)} title="Service / task" onChange={() => resetPage(context.table)} />),
    cell: (context) => {
      const row = context.row.original;
      const label = entryLabel(row.entry, row.projectName);
      return (
        <span className="flex min-w-0 items-center gap-3">
          <span className="entry-icon" aria-hidden="true">{row.entry.kind === 'task' ? <TerminalIcon /> : row.entry.kind === 'compose' ? <LayersIcon /> : <ServerIcon />}</span>
          <button type="button" className="min-w-0 truncate text-left font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Details for ${label}`} onClick={() => context.table.options.meta!.onDetails(row.entry.id)}>
            {row.entry.name}
          </button>
        </span>
      );
    },
    filterFn: filterFn_includesString,
    sortFn: 'alphanumeric',
    enableGlobalFilter: true,
    enableHiding: false,
    size: 190,
    minSize: 85,
  }),
  helper.accessor((row) => row.entry.kind, {
    id: 'type',
    header: (context) => columnTitle('Type', context, <FacetedFilter compact column={asFilterColumn(context.column)} title="Type" options={TYPE_OPTIONS} onChange={() => resetPage(context.table)} />),
    cell: (context) => <span className="type-label">{KIND_LABEL[context.getValue()]}</span>,
    filterFn: matchesSelection,
    sortFn: 'text',
    enableGlobalFilter: false,
    size: 96,
    minSize: 85,
  }),
  helper.accessor('projectName', {
    id: 'project',
    header: (context) => columnTitle('Project', context, <FacetedFilter compact column={asFilterColumn(context.column)} title="Project" options={projectOptions(context.table.getPreFilteredRowModel().rows)} onChange={() => resetPage(context.table)} />),
    cell: (context) => <span className="text-muted-foreground">{context.getValue()}</span>,
    filterFn: matchesSelection,
    sortFn: 'alphanumeric',
    enableGlobalFilter: false,
    size: 142,
    minSize: 85,
  }),
  helper.accessor((row) => row.entry.projectId, {
    id: 'projectId',
    header: () => null,
    enableColumnFilter: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enableResizing: false,
    enableSorting: true,
    sortFn: 'text',
    size: 0,
  }),
  helper.accessor((row) => row.entry.composeGroupId ?? '', {
    id: 'composeGroup',
    header: () => null,
    enableColumnFilter: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enableResizing: false,
    enableSorting: true,
    sortFn: 'text',
    size: 0,
  }),
  helper.accessor((row) => row.entry.state, {
    id: 'state',
    header: (context) => columnTitle('State', context, <FacetedFilter compact column={asFilterColumn(context.column)} title="State" options={STATE_OPTIONS} onChange={() => resetPage(context.table)} />),
    cell: (context) => <StateMark state={context.getValue()} />,
    filterFn: matchesSelection,
    sortFn: 'text',
    enableGlobalFilter: false,
    size: 120,
    minSize: 85,
  }),
  helper.accessor((row) => displayHealth(row.entry), {
    id: 'health',
    header: (context) => columnTitle('Health', context, <FacetedFilter compact column={asFilterColumn(context.column)} title="Health" options={HEALTH_OPTIONS} onChange={() => resetPage(context.table)} />),
    cell: (context) => <span className={TONE_TEXT[healthTone(context.getValue())]} data-health={context.getValue()}>{HEALTH_LABEL[context.getValue()]}</span>,
    filterFn: matchesSelection,
    sortFn: 'text',
    enableGlobalFilter: false,
    size: 132,
    minSize: 85,
  }),
  helper.accessor((row) => row.entry.links.join('\n'), {
    id: 'endpoint',
    header: (context) => columnTitle('Endpoint', context, <TextFilter compact column={asFilterColumn(context.column)} title="Endpoint" onChange={() => resetPage(context.table)} />),
    cell: (context) => <EndpointLinks links={context.row.original.entry.links} />,
    filterFn: filterFn_includesString,
    sortFn: 'text',
    enableGlobalFilter: false,
    size: 180,
    minSize: 85,
  }),
  helper.accessor('commandLabel', {
    id: 'command',
    header: (context) => columnTitle('Cmd / Compose file', context, <TextFilter compact column={asFilterColumn(context.column)} title="Cmd / Compose file" onChange={() => resetPage(context.table)} />),
    cell: (context) => context.getValue() ? <button type="button" className="block w-full cursor-copy truncate text-left font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={context.getValue()} aria-label={`Copy command or Compose file for ${entryLabel(context.row.original.entry, context.row.original.projectName)}`} onClick={() => context.table.options.meta!.onCopy(context.getValue())}>{context.getValue()}</button> : <span className="text-muted-foreground">—</span>,
    filterFn: filterFn_includesString,
    sortFn: 'text',
    enableGlobalFilter: false,
    size: 260,
    minSize: 85,
  }),
  helper.display({
    id: 'controls',
    header: () => <span className="block text-right">Controls</span>,
    cell: (context) => <RowControls row={context.row.original} meta={context.table.options.meta!} />,
    enableColumnFilter: false,
    enableResizing: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enableSorting: false,
    size: 248,
    minSize: 220,
  }),
]);

function projectOptions(rows: Array<Row<typeof features, ServiceRow>>): FilterOption[] {
  const names = new Set<string>();
  for (const row of rows) names.add(row.original.projectName);
  return [...names].sort().map((name) => ({ label: name, value: name }));
}

function StateMark({ state }: { state: EntryStatus['state'] }) {
  const tone = stateTone(state);
  return (
    <span className={cn('state-mark inline-flex items-center gap-2', TONE_TEXT[tone])} data-state={state}>
      <span className={cn('size-2 rounded-full', TONE_DOT[tone])} aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

function EndpointLinks({ links }: { links: readonly string[] }) {
  if (links.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="flex min-w-0 flex-col">
      {links.map((link) => (
        <a key={link} href={link} target="_blank" rel="noreferrer" className="endpoint-link flex min-w-0 items-center gap-1.5 text-ring hover:underline" title={link}><span className="truncate">{link}</span><ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" /></a>
      ))}
    </span>
  );
}

function activeOperation(operation: Operation): boolean {
  return operation.state === 'pending' || operation.state === 'running';
}

function entryOperation(operations: readonly Operation[], id: string): Operation | undefined {
  return operations.find((operation) => activeOperation(operation) && operation.target.entry === id)
    ?? operations.find((operation) => activeOperation(operation) && operation.affected.includes(id));
}

function targetOperation(operations: readonly Operation[], kind: TargetKind, id: string): Operation | undefined {
  return operations.find((operation) => activeOperation(operation) && (kind === 'projects' ? operation.target.project === id : operation.target.compose === id));
}

function RowControls({ row, meta }: { row: ServiceRow; meta: TableMeta }) {
  const entry = row.entry;
  const label = entryLabel(entry, row.projectName);
  const operation = meta.busy(entry.id);
  const task = entry.kind === 'task';
  const live = entry.state === 'running' || entry.state === 'starting' || entry.state === 'stopping';
  const primary = live
    ? { action: 'stop' as const, text: 'Stop', variant: 'destructive' as const }
    : task
      ? { action: 'run' as const, text: 'Run', variant: 'outline' as const }
      : { action: 'start' as const, text: 'Start', variant: 'outline' as const };
  const locked = Boolean(operation) || entry.state === 'stopping';
  const progress = operation ? actionProgress(operation.action) : entry.state === 'starting' ? 'Starting' : entry.state === 'stopping' ? 'Stopping' : '';
  const restartApplicable = !task && entry.state === 'running';
  return (
    <div className="flex items-center justify-end gap-1" aria-busy={Boolean(operation) || entry.state === 'starting' || entry.state === 'stopping'}>
      <Button variant={primary.variant} size="sm" className="min-w-20" disabled={locked} aria-label={`${primary.text} ${label}`} onClick={() => meta.onAction(entry.id, primary.action)}>
        {progress ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : live ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
        {primary.text}
      </Button>
      {restartApplicable ? <Button variant="outline" size="sm" disabled={locked} aria-label={`Restart ${label}`} onClick={() => meta.onAction(entry.id, 'restart')}><RotateCwIcon aria-hidden="true" />Restart</Button> : null}
      <Button variant="outline" size="sm" aria-label={`Logs for ${label}`} onClick={() => meta.onLogs(entry.id)}><ScrollTextIcon aria-hidden="true" />Logs</Button>
      {progress ? <span role="status" className="text-xs text-muted-foreground">{progress}</span> : null}
    </div>
  );
}

export function columnFiltersActive(filters: Array<{ id: string; value: unknown }>): boolean {
  return filters.some((filter) => Array.isArray(filter.value) ? filter.value.length > 0 : Boolean(filter.value));
}

export function ServiceTable({
  rows,
  globalFilter,
  onGlobalFilter,
  selectedId,
  operations,
  onAction,
  onLogs,
  onDetails,
  pageResetKey,
  groups = [],
  onTargetAction,
}: {
  rows: ServiceRow[];
  globalFilter: string;
  onGlobalFilter: (value: string) => void;
  selectedId: string | null;
  operations: Operation[];
  onAction: (id: string, action: Action) => void;
  onLogs: (id: string) => void;
  onDetails: (id: string) => void;
  pageResetKey: string;
  groups?: Snapshot['groups'];
  onTargetAction?: (kind: TargetKind, id: string, action: TargetAction) => void;
}) {
  const [grouped, setGrouped] = useState(true);
  const [visibleColumns, setVisibleColumns] = useState<ColumnVisibilityState>({ command: false, type: false });
  const [copyNotice, setCopyNotice] = useState<{ message: string } | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const columnVisibility = {
    ...visibleColumns,
    project: grouped ? false : visibleColumns.project !== false,
    projectId: false,
    composeGroup: false,
  };
  useEffect(() => {
    if (!copyNotice) return;
    const timer = window.setTimeout(() => setCopyNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice({ message: 'Copied to clipboard' });
    } catch {
      setCopyNotice({ message: 'Could not copy to clipboard' });
    }
  }
  const table = useTable({
    features,
    data: rows,
    columns,
    getRowId: (row) => row.entry.id,
    autoResetPageIndex: false,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    enableSortingRemoval: true,
    enableMultiSort: false,
    sortDescFirst: false,
    globalFilterFn: (row, _columnId, value) => {
      const query = String(value ?? '').toLowerCase();
      if (!query) return true;
      const item = row.original;
      return [item.entry.name, item.entry.id, item.projectName, item.commandLabel, item.entry.notes ?? '', item.entry.kind, KIND_LABEL[item.entry.kind], ...item.entry.links].join('\n').toLowerCase().includes(query);
    },
    state: { globalFilter, sorting: grouped ? GROUPED_SORT : sorting, columnVisibility },
    onColumnVisibilityChange: (updater) => {
      setVisibleColumns((current) => {
        const next = typeof updater === 'function' ? updater({ ...current, project: grouped ? false : current.project !== false, projectId: false, composeGroup: false }) : updater;
        return { ...next, project: grouped ? current.project : next.project };
      });
    },
    onGlobalFilterChange: (updater) => {
      const next = typeof updater === 'function' ? updater(globalFilter) : updater;
      onGlobalFilter(String(next ?? ''));
    },
    onSortingChange: (updater) => {
      if (grouped) return;
      setSorting((current) => typeof updater === 'function' ? updater(current) : updater);
    },
    initialState: {
      pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
      columnSizing: { name: 190, type: 96, project: 142, state: 120, health: 132, endpoint: 180, command: 260, controls: 248 },
    },
    meta: {
      busy: (id) => entryOperation(operations, id),
      onAction,
      onLogs,
      onDetails,
      onCopy: copyValue,
      grouped,
    },
  }, (state) => ({ pagination: state.pagination, columnFilters: state.columnFilters, columnSizing: state.columnSizing, sorting: state.sorting, columnVisibility: state.columnVisibility }));

  const tableRef = useRef(table);
  tableRef.current = table;
  useEffect(() => {
    tableRef.current.setPageIndex(0);
  }, [pageResetKey]);

  const sortedRows = table.getSortedRowModel().rows;
  const filtered = sortedRows.length;
  const pageCount = Math.ceil(filtered / PAGE_SIZE);
  const pageIndex = Math.min(table.state.pagination.pageIndex, Math.max(0, pageCount - 1));
  if (pageIndex !== table.state.pagination.pageIndex) table.setPageIndex(pageIndex);
  const visible = sortedRows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
  const start = filtered === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const end = Math.min(filtered, (pageIndex + 1) * PAGE_SIZE);
  const columnCount = table.getVisibleLeafColumns().length;
  const projectRows = rowsBy(sortedRows, (row) => row.original.entry.projectId);
  const composeRows = rowsBy(sortedRows.filter((row) => row.original.entry.composeGroupId), (row) => row.original.entry.composeGroupId ?? '');
  const body = grouped ? groupedBody({ visible, collapsed, columnCount, projectRows, composeRows, groups, operations, onTargetAction, onToggle: toggleCollapsed, selectedId }) : visible.map((row) => <DataRow key={row.id} row={row} selected={selectedId === row.original.entry.id} />);

  function selectOnly(columnId: 'state' | 'type', value: string | undefined) {
    table.getColumn(columnId)?.setFilterValue(value ? [value] : undefined);
    table.setPageIndex(0);
  }

  function changeView(next: boolean) {
    setGrouped(next);
    table.setPageIndex(0);
  }

  function toggleCollapsed(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasFilters = Boolean(globalFilter) || columnFiltersActive(table.state.columnFilters);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="table-toolbar mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3">
        <CountFilter label="State" allLabel="All states" options={STATE_OPTIONS} counts={facetCounts(table.getColumn('state'))} selected={Array.isArray(table.getColumn('state')?.getFilterValue()) ? (table.getColumn('state')?.getFilterValue() as string[]).map(String) : []} onSelect={(value) => selectOnly('state', value)} />
        <div className="flex flex-wrap items-center gap-2">
          <CountFilter label="Type" allLabel="All types" options={TYPE_OPTIONS} counts={facetCounts(table.getColumn('type'))} selected={Array.isArray(table.getColumn('type')?.getFilterValue()) ? (table.getColumn('type')?.getFilterValue() as string[]).map(String) : []} showEmpty onSelect={(value) => selectOnly('type', value)} />
          {columnFiltersActive(table.state.columnFilters) ? <Button variant="ghost" size="sm" onClick={() => { table.resetColumnFilters(); table.setPageIndex(0); }}>Clear column filters</Button> : null}
          <span className="mx-1 h-5 border-l" aria-hidden="true" />
          <ViewToggle grouped={grouped} onChange={changeView} />
          <ColumnMenu columns={table.getAllLeafColumns().filter((column) => column.getCanHide() && (!grouped || column.id !== 'project')).map((column) => ({ id: column.id, label: HEADER_LABEL[column.id] ?? column.id, checked: column.getIsVisible(), onCheckedChange: (checked) => column.toggleVisibility(checked) }))} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-region="table-scroll">
        <div className="service-table overflow-hidden rounded-xl border bg-background">
          <div className="overflow-x-auto">
            <table className="table-fixed border-separate border-spacing-0 text-left" style={{ width: table.getTotalSize(), minWidth: '100%' }} aria-label="Services and tasks" aria-rowcount={filtered + 1}>
              <thead className="bg-background">
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const canSort = !grouped && header.column.getCanSort();
                      return (
                        <th key={header.id} className="relative border-b bg-muted/40 px-4 py-2.5 font-medium" style={{ width: header.getSize() }} aria-sort={canSort ? sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none' : undefined}>
                          {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                          {header.column.getCanResize() ? <ResizeHandle header={header} /> : null}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>{body}</tbody>
            </table>
          </div>
          {filtered === 0 ? (
            <div className="empty-state flex flex-col items-center px-6 py-8 text-center" role="status">
              <span className="mb-3 rounded-xl border bg-muted/50 p-3 text-muted-foreground" aria-hidden="true">{hasFilters ? <SearchXIcon className="size-5" /> : <BoxIcon className="size-5" />}</span>
              <p className="text-sm font-semibold">{rows.length === 0 ? 'No services or tasks.' : 'No matching services or tasks.'}</p>
              <p className="mt-1.5 max-w-sm text-xs text-muted-foreground">{rows.length === 0 ? 'Add services, tasks, or a Compose group to your config, then reload it from Settings.' : 'Try another search or clear the filters to show all entries.'}</p>
              {hasFilters && rows.length > 0 ? <Button variant="outline" size="sm" className="mt-4" onClick={() => { onGlobalFilter(''); table.resetColumnFilters(); table.setPageIndex(0); }}>Clear search and filters</Button> : null}
            </div>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-xs">
            <span className="text-muted-foreground">{filtered === 0 ? '0 entries' : `${start}–${end} of ${filtered} entries`}</span>
            {pageCount > 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">20 per page</span>
                <span>Page {pageIndex + 1} of {pageCount}</span>
                <Button variant="outline" size="sm" aria-label="Previous page" disabled={pageIndex === 0} onClick={() => table.setPageIndex(pageIndex - 1)}><ChevronLeftIcon />Previous</Button>
                <Button variant="outline" size="sm" aria-label="Next page" disabled={pageIndex + 1 >= pageCount} onClick={() => table.setPageIndex(pageIndex + 1)}>Next<ChevronRightIcon /></Button>
              </div>
            ) : null}
          </footer>
        </div>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className={cn('fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg', !copyNotice && 'sr-only')}>{copyNotice?.message}</div>
    </div>
  );
}


function facetCounts(column: { getFacetedUniqueValues?: () => Map<unknown, number> } | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  const facets = column?.getFacetedUniqueValues?.();
  if (!facets) return counts;
  for (const [key, count] of facets) counts[String(key)] = count;
  return counts;
}


function rowsBy(rows: Array<Row<typeof features, ServiceRow>>, key: (row: Row<typeof features, ServiceRow>) => string): Record<string, ServiceRow[]> {
  const grouped: Record<string, ServiceRow[]> = {};
  for (const row of rows) {
    const id = key(row);
    const list = grouped[id];
    if (list) list.push(row.original);
    else grouped[id] = [row.original];
  }
  return grouped;
}

function stateSummary(items: readonly ServiceRow[]): string {
  const counts: Partial<Record<EntryState, number>> = {};
  for (const row of items) counts[row.entry.state] = (counts[row.entry.state] ?? 0) + 1;
  return (Object.keys(STATE_LABEL) as EntryState[])
    .filter((state) => counts[state])
    .map((state) => `${counts[state]} ${STATE_LABEL[state].toLowerCase()}`)
    .join(' · ');
}

function taskCount(items: readonly ServiceRow[]): string {
  const tasks = items.filter((row) => row.entry.kind === 'task').length;
  return `${tasks} ${tasks === 1 ? 'task' : 'tasks'}`;
}

function serviceCount(items: readonly ServiceRow[]): string {
  return `${items.length} ${items.length === 1 ? 'service' : 'services'}`;
}

function groupedBody({
  visible,
  collapsed,
  columnCount,
  projectRows,
  composeRows,
  groups,
  operations,
  onTargetAction,
  onToggle,
  selectedId,
}: {
  visible: Array<Row<typeof features, ServiceRow>>;
  collapsed: ReadonlySet<string>;
  columnCount: number;
  projectRows: Record<string, ServiceRow[]>;
  composeRows: Record<string, ServiceRow[]>;
  groups: Snapshot['groups'];
  operations: Operation[];
  onTargetAction?: (kind: TargetKind, id: string, action: TargetAction) => void;
  onToggle: (key: string) => void;
  selectedId: string | null;
}) {
  const body: ReactNode[] = [];
  let lastProject = '';
  let lastCompose = '';
  for (const row of visible) {
    const entry = row.original.entry;
    if (entry.projectId !== lastProject) {
      lastProject = entry.projectId;
      lastCompose = '';
      const items = projectRows[entry.projectId] ?? [];
      body.push(
        <GroupHeader
          key={`project:${entry.projectId}`}
          columnCount={columnCount}
          nested={false}
          name={row.original.projectName}
          summary={`${stateSummary(items)} · ${taskCount(items)}`}
          collapsed={collapsed.has(`project:${entry.projectId}`)}
          onToggle={() => onToggle(`project:${entry.projectId}`)}
          kind="projects"
          id={entry.projectId}
          operations={operations}
          onTargetAction={onTargetAction}
          actionLabel={(action) => `${action[0]!.toUpperCase()}${action.slice(1)} ${row.original.projectName} services`}
        />,
      );
    }
    if (collapsed.has(`project:${entry.projectId}`)) continue;
    if (entry.composeGroupId) {
      if (entry.composeGroupId !== lastCompose) {
        lastCompose = entry.composeGroupId;
        const items = composeRows[entry.composeGroupId] ?? [];
        const name = groups.find((group) => group.id === entry.composeGroupId)?.name || entry.composeGroupId;
        body.push(
          <GroupHeader
            key={`compose:${entry.composeGroupId}`}
            columnCount={columnCount}
            nested
            name={name}
            summary={`${stateSummary(items)} · ${serviceCount(items)}`}
            collapsed={collapsed.has(`compose:${entry.composeGroupId}`)}
            onToggle={() => onToggle(`compose:${entry.composeGroupId}`)}
            kind="compose-groups"
            id={entry.composeGroupId}
            operations={operations}
            onTargetAction={onTargetAction}
            actionLabel={(action) => `${action[0]!.toUpperCase()}${action.slice(1)} Compose group ${name}`}
          />,
        );
      }
      if (collapsed.has(`compose:${entry.composeGroupId}`)) continue;
    } else {
      lastCompose = '';
    }
    body.push(<DataRow key={row.id} row={row} selected={selectedId === row.original.entry.id} />);
  }
  return body;
}

function GroupHeader({
  columnCount,
  nested,
  name,
  summary,
  collapsed,
  onToggle,
  kind,
  id,
  operations,
  onTargetAction,
  actionLabel,
}: {
  columnCount: number;
  nested: boolean;
  name: string;
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  kind: TargetKind;
  id: string;
  operations: Operation[];
  onTargetAction?: (kind: TargetKind, id: string, action: TargetAction) => void;
  actionLabel: (action: TargetAction) => string;
}) {
  const operation = targetOperation(operations, kind, id);
  const menuLabel = kind === 'projects' ? `Actions for ${name}` : `Actions for Compose group ${name}`;
  return (
    <tr className={cn('group-header cursor-pointer', nested ? 'bg-muted/40' : 'bg-muted/70')} data-group={kind} data-group-id={id} onClick={onToggle}>
      <td colSpan={columnCount} className="border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`} onClick={(event) => { event.stopPropagation(); onToggle(); }}>
            {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </Button>
          {nested ? <LayersIcon className="size-4 text-muted-foreground" aria-hidden="true" /> : <FolderIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
          {nested ? <span className="text-[10px] font-semibold tracking-wider text-muted-foreground">COMPOSE GROUP</span> : null}
          <span className={cn('truncate', nested ? 'text-xs font-medium' : 'font-semibold')}>{name}</span>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
          {operation ? <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />{actionProgress(operation.action)}</span> : null}
          <div className="ml-auto" onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" aria-label={menuLabel}>Actions<ChevronDownIcon aria-hidden="true" /></Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{menuLabel}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {(['start', 'stop', 'restart'] as const).map((action) => (
                  <DropdownMenuItem key={action} disabled={Boolean(operation) || !onTargetAction} onSelect={() => onTargetAction?.(kind, id, action)}>
                    {actionLabel(action)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </td>
    </tr>
  );
}

function DataRow({ row, selected }: { row: Row<typeof features, ServiceRow>; selected: boolean }) {
  return (
    <tr className={cn(selected && 'bg-accent/60')} aria-selected={selected} data-selected={selected ? 'true' : undefined}>
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="border-b px-4 py-3 align-middle" style={{ width: cell.column.getSize() }}>
          <FlexRender cell={cell} />
        </td>
      ))}
    </tr>
  );
}

const HEADER_LABEL: Record<string, string> = {
  name: 'Service / task',
  type: 'Type',
  project: 'Project',
  state: 'State',
  health: 'Health',
  endpoint: 'Endpoint',
  command: 'Cmd / Compose file',
  controls: 'Controls',
};

function ResizeHandle({ header }: { header: Header<typeof features, ServiceRow, unknown> }) {
  const label = HEADER_LABEL[header.column.id] ?? header.column.id;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      tabIndex={0}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none border-r border-border hover:border-ring hover:bg-ring/20 focus-visible:border-ring focus-visible:bg-ring/20 focus-visible:outline-none"
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = Math.max(header.column.columnDef.minSize ?? 85, header.getSize() + (event.key === 'ArrowRight' ? 16 : -16));
        header.column.table.setColumnSizing((sizing) => ({ ...sizing, [header.column.id]: next }));
      }}
    />
  );
}
