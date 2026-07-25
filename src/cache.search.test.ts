import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts now resolves SESSIONS_* env lazily, but the module instance is shared
// across test files in one `bun test` run. So we (re)assert our env and reset the
// cached DB connection before each test — keeping this file hermetic regardless of
// which other cache-importing file (e.g. context.test.ts) ran first or interleaves.
let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
}

function writeClaude(claudeDir: string, id: string, cwd: string, records: unknown[]): void {
  const dir = join(claudeDir, 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => j({ ...(r as object), cwd })).join('\n');
  writeFileSync(join(dir, `${id}.jsonl`), lines);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-cache-'));
  setEnv();
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: ran "docker compose up", Read cache.ts, errored, thinking mentions "memoization".
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'a', '/repoA', [
    {
      type: 'user',
      timestamp: '2026-06-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'set up containers' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'docker compose up' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:02:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repoA/src/cache.ts' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-01T10:03:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'use memoization' }] },
    },
    {
      type: 'user',
      timestamp: '2026-06-01T10:04:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] },
    },
  ]);

  // Session B: clean (no error), its only "docker" mention is in thinking.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'b', '/repoB', [
    {
      type: 'user',
      timestamp: '2026-06-02T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'thoughts' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-02T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'maybe docker later' }] },
    },
  ]);

  // Session C: message-granularity fixture — a genuine typed turn (msg 0), an
  // injected non-genuine turn (msg 1, consumes an index but must not be indexed),
  // and an assistant turn (msg 2). Each carries a unique term for localization.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'c', '/repoC', [
    {
      type: 'user',
      timestamp: '2026-06-03T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'question about flurbnozzle behavior' }] },
      promptSource: 'typed',
    },
    {
      type: 'user',
      timestamp: '2026-06-03T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'sneakyinjected payload from a skill load' }] },
      promptSource: null,
    },
    {
      type: 'assistant',
      timestamp: '2026-06-03T10:02:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the grobblewick answer lives here' }] },
    },
  ]);

  // Sessions D/E/F: files-filter fixtures (phase 3). D edits src/auth.ts and a path
  // with a literal underscore; E only Reads auth.ts (files_read, not files_touched)
  // plus a decoy path that a wildcard `_` would match; F mentions the shared query
  // term but touches no files. E is created after D so newest-first is observable.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'd', '/repoD', [
    {
      type: 'user',
      timestamp: '2026-06-04T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'zanzibar payment refactor' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repoD/src/auth.ts' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-04T10:02:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repoD/src/my_file.ts' } }],
      },
    },
  ]);
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'e', '/repoE', [
    {
      type: 'user',
      timestamp: '2026-06-05T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'zanzibar exploration notes' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-05T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repoE/src/auth.ts' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-05T10:02:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repoE/src/myXfile.ts' } }],
      },
    },
  ]);
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'f', '/repoF', [
    {
      type: 'user',
      timestamp: '2026-06-06T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'zanzibar unrelated chatter' }] },
      promptSource: 'typed',
    },
  ]);

  // Session G: a throwaway under /private/tmp — the automated class searchSessions
  // removes by default. H is the same topic in a real project.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'g', '/private/tmp/scratch-quaxolotl', [
    {
      type: 'user',
      timestamp: '2026-06-07T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'quaxolotl throwaway repro' }] },
      promptSource: 'typed',
    },
  ]);
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'h', '/repoH', [
    {
      type: 'user',
      timestamp: '2026-06-08T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'quaxolotl in a real project' }] },
      promptSource: 'typed',
    },
  ]);

  // Session I: harness bookkeeping around one genuine exchange. The interrupt marker
  // and the tool-load ack carry no promptSource, exactly as Claude writes them, so
  // they clear the genuine-turn gate and only the noise denylist stops them.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'i', '/repoI', [
    {
      type: 'user',
      timestamp: '2026-06-09T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'flimbertrove the deploy step' }] },
      promptSource: 'typed',
    },
    {
      type: 'user',
      timestamp: '2026-06-09T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
    {
      type: 'user',
      timestamp: '2026-06-09T10:02:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Tool loaded.' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-09T10:03:00Z',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: Rate limit reached' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-09T10:04:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-09T10:05:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the flimbertrove step needed a retry' }] },
    },
  ]);

  // Sessions J/K: one term, two message lengths — the short-message damping case.
  // The term appears only in assistant text, so session_fts contributes nothing and
  // the ordering is the message rank alone.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'j', '/repoJ', [
    {
      type: 'user',
      timestamp: '2026-06-10T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'quick question' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-10T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'wobblesprocket?' }] },
    },
  ]);
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'k', '/repoK', [
    {
      type: 'user',
      timestamp: '2026-06-11T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'the long one' }] },
      promptSource: 'typed',
    },
    {
      type: 'assistant',
      timestamp: '2026-06-11T10:01:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text:
              'The root cause is that the wobblesprocket is initialized before the configuration ' +
              'is read, so every downstream consumer sees the default gear ratio instead of the ' +
              'configured one. Moving the wobblesprocket initializer after the config load fixes ' +
              'it, and the regression test asserts the ratio the config asked for.',
          },
        ],
      },
    },
  ]);

  // Sessions L/M: the same two words, adjacent in L and scattered in M — the phrase
  // query case.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'l', '/repoL', [
    {
      type: 'user',
      timestamp: '2026-06-12T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'the deploy failed on plumbus grommet timing' }] },
      promptSource: 'typed',
    },
  ]);
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'm', '/repoM', [
    {
      type: 'user',
      timestamp: '2026-06-13T10:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'the plumbus was fine but the grommet needed replacing' }],
      },
      promptSource: 'typed',
    },
  ]);

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
});

