import { describe, expect, test } from 'vitest';

import {
  BYTE_BUDGET,
  COALESCE_MS,
  EMPTY_HISTORY,
  type History,
  PER_FILE_LIMIT,
  describeAge,
  describeReason,
  forget,
  orphaned,
  record,
  revisionById,
  revisionsFor,
  totalBytes,
  trim,
} from './history';
import type { VirtualFile } from './types';

const START = 1_700_000_000_000;

const file = (id: string): VirtualFile => ({
  id,
  name: `${id}.py`,
  language: 'python',
  content: '',
});

/** A history with `count` snapshots of one file, one minute apart. */
function series(fileId: string, count: number, size = 10): History {
  let history = EMPTY_HISTORY;
  for (let index = 0; index < count; index += 1) {
    history = record(history, {
      fileId,
      content: String(index).padEnd(size, '.'),
      reason: 'run',
      at: START + index * 60_000,
    });
  }
  return history;
}

describe('recording', () => {
  test('a snapshot is kept', () => {
    const history = record(EMPTY_HISTORY, { fileId: 'a', content: 'x = 1', reason: 'edit', at: START });

    expect(revisionsFor(history, 'a')).toHaveLength(1);
    expect(revisionsFor(history, 'a')[0]!.content).toBe('x = 1');
  });

  test('newest comes first', () => {
    const history = series('a', 3);

    expect(revisionsFor(history, 'a').map((revision) => revision.at)).toEqual([
      START + 120_000,
      START + 60_000,
      START,
    ]);
  });

  test('content identical to the last snapshot is not recorded', () => {
    // Otherwise the list fills with entries that all diff to nothing.
    const first = record(EMPTY_HISTORY, { fileId: 'a', content: 'same', reason: 'edit', at: START });
    const second = record(first, { fileId: 'a', content: 'same', reason: 'run', at: START + 90_000 });

    expect(second).toBe(first);
  });

  test('files keep separate histories', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'one', reason: 'edit', at: START });
    history = record(history, { fileId: 'b', content: 'two', reason: 'edit', at: START });

    expect(revisionsFor(history, 'a')[0]!.content).toBe('one');
    expect(revisionsFor(history, 'b')[0]!.content).toBe('two');
  });

  test('a file with no history has none', () => {
    expect(revisionsFor(EMPTY_HISTORY, 'nothing')).toEqual([]);
  });

  test('revisions have distinct ids even in the same millisecond', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: '1', reason: 'run', at: START });
    history = record(history, { fileId: 'a', content: '2', reason: 'run', at: START });

    const [newer, older] = revisionsFor(history, 'a');
    expect(newer!.id).not.toBe(older!.id);
  });
});

describe('coalescing', () => {
  test('edits close together collapse into one entry', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'de', reason: 'edit', at: START });
    history = record(history, { fileId: 'a', content: 'def', reason: 'edit', at: START + 1000 });

    expect(revisionsFor(history, 'a')).toHaveLength(1);
    expect(revisionsFor(history, 'a')[0]!.content).toBe('def');
  });

  test('edits far apart are separate places to go back to', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'one', reason: 'edit', at: START });
    history = record(history, {
      fileId: 'a',
      content: 'two',
      reason: 'edit',
      at: START + COALESCE_MS + 1,
    });

    expect(revisionsFor(history, 'a')).toHaveLength(2);
  });

  test('a run is a landmark and never collapses into an edit', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'draft', reason: 'edit', at: START });
    history = record(history, { fileId: 'a', content: 'ran', reason: 'run', at: START + 500 });

    expect(revisionsFor(history, 'a')).toHaveLength(2);
  });

  test('an edit right after a landmark keeps the landmark', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'ran', reason: 'run', at: START });
    history = record(history, { fileId: 'a', content: 'then', reason: 'edit', at: START + 500 });

    expect(revisionsFor(history, 'a').map((revision) => revision.reason)).toEqual(['edit', 'run']);
  });
});

