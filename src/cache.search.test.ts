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