test('indexes new content: a command query finds the session that ran it', async () => {
  const r = await cache.searchSessions('docker', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});

test('commands and paths are findable: a file-path query matches a Read target', async () => {
  const r = await cache.searchSessions('cache.ts', {});
  expect(r.map((x) => x.sessionId)).toContain('a');
});

test('ranking: a command hit outranks a thinking-only hit for the same term', async () => {
  const r = await cache.searchSessions('docker', {});
  const aIdx = r.findIndex((x) => x.sessionId === 'a');
  const bIdx = r.findIndex((x) => x.sessionId === 'b');
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThanOrEqual(0);
  expect(aIdx).toBeLessThan(bIdx); // A (command) ranked above B (thinking)
});

test('errored filter and metadata: only errored sessions, with files/commands/errored populated', async () => {
  const r = await cache.searchSessions('', { errored: true });
  expect(r.map((x) => x.sessionId)).toContain('a');
  expect(r.map((x) => x.sessionId)).not.toContain('b');
  const a = r.find((x) => x.sessionId === 'a')!;
  expect(a.errored).toBe(true);
  expect(a.commands).toContain('docker compose up');
  expect(a.files).toContain('/repoA/src/cache.ts'); // read target surfaced in metadata
});

// ——— message-granularity (schema v7) tests — additive; do not modify cases above ———

function ignoredRow(filePath: string): { mtime: number; size: number } | null {
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    return (
      db
        .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM ignored_files WHERE file_path = ?')
        .get(filePath) ?? null
    );
  } finally {
    db.close();
  }
}

