// Serialized-size ceilings for the MCP tools, built on PATHOLOGICAL sessions: one 9KB
// command, 100 long multi-line commands, 200 file paths. Tidy fixtures pass whether or
// not the bounds exist — these fail the moment a payload goes unbounded again.
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_COMMAND_LEN } from './extract-commands';
import { MAX_RESULT_COMMANDS, MAX_RESULT_FILES, RESULT_COMMAND_MAX } from './search-format';
import { DIGEST_MAX_CHARS } from './digest';

const j = (o: unknown): string => JSON.stringify(o);

/** Copies of each pathological shape — enough to fill a default-limit (20) page. */
const COPIES = 7;

// Ceilings, in serialized chars (~4 chars per token). A full 20-result page of the worst
// sessions we can construct must stay under 40k ≈ 10k tokens; the same query shape
// against the real index measured ~215k at limit 10 before these bounds landed.
const SEARCH_CEILING = 40_000;
const SEARCH_RESULT_CEILING = 3_500;
const GREP_CEILING = 40_000;

let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');
let dir: string;

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db');
}

function userTurn(cwd: string, ts: string, text: string): string {
  return j({
    type: 'user',
    cwd,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: 'typed',
  });
}

function bashTurn(cwd: string, ts: string, command: string): string {
  return j({
    type: 'assistant',
    cwd,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });
}

function editTurn(cwd: string, ts: string, filePath: string): string {
  return j({
    type: 'assistant',
    cwd,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: filePath } }] },
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-budget-'));
  setEnv();
  dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Enough of each shape that a default-limit (20) search fills up entirely with
  // worst-case sessions — the total ceiling below is only meaningful at a full page.
  for (let n = 0; n < COPIES; n++) {
    // One 9KB command — the shape that put a single session's `commands` over 50k chars.
    writeFileSync(
      join(dir, `huge-${n}.jsonl`),
      [
        userTurn(`/repoHuge-${n}`, '2026-06-01T10:00:00Z', 'run the mangowurzel migration'),
        bashTurn(
          `/repoHuge-${n}`,
          '2026-06-01T10:01:00Z',
          `psql <<'SQL'\n${'-- mangowurzel padding\n'.repeat(400)}SQL`,
        ),
      ].join('\n'),
    );

    // 100 distinct long multi-line commands — hits MAX_COMMANDS with every slot expensive.
    writeFileSync(
      join(dir, `many-cmds-${n}.jsonl`),
      [
        userTurn(`/repoCmds-${n}`, '2026-06-02T10:00:00Z', 'grind through the mangowurzel backfill'),
        ...Array.from({ length: 120 }, (_, i) =>
          bashTurn(`/repoCmds-${n}`, '2026-06-02T10:01:00Z', `bash -c 'run ${i} ${'y'.repeat(700)}'\ntrailing ${i}`),
        ),
      ].join('\n'),
    );

    // 200 file paths, each long enough to matter.
    writeFileSync(
      join(dir, `many-files-${n}.jsonl`),
      [
        userTurn(`/repoFiles-${n}`, '2026-06-03T10:00:00Z', 'sweep the mangowurzel imports'),
        ...Array.from({ length: 200 }, (_, i) =>
          editTurn(
            `/repoFiles-${n}`,
            '2026-06-03T10:01:00Z',
            `/repoFiles-${n}/packages/deeply/nested/module-${i}/src/index.ts`,
          ),
        ),
      ].join('\n'),
    );
  }

  cache = await import('./cache');
  cache.closeDb();
  await cache.refreshIndex();
  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb();
});

afterAll(() => {
  cache.closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test('write path: a 9KB command reaches the index clipped to MAX_COMMAND_LEN', async () => {
  const res = await mcp.runSearchSessions({ query: 'migration' });
  const parsed = JSON.parse(res.content[0]!.text);
  const hit = parsed.find((r: { project: string }) => r.project === '/repoHuge-0');
  expect(hit).toBeDefined();
  expect(hit.commandsIndexed).toBe(1);
  // Read path clips further, so assert the stored bound through the raw search result.
  const raw = await cache.searchSessions('migration', { limit: 20 });
  const stored = raw.find((r) => r.cwd === '/repoHuge-0')!.commands[0]!;
  expect(stored.length).toBeLessThanOrEqual(MAX_COMMAND_LEN);
});

test('search_sessions stays under budget at the default limit over pathological sessions', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel', limit: 20 });
  const text = res.content[0]!.text;
  expect(text.length).toBeLessThanOrEqual(SEARCH_CEILING);

  const parsed = JSON.parse(text);
  expect(parsed).toHaveLength(20); // a full page, every result a pathological session
  for (const r of parsed) {
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(SEARCH_RESULT_CEILING);
    expect(r.commands.length).toBeLessThanOrEqual(MAX_RESULT_COMMANDS);
    expect(r.files.length).toBeLessThanOrEqual(MAX_RESULT_FILES);
    for (const c of r.commands) expect(c.length).toBeLessThanOrEqual(RESULT_COMMAND_MAX + 1);
  }
});

test('search_sessions reports what the index holds beside the capped arrays', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel', limit: 20 });
  const parsed = JSON.parse(res.content[0]!.text);
  const cmds = parsed.find((r: { project: string }) => r.project === '/repoCmds-0');
  // 120 commands were run and the index keeps MAX_COMMANDS of them, so the reported
  // count is the index's, not the session's — which is what `commandsIndexed` claims.
  expect(cmds.commandsIndexed).toBe(100);
  expect(cmds.commands).toHaveLength(MAX_RESULT_COMMANDS);
  const files = parsed.find((r: { project: string }) => r.project === '/repoFiles-0');
  expect(files.filesIndexed).toBeGreaterThan(MAX_RESULT_FILES);
  expect(files.files).toHaveLength(MAX_RESULT_FILES);
});

test('grep_sessions stays under budget at the default limit', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'mangowurzel', limit: 50 });
  expect(res.content[0]!.text.length).toBeLessThanOrEqual(GREP_CEILING);
});

test('get_session_digest stays under budget on the 100-command session', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(dir, 'many-cmds-0.jsonl') });
  expect(res.content[0]!.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
});

test('MCP payloads are not pretty-printed', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel', limit: 20 });
  expect(res.content[0]!.text).not.toMatch(/\n\s+"/); // no indented keys
});
