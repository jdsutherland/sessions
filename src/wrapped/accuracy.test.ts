import { describe, test, expect } from 'bun:test';
import { isJunkCwd, isJunkScope, junkCwdSql } from './exclude.ts';
import { isRealModel, canonicalModel } from './model-name.ts';
import { mineWords } from './content.ts';
import { computeEventStats } from './compute.ts';
import type { UsageEvent } from '../report/parsers/types.ts';

describe('isJunkCwd', () => {
  test('keeps real project directories', () => {
    expect(isJunkCwd('/Users/nick/Developer/cli')).toBe(false);
    expect(isJunkCwd('/Users/nick/code/workos')).toBe(false);
    expect(isJunkCwd(undefined)).toBe(false); // unknown cwd is real work we can't place
  });

  test('drops eval-harness temp dirs, /tmp throwaways, and menu-bar probes', () => {
    expect(isJunkCwd('/private/var/folders/2z/xxx/T/eval-nextjs-example-auth0-abc')).toBe(true);
    expect(isJunkCwd('/var/folders/2z/xxx/T/eval-go-example')).toBe(true);
    expect(isJunkCwd('/private/tmp/my-app')).toBe(true);
    expect(isJunkCwd('/tmp/test4')).toBe(true);
    expect(isJunkCwd('/Users/nick/Library/Application Support/CodexBar/ClaudeProbe')).toBe(true);
  });

  test('isJunkScope covers the roots the rules are written relative to', () => {
    // The rules describe session cwds ('/tmp/'), so a root fails its own rule: `/tmp`
    // does not start with `/tmp/`. Scoping there must still exempt the filter, or the
    // scope selects only rows the filter then removes.
    expect(isJunkCwd('/tmp')).toBe(false);
    expect(isJunkScope('/tmp')).toBe(true);
    expect(isJunkScope('/tmp/')).toBe(true);
    expect(isJunkScope('/private/tmp')).toBe(true);
    expect(isJunkScope('/var/folders')).toBe(true);
    expect(isJunkScope('/private/var/folders')).toBe(true);
    expect(isJunkScope('/private')).toBe(true); // an ancestor of /private/tmp, asked for explicitly
    expect(isJunkScope('/var')).toBe(true); // likewise for /var/folders
    expect(isJunkScope('/tmp/scratch-one')).toBe(true); // inside one — isJunkCwd already said so
  });

  test('isJunkScope leaves real scopes filtered', () => {
    expect(isJunkScope(undefined)).toBe(false);
    expect(isJunkScope('')).toBe(false);
    expect(isJunkScope('/Users/nick/Developer/cli')).toBe(false);
    expect(isJunkScope('/tmpfoo')).toBe(false); // prefix-sharing sibling, not a junk root
    expect(isJunkScope('/Users/nick/vars')).toBe(false); // nor is a name that merely starts the same
  });

  test('junkCwdSql produces NOT LIKE clauses for the qualified column', () => {
    const sql = junkCwdSql('s.cwd');
    expect(sql).toContain('s.cwd NOT LIKE');
    expect(sql).toContain('/var/folders/');
    expect(sql).toContain('/private/tmp/');
    expect(sql).toContain('/ClaudeProbe');
    expect(sql.trimStart().startsWith('AND')).toBe(true);
  });
});

describe('model canonicalization', () => {
  test('isRealModel rejects sentinels', () => {
    expect(isRealModel('<synthetic>')).toBe(false);
    expect(isRealModel('')).toBe(false);
    expect(isRealModel('claude-opus-4-8')).toBe(true);
  });

  test('canonicalModel collapses dated snapshots and provider aliases', () => {
    expect(canonicalModel('claude-opus-4-5-20251101')).toBe(canonicalModel('claude-opus-4-5'));
    expect(canonicalModel('openai/gpt-oss-120b')).toBe(canonicalModel('gpt-oss-120b'));
    expect(canonicalModel('claude-opus-4-8[1m]')).toBe('Opus 4.8');
  });

  test('GPT variants keep their full suffix — no drop or over-merge', () => {
    expect(canonicalModel('gpt-4o')).toBe('GPT-4o'); // not "GPT-4"
    expect(canonicalModel('gpt-5.1-codex-max')).not.toBe(canonicalModel('gpt-5.1-codex-mini'));
    expect(canonicalModel('gpt-5.1-codex-max')).toBe('GPT-5.1-codex-max');
    expect(canonicalModel('gpt-5')).toBe('GPT-5');
  });
});

describe('mineWords paste-proofing', () => {
  test('a word repeated many times in one message counts once (dedup per message)', () => {
    // 'kubernetes' appears 50x in a single pasted message → contributes 1, not 50.
    const paste = { text: `kubernetes ${'kubernetes '.repeat(49)}`, file: 'a' };
    const spread = Array.from({ length: 11 }, (_, i) => ({ text: 'kubernetes deploy', file: `s${i}` }));
    const [top] = mineWords([paste, ...spread], 5);
    expect(top?.word).toBe('kubernetes');
    // 1 (paste) + 11 (spread) messages = 12, not 61 — the paste can't dominate.
    expect(top?.count).toBe(12);
    expect(top?.sessions).toBe(12);
  });

  test('a one-session rant never qualifies (needs spread across sessions)', () => {
    const rant = Array.from({ length: 20 }, () => ({ text: 'flibbertigibbet again', file: 'only-one' }));
    expect(mineWords(rant, 5)).toEqual([]);
  });
});

describe('computeEventStats model tracking', () => {
  const ev = (model: string, ts: string): UsageEvent => ({
    tool: 'claude-code',
    provider: 'anthropic',
    model,
    timestamp: ts,
    sessionId: `s-${model}`,
    projectPath: '/Users/nick/Developer/cli',
    tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  });

  test('the <synthetic> sentinel is never counted as a model tried or a daily top', () => {
    const stats = computeEventStats(
      [ev('<synthetic>', '2026-01-01T12:00:00Z'), ev('claude-opus-4-8', '2026-01-01T13:00:00Z')],
      'UTC',
    );
    // modelFirsts is keyed by canonical display name; synthetic is excluded.
    expect([...stats.modelFirsts.keys()]).toEqual(['Opus 4.8']);
    expect(stats.modelFirsts.has('<synthetic>')).toBe(false);
  });

  test('snapshots pool their daily-leader vote so the merged model earns firstTopDay', () => {
    // 2 opus replies (split across a dated snapshot) vs 1 sonnet reply on the same
    // day → canonical Opus (2) wins; without pooling each opus variant (1) would tie/lose.
    const stats = computeEventStats(
      [
        ev('claude-opus-4-5', '2026-02-01T10:00:00Z'),
        ev('claude-opus-4-5-20251101', '2026-02-01T11:00:00Z'),
        ev('claude-sonnet-4-6', '2026-02-01T12:00:00Z'),
      ],
      'UTC',
    );
    expect(stats.modelFirsts.get('Opus 4.5')?.firstTopDay).toBe('2026-02-01');
    expect(stats.modelFirsts.get('Sonnet 4.6')?.firstTopDay).toBeNull();
  });
});