function messageRowCount(filePath: string): number {
  // Independent read-only connection (WAL allows concurrent readers) to assert
  // row-level state that the search API alone can't prove.
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    const row = db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM message_fts WHERE file_path = ?')
      .get(filePath);
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

const cPath = () => join(process.env.SESSIONS_CLAUDE_DIR!, 'proj', 'c.jsonl');

test('localization: a term seeded only in message N yields messageHits[0].index === N', async () => {
  const r = await cache.searchSessions('grobblewick', {});
  const c = r.find((x) => x.sessionId === 'c')!;
  expect(c).toBeDefined();
  expect(c.messageHits![0]!.index).toBe(2);
  expect(c.messageHits![0]!.role).toBe('assistant');
  expect(c.messageHits![0]!.snippet).toContain('grobblewick');
  expect(c.displayText).toContain('grobblewick'); // localized snippet is the display text
});

test('localization: a genuine user-turn hit carries index 0 and role user', async () => {
  const r = await cache.searchSessions('flurbnozzle', {});
  const c = r.find((x) => x.sessionId === 'c')!;
  expect(c).toBeDefined();
  expect(c.messageHits![0]!.index).toBe(0);
  expect(c.messageHits![0]!.role).toBe('user');
});

test('non-genuine user turn text is not searchable, but its index is still counted', async () => {
  const r = await cache.searchSessions('sneakyinjected', {});
  expect(r.map((x) => x.sessionId)).not.toContain('c');
  // The injected turn consumed index 1: the assistant hit sits at 2, not 1.
  const g = await cache.searchSessions('grobblewick', {});
  expect(g.find((x) => x.sessionId === 'c')!.messageHits![0]!.index).toBe(2);
});

test('metadata-only match (command term) returns the session with empty messageHits', async () => {
  const r = await cache.searchSessions('docker', {});
  const a = r.find((x) => x.sessionId === 'a')!;
  expect(a).toBeDefined(); // "docker compose up" lives only in the commands column
  expect(a.messageHits).toEqual([]);
});

test('message_fts rows: genuine user + assistant turns only (injected turn gets no row)', () => {
  expect(messageRowCount(cPath())).toBe(2); // indices 0 and 2; index 1 skipped-but-counted
});

test('re-index idempotency: an mtime touch leaves no duplicate message rows', async () => {
  const future = new Date(Date.now() + 5000);
  utimesSync(cPath(), future, future);
  await cache.refreshIndex();
  expect(messageRowCount(cPath())).toBe(2);
  const r = await cache.searchSessions('grobblewick', {});
  expect(r.filter((x) => x.sessionId === 'c')).toHaveLength(1);
  expect(r.find((x) => x.sessionId === 'c')!.messageHits).toHaveLength(1);
});

test('concurrent refreshes coalesce onto a single scan instead of each redoing the work', async () => {
  const future = new Date(Date.now() + 10_000);
  utimesSync(cPath(), future, future);

  const results = await Promise.all(Array.from({ length: 8 }, () => cache.refreshIndex()));
  expect(results.every((result) => result.updated === 1)).toBe(true);
  expect(messageRowCount(cPath())).toBe(2);
});

test('unchanged invalid transcripts are tracked in the negative inventory cache, then pruned', async () => {
  const path = join(process.env.SESSIONS_CLAUDE_DIR!, 'proj', 'ignored.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', timestamp: '2026-06-06T12:00:00Z' }));
  try {
    await cache.refreshIndex();
    expect(ignoredRow(path)?.size).toBeGreaterThan(0);

    // The whole point of the table: an unindexable file stops being a candidate.
    expect((await cache.refreshIndex()).updated).toBe(0);
  } finally {
    // Unconditional, so a failure above cannot leak this transcript into the
    // shared fixture dir and skew the tests that follow.
    rmSync(path, { force: true });
  }

  await cache.refreshIndex();
  expect(ignoredRow(path)).toBeNull();
});

test('pruning: deleting the file empties both FTS tables for it', async () => {
  const path = cPath();
  rmSync(path);
  await cache.refreshIndex();
  expect(messageRowCount(path)).toBe(0);
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    const n = db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM session_fts WHERE file_path = ?').get(path);
    expect(n?.n ?? 0).toBe(0);
  } finally {
    db.close();
  }
  const r = await cache.searchSessions('grobblewick', {});
  expect(r.map((x) => x.sessionId)).not.toContain('c');
});

// ——— files filter (phase 3) tests — additive; do not modify cases above ———

test('files filter: matches touched (d) and read (e) paths, newest-first, others absent', async () => {
  const r = await cache.searchSessions('', { files: ['src/auth.ts'] });
  // E only Read the path (files_read), D edited it (files_touched); E is newer → first.
  expect(r.map((x) => x.sessionId)).toEqual(['e', 'd']);
});

test('files filter: multiple values AND-compose', async () => {
  const r = await cache.searchSessions('', { files: ['auth.ts', 'my_file.ts'] });
  expect(r.map((x) => x.sessionId)).toEqual(['d']); // E matches auth.ts but not my_file.ts
});

