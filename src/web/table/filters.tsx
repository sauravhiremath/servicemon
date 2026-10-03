import { ChevronDownIcon, Columns3Icon, LayersIcon, ListFilterIcon, ListIcon } from 'lucide-react';
import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import { Checkbox } from '../components/checkbox.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { Input } from '../components/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../components/popover.js';
import { Separator } from '../components/separator.js';
import { cn } from '../lib/utils.js';

export type FilterOption = { label: string; value: string };

export type FilterColumn = {
  getFilterValue: () => unknown;
  setFilterValue: (value: unknown) => void;
  getFacetedUniqueValues: () => Map<unknown, number>;
};

export function FacetedFilter({
  column,
  title,
  options,
  onChange,
  compact = false,
}: {
  column: FilterColumn;
  title: string;
  options: readonly FilterOption[];
  onChange: () => void;
  compact?: boolean;
}) {
  const selected = new Set((column.getFilterValue() as string[] | undefined) ?? []);
  const facets = column.getFacetedUniqueValues();
  const apply = (next: Set<string>) => {
    column.setFilterValue(next.size ? [...next] : undefined);
    onChange();
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 justify-between px-1 font-medium',
            !compact && 'w-full',
            selected.size > 0 && 'text-ring',
          )}
          aria-label={`Filter ${title}`}
        >
          {compact ? null : <span className="truncate">{title}</span>}
          <ListFilterIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="px-3 py-2 text-sm font-medium">{title}</div>
        <Separator />
        <div className="max-h-64 overflow-auto p-1" role="group" aria-label={`${title} values`}>
          {options.map((option) => {
            const checked = selected.has(option.value);
            const count = facets.get(option.value);
            return (
              <label
                key={option.value}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => {
                    const next = new Set(selected);
                    if (value === true) {
                      next.add(option.value);
                    } else {
                      next.delete(option.value);
                    }
                    apply(next);
                  }}
                  aria-label={option.label}
                />
                <span className="flex-1 truncate">{option.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{count ?? 0}</span>
              </label>
            );
          })}
        </div>
        {selected.size > 0 ? (
          <>
            <Separator />
            <button
              type="button"
              className="w-full px-3 py-2 text-center text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => apply(new Set())}
            >
              Clear filters
            </button>
            <div className="flex flex-wrap gap-1 border-t px-3 py-2">
              {[...selected].slice(0, 2).map((value) => (
                <Badge key={value}>
                  {options.find((option) => option.value === value)?.label ?? value}
                </Badge>
              ))}
              {selected.size > 2 ? <Badge>{selected.size} selected</Badge> : null}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function TextFilter({
  column,
  title,
  onChange,
  compact = false,
}: {
  column: FilterColumn;
  title: string;
  onChange: () => void;
  compact?: boolean;
}) {
  const value = (column.getFilterValue() as string | undefined) ?? '';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 justify-between px-1 font-medium',
            !compact && 'w-full',
            value && 'text-ring',
          )}
          aria-label={`Filter ${title}`}
        >
          {compact ? null : <span className="truncate">{title}</span>}
          <ListFilterIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <label className="grid gap-2 text-sm font-medium">
          {title}
          <Input
            value={value}
            placeholder={`Filter ${title}`}
            aria-label={`${title} text`}
            onChange={(event) => {
              column.setFilterValue(event.target.value || undefined);
              onChange();
            }}
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}

export function CountFilter({
  label,
  allLabel,
  options,
  counts,
  selected,
  showEmpty = false,
  onSelect,
}: {
  label: string;
  allLabel: string;
  options: readonly FilterOption[];
  counts: Readonly<Record<string, number>>;
  selected: readonly string[];
  showEmpty?: boolean;
  onSelect: (value: string | undefined) => void;
}) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const visible = options.filter(
    (option) => showEmpty || (counts[option.value] ?? 0) > 0 || selected.includes(option.value),
  );
  if (showEmpty) {
    const current =
      selected.length === 0
        ? allLabel
        : selected.length === 1
          ? (options.find((option) => option.value === selected[0])?.label ?? label)
          : `${selected.length} types`;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Filter by ${label}`}
            className={cn(selected.length > 0 && 'border-ring/40 bg-blue-50 text-blue-700')}
          >
            <ListFilterIcon aria-hidden="true" />
            {current}
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuCheckboxItem
            checked={selected.length === 0}
            onCheckedChange={() => onSelect(undefined)}
          >
            {allLabel}
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{total}</span>
          </DropdownMenuCheckboxItem>
          {visible.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={selected.includes(option.value)}
              onCheckedChange={() =>
                onSelect(
                  selected.length === 1 && selected[0] === option.value ? undefined : option.value,
                )
              }
            >
              {option.label}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                {counts[option.value] ?? 0}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <div
      role="group"
      aria-label={label}
      className="state-filters flex flex-wrap items-center gap-1"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={selected.length === 0}
        aria-label={`${allLabel} ${total}`}
        onClick={() => onSelect(undefined)}
      >
        {allLabel}
        <span className="filter-count">{total}</span>
      </Button>
      {visible.map((option) => {
        const count = counts[option.value] ?? 0;
        const pressed = selected.length === 1 && selected[0] === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={pressed}
            aria-label={`${option.label} ${count}`}
            onClick={() => onSelect(pressed ? undefined : option.value)}
          >
            {option.label}
            <span className="filter-count">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function ViewToggle({
  grouped,
  onChange,
}: {
  grouped: boolean;
  onChange: (grouped: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Row grouping"
      className="view-toggle inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={grouped}
        onClick={() => onChange(true)}
      >
        <LayersIcon aria-hidden="true" />
        Grouped
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={!grouped}
        onClick={() => onChange(false)}
      >
        <ListIcon aria-hidden="true" />
        Ungrouped
      </Button>
    </div>
  );
}

export function ColumnMenu({
  columns,
}: {
  columns: readonly {
    id: string;
    label: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Columns">
          <Columns3Icon aria-hidden="true" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.checked}
            onCheckedChange={(checked) => column.onCheckedChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