describe('limits', () => {
  test('a file keeps only its most recent snapshots', () => {
    const history = series('a', PER_FILE_LIMIT + 5);

    expect(revisionsFor(history, 'a')).toHaveLength(PER_FILE_LIMIT);
    expect(revisionsFor(history, 'a')[0]!.at).toBe(START + (PER_FILE_LIMIT + 4) * 60_000);
  });

  test('the total is bounded across every file, not per file', () => {
    const big = 'x'.repeat(400);
    let history = EMPTY_HISTORY;
    for (let index = 0; index < 12; index += 1) {
      history = record(history, {
        fileId: `file${index % 4}`,
        content: `${index}${big}`,
        reason: 'run',
        at: START + index * 60_000,
      });
    }

    expect(totalBytes(trim(history, PER_FILE_LIMIT, 1500))).toBeLessThanOrEqual(1500);
  });

  test('the oldest is what goes', () => {
    const history = trim(series('a', 5, 100), PER_FILE_LIMIT, 250);
    const kept = revisionsFor(history, 'a');

    expect(kept).toHaveLength(2);
    expect(kept.map((revision) => revision.at)).toEqual([START + 240_000, START + 180_000]);
  });

  test('a file left with nothing drops out entirely', () => {
    // An empty array in the map would show as a file with a history panel and
    // no entries in it.
    const history = trim(series('a', 3, 100), PER_FILE_LIMIT, 100);

    expect(Object.keys(history)).toEqual(['a']);
    expect(trim(series('a', 3, 100), PER_FILE_LIMIT, 0)).toEqual({});
  });

  test('history within budget is left alone', () => {
    const history = series('a', 3);

    expect(trim(history, PER_FILE_LIMIT, BYTE_BUDGET)).toEqual(history);
  });
});

describe('lookup and removal', () => {
  test('a revision can be found by id across files', () => {
    let history = record(EMPTY_HISTORY, { fileId: 'a', content: 'one', reason: 'edit', at: START });
    history = record(history, { fileId: 'b', content: 'two', reason: 'edit', at: START });
    const target = revisionsFor(history, 'b')[0]!;

    expect(revisionById(history, target.id)?.content).toBe('two');
  });

  test('an unknown id is null rather than a throw', () => {
    expect(revisionById(series('a', 2), 'nope')).toBeNull();
  });

  test('forgetting a file drops its history', () => {
    let history = series('a', 2);
    history = record(history, { fileId: 'b', content: 'kept', reason: 'edit', at: START });

    expect(Object.keys(forget(history, 'a'))).toEqual(['b']);
  });

  test('forgetting a file with no history changes nothing', () => {
    const history = series('a', 2);

    expect(forget(history, 'b')).toBe(history);
  });

  test('history for a deleted file is offered back rather than dropped', () => {
    // Deleting the wrong file is the accident this module exists for.
    let history = series('alive', 1);
    history = record(history, { fileId: 'deleted', content: 'gone', reason: 'edit', at: START });

    expect(orphaned(history, [file('alive')])).toEqual(['deleted']);
  });

  test('nothing is orphaned when every file is still there', () => {
    expect(orphaned(series('a', 1), [file('a')])).toEqual([]);
  });
});

describe('describing', () => {
  test('the last minute reads as just now', () => {
    expect(describeAge(START, START + 30_000)).toBe('just now');
  });

  test('minutes, hours and days each get their own unit', () => {
    expect(describeAge(START, START + 5 * 60_000)).toBe('5 min ago');
    expect(describeAge(START, START + 3 * 3_600_000)).toBe('3 hours ago');
    expect(describeAge(START, START + 3 * 86_400_000)).toBe('3 days ago');
  });

  test('one of a unit is singular', () => {
    expect(describeAge(START, START + 3_600_000)).toBe('1 hour ago');
    expect(describeAge(START, START + 86_400_000)).toBe('yesterday');
  });

  test('a clock that went backwards does not read as negative', () => {
    expect(describeAge(START + 60_000, START)).toBe('just now');
  });

  test('every reason has wording of its own', () => {
    const reasons = ['edit', 'run', 'restore', 'assistant', 'replace'] as const;
    const described = reasons.map(describeReason);

    expect(new Set(described).size).toBe(reasons.length);
  });
});
