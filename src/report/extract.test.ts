import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherEvents, defaultRoots, mtimeFloor } from './extract.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
mkdirSync(join(claudeDir, 'proj'), { recursive: true });
writeFileSync(
  join(claudeDir, 'proj', 'a.jsonl'),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: '2026-06-01T14:30:00Z',
    message: {
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 10000,
      },
    },
  }) + '\n',
);

const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };

describe('gatherEvents', () => {
  test('parses claude events and skips missing tool dirs', async () => {
    const events = await gatherEvents(roots);
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.tool).toBe('claude-code');
    expect(e.provider).toBe('anthropic');
    expect(e.tokens.input).toBe(1000);
    expect(e.tokens.cacheWrite).toBe(200);
    expect(e.tokens.cacheRead).toBe(10000);
    expect(e.projectPath).toContain('sessions');
  });

  test('honors the tools filter', async () => {
    const events = await gatherEvents(roots, { tools: new Set(['pi']) });
    expect(events.length).toBe(0);
  });
});

describe('the mtime prune', () => {
  test('skips transcripts last written before the window, and reads the ones after', async () => {
    const before = await gatherEvents(roots, { since: Date.now() + 60_000 });
    expect(before.length).toBe(0);
    const after = await gatherEvents(roots, { since: Date.now() - 60_000 });
    expect(after.length).toBe(1);
  });

  test('mtimeFloor reaches back far enough to cover any timezone, and widens on garbage', () => {
    const floor = mtimeFloor('2026-06-02')!;
    // The earliest instant that can be June 2 anywhere is 14:00Z on June 1 — the floor is
    // below it, and stays within two days so the prune keeps its teeth.
    expect(floor).toBeLessThan(Date.parse('2026-06-01T14:00:00Z'));
    expect(floor).toBeGreaterThan(Date.parse('2026-05-31T00:00:00Z'));
    // An unparseable bound must widen the scan, never empty it.
    expect(mtimeFloor('not-a-date')).toBeUndefined();
  });
});

describe('defaultRoots', () => {
  test('honors the SESSIONS_* overrides, so a sandboxed run cannot read the real home', () => {
    const saved = { ...process.env };
    try {
      process.env['SESSIONS_HOME'] = '/sandbox';
      delete process.env['SESSIONS_CLAUDE_DIR'];
      delete process.env['SESSIONS_PI_DIR'];
      delete process.env['SESSIONS_CODEX_DIR'];
      expect(defaultRoots()).toMatchObject({
        claudeCode: '/sandbox/.claude/projects',
        pi: '/sandbox/.pi/agent/sessions',
        codex: '/sandbox/.codex/sessions',
      });
      // A per-tool override still wins over the sandboxed home.
      process.env['SESSIONS_CODEX_DIR'] = '/elsewhere/codex';
      expect(defaultRoots().codex).toBe('/elsewhere/codex');
    } finally {
      process.env = saved;
    }
  });
});