test('files filter + query: only sessions satisfying both', async () => {
  const all = await cache.searchSessions('zanzibar', {});
  expect(all.map((x) => x.sessionId)).toContain('f'); // query alone reaches F…
  const r = await cache.searchSessions('zanzibar', { files: ['src/auth.ts'] });
  const ids = r.map((x) => x.sessionId);
  expect(ids.sort()).toEqual(['d', 'e']); // …but the filter narrows F out
  const one = await cache.searchSessions('zanzibar', { files: ['my_file.ts'] });
  expect(one.map((x) => x.sessionId)).toEqual(['d']);
});

test('files filter: LIKE metacharacters match literally (underscore is not a wildcard)', async () => {
  const r = await cache.searchSessions('', { files: ['my_file.ts'] });
  expect(r.map((x) => x.sessionId)).toEqual(['d']); // must NOT match E's myXfile.ts
});

test('files filter: empty array is treated as absent', async () => {
  const filtered = await cache.searchSessions('', { files: [] });
  const unfiltered = await cache.searchSessions('', {});
  expect(filtered.map((x) => x.sessionId)).toEqual(unfiltered.map((x) => x.sessionId));
});

test('files filter: a short fragment matches multiple distinct paths (documented false positive)', async () => {
  // 'file.ts' is a substring of both '/repoD/src/my_file.ts' and '/repoE/src/myXfile.ts' —
  // substring matching trades precision for zero normalization; pass longer suffixes to narrow.
  const r = await cache.searchSessions('', { files: ['file.ts'] });
  expect(r.map((x) => x.sessionId)).toEqual(['e', 'd']);
});

test('hardening: busy_timeout is set and a corrupt DB rebuilds instead of throwing', async () => {
  // busy_timeout present (proxy: the index path resolves to index.db as expected).
  expect(cache.getDbPath().endsWith('index.db')).toBe(true);

  // Corrupt the DB file, then a search must self-heal (rebuild) rather than throw.
  cache.closeDb();
  writeFileSync(cache.getDbPath(), 'not a sqlite database at all');
  const r = await cache.searchSessions('docker', {});
  expect(Array.isArray(r)).toBe(true);
  expect(r.map((x) => x.sessionId)).toContain('a'); // rebuilt + reindexed
});

test('grep: exhaustive literal match counts every session and message', async () => {
  const r = await cache.grepSessions('zanzibar', {});
  expect(r.totalHits).toBe(3); // D, E, F each mention it once
  expect(r.totalSessions).toBe(3);
  expect(r.hits.every((h) => h.snippet.toLowerCase().includes('zanzibar'))).toBe(true);
});

test('grep: hit msgIndex + role align with the message it matched', async () => {
  // Self-contained fixture: a genuine user turn (index 0), a non-genuine injected turn
  // (index 1, counted-but-unindexed), then an assistant text turn (index 2). The unique
  // assistant term must resolve to index 2 for offset navigation to land correctly.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'galign', '/repoG', [
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'alignquestion here' }] },
    },
    {
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: [{ type: 'text', text: 'injected alignskip' }] },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the alignanswer lives here' }] },
    },
  ]);
  const r = await cache.grepSessions('alignanswer', {});
  expect(r.totalHits).toBe(1);
  const h = r.hits[0]!;
  expect(h.sessionId).toBe('galign');
  expect(h.role).toBe('assistant');
  expect(h.msgIndex).toBe(2); // index 1 is the non-genuine turn, skipped-but-counted
  // The non-genuine turn's text is never indexed, so grep can't reach it.
  expect((await cache.grepSessions('alignskip', {})).totalHits).toBe(0);
});

test('grep: non-genuine (injected) user text is not searchable', async () => {
  // Self-contained so it proves the filter, not a fixture-deletion side effect: seed a
  // session with a genuine turn + an injected (promptSource:null) turn, each with a unique
  // term. The genuine term is found; the injected term (never indexed) is not.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'gnongenuine', '/repoG', [
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'genuineterm one' }] },
    },
    {
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: [{ type: 'text', text: 'ghostterm injected' }] },
    },
  ]);
  expect((await cache.grepSessions('genuineterm', {})).totalHits).toBe(1); // session is indexed
  expect((await cache.grepSessions('ghostterm', {})).totalHits).toBe(0); // injected turn excluded
});

