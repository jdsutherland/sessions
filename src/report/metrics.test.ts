import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionMetrics } from './metrics.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-metrics-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
mkdirSync(join(claudeDir, 'proj'), { recursive: true });

const event = (sessionId: string, cwd: string, timestamp: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    timestamp,
    message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
  }) + '\n';

// 02:30Z on June 2 is 21:30 on June 1 in Chicago — the hour AND the day differ, which
// is exactly what bucketing by `timestamp.slice(11, 13)` used to get wrong.
writeFileSync(
  join(claudeDir, 'proj', 'a.jsonl'),
  event('s1', '/Users/x/Developer/sessions', '2026-06-02T02:30:00Z') +
    event('s1', '/Users/x/Developer/sessions', '2026-06-02T02:45:00Z') +
    event('s2', '/Users/x/Developer/otherproj', '2026-06-01T19:00:00Z'),
);

const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };
const opts = { roots, tz: 'America/Chicago', now: '2026-06-03T12:00:00Z' };

test('active hours bucket by the configured timezone, not UTC', async () => {
  const m = await getSessionMetrics('2026-06-01', '2026-06-01', '', '', opts);
  // 21:30 and 21:45 local, plus the 14:00 local event — never 02:xx.
  expect(m.activeHours).toEqual({ '14': 1, '21': 2 });
  // Same window read as UTC: the late-evening pair moves to the next day and out of range.
  const utc = await getSessionMetrics('2026-06-01', '2026-06-02', '', '', { ...opts, tz: 'UTC' });
  expect(utc.activeHours).toEqual({ '02': 2, '19': 1 });
});

test('the date range is local too', async () => {
  const local = await getSessionMetrics('2026-06-01', '2026-06-01', '', '', opts);
  expect(local.totalMessages).toBe(3);
  expect(local.dailyActivity).toEqual([{ date: '2026-06-01', sessions: 2, messages: 3 }]);
  // In UTC the two 02:30Z events belong to June 2 instead.
  const utc = await getSessionMetrics('2026-06-01', '2026-06-01', '', '', { ...opts, tz: 'UTC' });
  expect(utc.totalMessages).toBe(1);
});

test('breakdowns keep the tool names and shape the MCP tool has always returned', async () => {
  const m = await getSessionMetrics('2026-06-01', '2026-06-01', '', '', opts);
  expect(m.period).toEqual({ start: '2026-06-01', end: '2026-06-01' });
  expect(m.totalSessions).toBe(2);
  // 'claude', not the report pipeline's 'claude-code'.
  expect(m.toolBreakdown).toEqual({ claude: 2 });
  expect(m.projectBreakdown).toEqual([
    { project: 'sessions', sessions: 1, messages: 2 },
    { project: 'otherproj', sessions: 1, messages: 1 },
  ]);
});

test('a project scopes by resolved name, and an empty range reports nothing', async () => {
  const scoped = await getSessionMetrics('2026-06-01', '2026-06-01', '', '/Users/x/Developer/sessions', opts);
  expect(scoped.projectBreakdown).toEqual([{ project: 'sessions', sessions: 1, messages: 2 }]);
  expect(scoped.totalMessages).toBe(2);

  const empty = await getSessionMetrics('2026-05-01', '2026-05-31', '', '', opts);
  expect(empty.totalSessions).toBe(0);
  expect(empty.dailyActivity).toEqual([]);
  expect(empty.activeHours).toEqual({});
});

test('a tool filter keeps only that tool', async () => {
  const m = await getSessionMetrics('2026-06-01', '2026-06-01', 'codex', '', opts);
  expect(m.totalSessions).toBe(0);
  expect(await getSessionMetrics('2026-06-01', '2026-06-01', 'claude', '', opts)).toHaveProperty('totalSessions', 2);
});
