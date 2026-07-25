// src/search-format.test.ts
import { test, expect } from 'bun:test';
import {
  buildResumeCommand,
  formatResult,
  MAX_RESULT_COMMANDS,
  MAX_RESULT_FILES,
  RESULT_COMMAND_MAX,
} from './search-format';
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
    filesTotal: 1,
    commands: ['bun test'],
    commandsTotal: 1,
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

// ——— payload bounds — additive ———

test('formatResult: caps the emitted arrays and reports the uncapped totals', () => {
  const out = formatResult({
    ...baseResult,
    files: Array.from({ length: MAX_RESULT_FILES + 30 }, (_, i) => `/r/f${i}.ts`),
    commands: Array.from({ length: MAX_RESULT_COMMANDS + 40 }, (_, i) => `cmd${i}`),
  });
  expect(out.files).toHaveLength(MAX_RESULT_FILES);
  expect(out.filesTotal).toBe(MAX_RESULT_FILES + 30);
  expect(out.commands).toHaveLength(MAX_RESULT_COMMANDS);
  expect(out.commandsTotal).toBe(MAX_RESULT_COMMANDS + 40);
});

test('formatResult: clips a command to its first line and marks the loss', () => {
  const out = formatResult({ ...baseResult, commands: ['cat <<EOF\nbody line\nmore body\nEOF'] });
  expect(out.commands[0]).toBe('cat <<EOF…');
});

test('formatResult: clips a long single-line command to RESULT_COMMAND_MAX', () => {
  const out = formatResult({ ...baseResult, commands: [`echo ${'x'.repeat(2000)}`] });
  expect(out.commands[0]!.length).toBe(RESULT_COMMAND_MAX + 1); // + the ellipsis
});

test('formatResult: leaves a short single-line command untouched', () => {
  expect(formatResult({ ...baseResult, commands: ['bun test'] }).commands).toEqual(['bun test']);
});