test('grep: exhaustiveness at message granularity — 2 matches in one session', async () => {
  // The shared fixtures never put 2+ matching messages in one session, so totalHits and
  // totalSessions always coincide there. This proves grep counts every matching MESSAGE,
  // not just every session.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'gmulti', '/repoG', [
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'twinterm appears here' }] },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'and twinterm appears again' }] },
    },
  ]);
  const r = await cache.grepSessions('twinterm', {});
  expect(r.totalHits).toBe(2); // both messages
  expect(r.totalSessions).toBe(1); // in one session
});

test('grep: case-insensitive literal stays exhaustive for non-ASCII (LIKE prefilter is skipped)', async () => {
  // Regression for the Unicode fold gap: SQLite LIKE folds ASCII only, so a `%café%`
  // prefilter would drop a stored "CAFÉ" that the JS /café/i regex matches. The prefilter
  // must be skipped for non-ASCII case-insensitive patterns.
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'gunicode', '/repoG', [
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'migrated the CAFÉ table' }] },
    },
  ]);
  expect((await cache.grepSessions('café', {})).totalHits).toBe(1); // é folds to É
  expect((await cache.grepSessions('café', { ignoreCase: false })).totalHits).toBe(0);
});

test('grep: an empty pattern is rejected rather than dumping the whole corpus', async () => {
  await expect(cache.grepSessions('', {})).rejects.toThrow(/Empty pattern/);
});

test('grep: a fractional limit is floored, not treated as its ceiling', async () => {
  const r = await cache.grepSessions('zanzibar', { limit: 1.5 });
  expect(r.returnedHits).toBe(1); // floor(1.5), not 2
  expect(r.totalHits).toBe(3);
});

test('grep: role filter restricts to user or assistant turns', async () => {
  expect((await cache.grepSessions('zanzibar', { role: 'user' })).totalHits).toBe(3);
  expect((await cache.grepSessions('zanzibar', { role: 'assistant' })).totalHits).toBe(0);
});

test('grep: regex mode matches a pattern, literal mode treats it as text', async () => {
  writeClaude(process.env.SESSIONS_CLAUDE_DIR!, 'gregex', '/repoG', [
    {
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: [{ type: 'text', text: 'regexterm sample' }] },
    },
  ]);
  expect((await cache.grepSessions('reg[e3]xterm', { regex: true })).totalHits).toBe(1);
  expect((await cache.grepSessions('reg[e3]xterm', { regex: false })).totalHits).toBe(0);
});

test('grep: project and tool filters scope results', async () => {
  expect((await cache.grepSessions('zanzibar', { project: '/repoD' })).totalSessions).toBe(1);
  expect((await cache.grepSessions('zanzibar', { tool: 'claude' })).totalHits).toBe(3);
  expect((await cache.grepSessions('zanzibar', { tool: 'codex' })).totalHits).toBe(0);
});

test('grep: limit caps returned snippets but totalHits counts all (honest truncation)', async () => {
  const r = await cache.grepSessions('zanzibar', { limit: 1 });
  expect(r.returnedHits).toBe(1);
  expect(r.totalHits).toBe(3);
  expect(r.truncated).toBe(true);
});

test('grep: case-insensitive by default, exact when ignoreCase=false', async () => {
  expect((await cache.grepSessions('ZANZIBAR', {})).totalHits).toBe(3);
  expect((await cache.grepSessions('ZANZIBAR', { ignoreCase: false })).totalHits).toBe(0);
});

test('grep: an invalid regex throws a friendly error', async () => {
  await expect(cache.grepSessions('(unclosed', { regex: true })).rejects.toThrow(/Invalid regex/);
});

// ——— categorical removal + scorer corrections (schema v10) — additive ———

test('automated cwds are removed from search, not merely out-ranked', async () => {
  const r = await cache.searchSessions('quaxolotl', {});
  expect(r.map((x) => x.sessionId)).toEqual(['h']); // G lives under /private/tmp
});

