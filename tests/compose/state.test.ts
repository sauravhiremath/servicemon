import { describe, expect, it } from 'vitest';
import {
  aggregateComposeState,
  pageComposeHistory,
  type ComposeContainer,
  type ComposeHistoryLine,
} from '../../src/compose/adapter.js';

function container(state: string, id = state): ComposeContainer {
  return {
    id,
    name: id,
    service: 'web',
    state,
    health: '',
    exitCode: state === 'exited' ? 1 : 0,
    number: 1,
  };
}

function line(text: string, containerId = 'c1'): ComposeHistoryLine {
  return { timestamp: '2026-10-03T00:00:00.000Z', stream: 'stdout', text, containerId };
}

describe('aggregateComposeState', () => {
  it('does not report a created container as starting', () => {
    expect(aggregateComposeState([container('created')], 1, false, false)).toBe('stopped');
    expect(
      aggregateComposeState(
        [container('created', 'a'), container('running', 'b')],
        2,
        false,
        false,
      ),
    ).toBe('exited');
    expect(aggregateComposeState([container('created')], 1, false, true)).toBe('starting');
  });

  it('keeps paused and partial replicas actionable', () => {
    expect(aggregateComposeState([container('paused')], 1, false, false)).toBe('running');
    expect(
      aggregateComposeState([container('running', 'a'), container('exited', 'b')], 2, false, false),
    ).toBe('exited');
    expect(
      aggregateComposeState([container('exited'), container('dead', 'old')], 1, false, false),
    ).toBe('exited');
    expect(aggregateComposeState([container('restarting')], 1, false, false)).toBe('starting');
    expect(aggregateComposeState([container('running')], 1, true, false)).toBe('stopping');
    expect(aggregateComposeState([], 1, true, false)).toBe('stopped');
  });
});

describe('pageComposeHistory', () => {
  const meta = { entryId: 'demo/infra.web', runId: 'run-1' };

  it('appends new lines without hiding lines that replace a shorter log', () => {
    const opened = pageComposeHistory([line('a'), line('b'), line('c')], undefined, {}, meta);
    const after = opened.page.cursor;
    const grown = pageComposeHistory(
      [line('a'), line('b'), line('c'), line('d')],
      opened.cursor,
      { after },
      meta,
    );
    expect(grown.page.gap).toBe(false);
    expect(grown.page.records.map((record) => record.text)).toEqual(['d']);
    expect(grown.page.records[0]?.sequence).toBe(after + 1);

    const shrunk = pageComposeHistory([line('c'), line('d')], opened.cursor, { after }, meta);
    expect(shrunk.page.gap).toBe(true);
    expect(shrunk.page.records.map((record) => record.text)).toEqual(['c', 'd']);
    expect(shrunk.page.records.every((record) => record.sequence > after)).toBe(true);
  });

  it('starts a new sequence range when replacement logs remove the previous history', () => {
    const opened = pageComposeHistory([line('old')], undefined, {}, meta);
    const replaced = pageComposeHistory(
      [line('new', 'c2')],
      opened.cursor,
      { after: opened.page.cursor },
      meta,
    );
    expect(replaced.page.gap).toBe(true);
    expect(replaced.page.records.map((record) => record.containerId)).toEqual(['c2']);
    expect(replaced.page.records[0]?.sequence).toBeGreaterThan(opened.page.cursor);
  });

  it('keeps the latest cursor for an empty tail and does not treat a requested tail as a gap', () => {
    const lines = [line('a'), line('b'), line('c')];
    const empty = pageComposeHistory(lines, undefined, { tail: 0 }, meta);
    expect(empty.page.records).toEqual([]);
    expect(empty.page.cursor).toBe(3);
    expect(empty.page.gap).toBe(false);
    const recent = pageComposeHistory(lines, undefined, { tail: 1 }, meta);
    expect(recent.page.gap).toBe(false);
    expect(recent.page.records.map((record) => record.text)).toEqual(['c']);
    expect(recent.page.cursor).toBe(3);
    const followed = pageComposeHistory(
      [...lines, line('d')],
      empty.cursor,
      { after: empty.page.cursor, tail: 0 },
      meta,
    );
    expect(followed.page.records).toEqual([]);
    expect(followed.page.cursor).toBe(4);
    expect(followed.page.gap).toBe(false);
  });
});
