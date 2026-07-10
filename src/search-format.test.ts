// src/search-format.test.ts
import { test, expect } from 'bun:test';
import { buildResumeCommand, formatResult } from './search-format';
import { formatLine } from './display';
import type { SessionResult } from './types';

test('buildResumeCommand: claude resumes, pi/codex cd only', () => {
  expect(buildResumeCommand('claude', '/r', 'abc')).toBe('cd "/r" && claude --resume abc');
  expect(buildResumeCommand('pi', '/r', 'abc')).toBe('cd "/r"');
  expect(buildResumeCommand('codex', '/r', 'abc')).toBe('cd "/r"');
});

test('formatResult: shapes a SessionResult for callers, including resumeCommand', () => {
  const r: SessionResult = {
    date: '2026-06-01',
    createdAt: '2026-06-01',
    cwd: '/r',
    tool: 'claude',
    sessionId: 'abc',
    displayText: 'snip',
    customTitle: 'Title',
    messageCount: 5,
    filePath: '/f.jsonl',
    exists: true,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
  };
  expect(formatResult(r)).toEqual({
    sessionId: 'abc',
    tool: 'claude',
    date: '2026-06-01',
    createdAt: '2026-06-01',
    project: '/r',
    title: 'Title',
    snippet: 'snip',
    messageCount: 5,
    files: ['/r/a.ts'],
    commands: ['bun test'],
    errored: true,
    exists: true,
    filePath: '/f.jsonl',
    resumeCommand: 'cd "/r" && claude --resume abc',
  });
});

// ——— message-granularity (schema v7) tests — additive ———

const baseResult: SessionResult = {
  date: '2026-06-01',
  createdAt: '2026-06-01',
  cwd: '/r',
  tool: 'claude',
  sessionId: 'abc',
  displayText: 'the mangowurzel fix',
  customTitle: '',
  messageCount: 5,
  filePath: '/f.jsonl',
  exists: true,
  files: [],
  commands: [],
  errored: false,
};

test('formatResult: passes messageHits through when present (indexed search path)', () => {
  const hits = [{ index: 4, role: 'assistant' as const, snippet: 'the mangowurzel fix' }];
  const out = formatResult({ ...baseResult, messageHits: hits });
  expect(out.messageHits).toEqual(hits);
});

test('formatResult: omits messageHits when the source result has none (scanner fallback)', () => {
  expect('messageHits' in formatResult(baseResult)).toBe(false);
});

test('formatLine: renders the top message hit index as a msg# badge beside the snippet', () => {
  const line = formatLine(
    { ...baseResult, messageHits: [{ index: 4, role: 'assistant', snippet: 'the mangowurzel fix' }] },
    120,
  );
  expect(line).toContain('msg#4');
  expect(line).toContain('the mangowurzel fix');
});

test('formatLine: no msg# badge when there are no message hits', () => {
  expect(formatLine({ ...baseResult, messageHits: [] }, 120)).not.toContain('msg#');
  expect(formatLine(baseResult, 120)).not.toContain('msg#');
});