test('a caller scoped straight at an automated project still gets it', async () => {
  const r = await cache.searchSessions('quaxolotl', { project: '/private/tmp/scratch-quaxolotl' });
  expect(r.map((x) => x.sessionId)).toEqual(['g']);
  // and the opt-out returns it unscoped, for callers that want everything
  const all = await cache.searchSessions('quaxolotl', { includeAutomated: true });
  expect(all.map((x) => x.sessionId).sort()).toEqual(['g', 'h']);
});

test('the automated filter applies to the no-query listing too', async () => {
  const r = await cache.searchSessions('', { limit: 100 });
  expect(r.map((x) => x.sessionId)).not.toContain('g');
});

test('grep stays exhaustive: it still reaches an automated cwd', async () => {
  expect((await cache.grepSessions('quaxolotl', {})).totalSessions).toBe(2);
});

test('harness noise rows are not searchable in either role', async () => {
  // 'interrupted' and 'loaded' are user-role banners — the ones that would otherwise
  // also collect the user-hit boost; 'requested' is the assistant-role one.
  for (const term of ['interrupted', 'loaded', 'requested']) {
    const r = await cache.searchSessions(term, {});
    expect(r.map((x) => x.sessionId)).not.toContain('i');
  }
  // the genuine turns around them are untouched
  const r = await cache.searchSessions('flimbertrove', {});
  expect(r.map((x) => x.sessionId)).toEqual(['i']);
  // 1 genuine user turn + 1 real assistant turn; the four banners get no row
  expect(messageRowCount(join(process.env.SESSIONS_CLAUDE_DIR!, 'proj', 'i.jsonl'))).toBe(2);
  // The transport-error banner is also counted as an error, so extractErrors still
  // copies it into session_fts.context_text and the session stays findable that way —
  // a metadata match with no message hit. Removing it there is a separate decision:
  // the same text drives `errored`, error_count and wrapped's error census.
  const api = (await cache.searchSessions('API Error', {})).find((x) => x.sessionId === 'i');
  expect(api?.messageHits).toEqual([]);
});

test('damping: a substantive message outranks a short aside carrying the same term', async () => {
  const r = await cache.searchSessions('wobblesprocket', {});
  expect(r.map((x) => x.sessionId)).toEqual(['k', 'j']);
});

test('phrase query: a quoted span matches the phrase, not an OR of its words', async () => {
  const loose = await cache.searchSessions('plumbus grommet', {});
  expect(loose.map((x) => x.sessionId).sort()).toEqual(['l', 'm']);
  const phrase = await cache.searchSessions('"plumbus grommet"', {});
  expect(phrase.map((x) => x.sessionId)).toEqual(['l']);
});

test('buildFtsQuery: quoted spans become phrases, everything else stays a literal term', () => {
  expect(cache.buildFtsQuery('plumbus grommet')).toBe('"plumbus" OR "grommet"');
  expect(cache.buildFtsQuery('"plumbus grommet" timing')).toBe('"plumbus grommet" OR "timing"');
  expect(cache.buildFtsQuery('  "  spaced   out  "  ')).toBe('"spaced out"');
});

test('buildFtsQuery: FTS5 operators in unquoted input stay literal', () => {
  expect(cache.buildFtsQuery('plumbus AND grommet*')).toBe('"plumbus" OR "AND" OR "grommet*"');
  expect(cache.buildFtsQuery('foo NEAR/3 -bar ^baz')).toBe('"foo" OR "NEAR/3" OR "-bar" OR "^baz"');
});

test('buildFtsQuery: an unbalanced quote degrades to terms instead of swallowing the query', () => {
  expect(cache.buildFtsQuery('exit "code 1')).toBe('"exit" OR "code" OR "1"');
  expect(cache.buildFtsQuery('"')).toBe('');
  expect(cache.buildFtsQuery('""')).toBe('');
});

test('an FTS5-operator query runs as a literal search instead of erroring', async () => {
  // "AND" is also an ordinary word, so other sessions legitimately match it — the
  // point is that the query parses and still finds the two plumbus sessions.
  const ids = (await cache.searchSessions('plumbus AND grommet*', {})).map((x) => x.sessionId);
  expect(ids).toContain('l');
  expect(ids).toContain('m');
});
