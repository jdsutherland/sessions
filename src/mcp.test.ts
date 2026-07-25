import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const j = (o: unknown): string => JSON.stringify(o);

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run. So we (re)assert our env and reset the cached DB
// connection before each test — keeping this file hermetic regardless of which other
// cache-importing file (cache.search.test.ts, context.test.ts) ran first or interleaves.
let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_MEMORY_DB = join(tmp, 'memory.db'); // absent → the primer reads no lessons
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-'));
  setEnv();
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: typed "deploy", then ran "kubectl apply". No error.
  writeFileSync(
    join(dir, 'a.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'deploy' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl apply' } }],
        },
      }),
    ].join('\n'),
  );

  // Session B: multi-message session for hit→offset alignment — the unique term
  // sits in the third message (index 2), so a correct offset is load-bearing.
  writeFileSync(
    join(dir, 'b.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'investigate the flaky retry test' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking into it now' }] },
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:02:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'applied the mangowurzel fix to the retry logic' }],
        },
      }),
    ].join('\n'),
  );

  // Session C: files-filter fixture (phase 3) — edits a file no other session touches.
  writeFileSync(
    join(dir, 'c.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'wire up billing' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repoC/src/billing.ts' } }],
        },
      }),
    ].join('\n'),
  );

  // Session D: a Codex rollout. Envelope shapes are the real ones (the authority is
  // src/__fixtures__/codex, captured from ~/.codex/sessions); the prose is controlled
  // here because the alignment assertion below needs a term unique to one message.
  const codexDir = join(tmp, 'codex', '2026', '06', '04');
  mkdirSync(codexDir, { recursive: true });
  const ri = (payload: unknown, at: string): string => j({ timestamp: at, type: 'response_item', payload });
  writeFileSync(
    join(codexDir, 'rollout-2026-06-04T10-00-00-019dc17e-b2db-7343-8066-3bea6c30d63a.jsonl'),
    [
      j({
        timestamp: '2026-06-04T10:00:00Z',
        type: 'session_meta',
        payload: { id: '019dc17e-b2db-7343-8066-3bea6c30d63a', cwd: '/repoD', git: { branch: 'main' } },
      }),
      // The injected system prompt: present in every rollout, never a turn.
      ri(
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] },
        '2026-06-04T10:00:01Z',
      ),
      ri(
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trace the snorkelbeam timeout' }] },
        '2026-06-04T10:00:02Z',
      ),
      ri({ type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAAAB…' }, '2026-06-04T10:00:03Z'),
      ri(
        {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_1',
          arguments: j({ cmd: 'rg snorkelbeam', workdir: '/repoD' }),
        },
        '2026-06-04T10:00:04Z',
      ),
      ri({ type: 'function_call_output', call_id: 'call_1', output: 'no matches' }, '2026-06-04T10:00:05Z'),
      // The richer event-stream copy of the same exec: resolved argv and an exit code,
      // which is why extractCommands reads this and not the function_call arguments.
      j({
        timestamp: '2026-06-04T10:00:05Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call_1',
          command: ['/bin/zsh', '-lc', 'rg snorkelbeam'],
          cwd: '/repoD',
          exit_code: 0,
          stdout: '',
          stderr: '',
        },
      }),
      ri(
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'the timeout is in the retry wrapper' }],
        },
        '2026-06-04T10:00:06Z',
      ),
      // The genuineness oracle, which Codex writes AFTER its response_item twin.
      j({
        timestamp: '2026-06-04T10:00:07Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'trace the snorkelbeam timeout', images: [] },
      }),
      // The UI copy of the assistant turn — indexing both would double-count it.
      j({
        timestamp: '2026-06-04T10:00:08Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'the timeout is in the retry wrapper' },
      }),
    ].join('\n'),
  );

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();
  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
});

test('search_sessions handler returns metadata + resumeCommand', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed[0].commands).toContain('kubectl apply');
  expect(parsed[0].resumeCommand).toContain('claude --resume');
});

test('search_sessions handler honors the errored filter', async () => {
  const res = await mcp.runSearchSessions({ errored: true });
  expect(res.content[0]!.text).toContain('No sessions found'); // session A did not error
});

// ——— message-granularity (schema v7) tests — additive ———

test('alignment: messageHits[0].index feeds get_session_messages(offset) to the matched text', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel' });
  const parsed = JSON.parse(res.content[0]!.text);
  const hit = parsed[0].messageHits[0];
  expect(hit.index).toBe(2);
  expect(hit.role).toBe('assistant');

  const page = await mcp.runGetSessionMessages({ filePath: parsed[0].filePath, offset: hit.index, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.returned).toBe(1);
  expect(paged.messages[0].text).toContain('mangowurzel');
});

// The whole point of the record: before it, every indexed Codex session had zero
// message_fts rows and a blank first_prompt, so none of this was reachable.
test('codex: a rollout indexes, and its hit index still feeds get_session_messages', async () => {
  const res = await mcp.runSearchSessions({ query: 'snorkelbeam' });
  const parsed = JSON.parse(res.content[0]!.text);
  const d = parsed.find((r: { tool: string }) => r.tool === 'codex');
  expect(d.sessionId).toBe('019dc17e-b2db-7343-8066-3bea6c30d63a'); // the id, not the rollout filename
  expect(d.snippet).toBe('trace the snorkelbeam timeout');
  expect(d.commands[0]).toContain('rg snorkelbeam'); // resolved argv, from exec_command_end
  expect(d.resumeCommand).toBe('cd "/repoD"'); // Codex has no resume flag

  const hit = d.messageHits[0];
  const page = await mcp.runGetSessionMessages({ filePath: d.filePath, offset: hit.index, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  // Two messages, not three: the developer prompt is not a turn and the agent_message
  // event is the same assistant turn the response_item already carries.
  expect(paged.total).toBe(2);
  expect(paged.messages[0].text).toContain('snorkelbeam');
  expect(paged.messages[0].at).toBe('2026-06-04T10:00:02Z');
});

test('get_session_messages carries each turn timestamp', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel' });
  const parsed = JSON.parse(res.content[0]!.text);
  const page = await mcp.runGetSessionMessages({ filePath: parsed[0].filePath, offset: 0, limit: 3 });
  expect(JSON.parse(page.content[0]!.text).messages.map((m: { at: string }) => m.at)).toEqual([
    '2026-06-02T10:00:00Z',
    '2026-06-02T10:01:00Z',
    '2026-06-02T10:02:00Z',
  ]);
});

test('search_sessions: a metadata-only match carries empty messageHits', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' }); // lives only in commands
  const parsed = JSON.parse(res.content[0]!.text);
  const a = parsed.find((r: { sessionId: string }) => r.sessionId === 'a');
  expect(a.messageHits).toEqual([]);
});

// ——— files filter (phase 3) tests — additive ———

test('search_sessions: files param reaches SearchOptions; result shape unchanged', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/billing.ts'] });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.map((r: { sessionId: string }) => r.sessionId)).toEqual(['c']); // a and b excluded
  expect(parsed[0].files).toContain('/repoC/src/billing.ts');
  expect(parsed[0].resumeCommand).toContain('claude --resume'); // shape unchanged
});

test('search_sessions: a non-matching files filter returns no sessions', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/does-not-exist.ts'] });
  expect(res.content[0]!.text).toContain('No sessions found');
});

// ——— get_session_digest (phase 2) tests — additive ———

test('get_session_digest returns exchange shape within budget', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'claude', 'proj', 'b.jsonl') });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.messageCount).toBe(3);
  expect(digest.exchangeCount).toBe(1);
  expect(digest.elided).toBe(0);
  expect(digest.exchanges).toHaveLength(1);
  expect(digest.exchanges[0].index).toBe(0);
  expect(digest.exchanges[0].user).toContain('investigate the flaky retry test');
  expect(digest.exchanges[0].assistant).toContain('mangowurzel'); // last assistant wins
  expect(JSON.stringify(digest).length).toBeLessThanOrEqual(8000);
});

test('get_session_digest flags unreadable files with isError', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'nope', 'missing.jsonl') });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Could not read session');
});

test('get_session_digest returns empty exchanges for sessions with no genuine turns', async () => {
  // Standalone fixture outside the scanned dirs — the digest reads files directly.
  const file = join(tmp, 'hook-only.jsonl');
  writeFileSync(
    file,
    [
      j({
        type: 'user',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'injected hook context' }] },
        promptSource: null,
      }),
    ].join('\n'),
  );
  const res = await mcp.runGetSessionDigest({ filePath: file });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.exchanges).toEqual([]);
  expect(digest.messageCount).toBe(1);
});

// ——— grep_sessions — additive ———

test('grep_sessions: exhaustive hit carries msgIndex that feeds get_session_messages', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'flaky' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.totalHits).toBe(1);
  expect(parsed.totalSessions).toBe(1);
  const hit = parsed.hits[0];
  expect(hit.sessionId).toBe('b');
  expect(hit.role).toBe('user');
  expect(hit.resumeCommand).toContain('claude --resume');

  const page = await mcp.runGetSessionMessages({ filePath: hit.filePath, offset: hit.msgIndex, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.messages[0].text).toContain('flaky');
});

test('grep_sessions: regex mode matches an assistant turn', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'mango\\w+', regex: true });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.hits[0].role).toBe('assistant');
  expect(parsed.hits[0].msgIndex).toBe(2);
});

test('grep_sessions: no match returns a friendly message', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'nonexistent-term-xyz' });
  expect(res.content[0]!.text).toContain('No matching messages found');
});

test('grep_sessions: an invalid regex surfaces isError', async () => {
  const res = await mcp.runGrepSessions({ pattern: '(unclosed', regex: true });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Invalid regex');
});

// ——— get_session_messages include_tools — additive ———

test('get_session_messages include_tools renders the turn tool calls', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1, includeTools: true });
  const parsed = JSON.parse(res.content[0]!.text);
  // Session C's Edit is a pure-tool-use turn folded onto the user turn (index 0).
  expect(parsed.messages[0].tools).toContain('Edit(/repoC/src/billing.ts)');
});

test('get_session_messages omits tools by default (back-compat shape)', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1 });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.messages[0].tools).toBeUndefined();
});

// ——— stdio lifecycle ———

test('server exits when the client closes stdin instead of lingering as an orphan', async () => {
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '..', 'index.ts'), '--mcp'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );
  await proc.stdin.flush();
  // Wait for the initialize response so the transport is fully wired before we hang up.
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  proc.stdin.end(); // simulate the parent client dying
  const result = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'orphaned' as const)]);
  if (result === 'orphaned') proc.kill();
  expect(result).toBe(0);
}, 15000);

// ——— remember_lesson ———

/** A real git repo, so resolveRepo returns a container the way it does in production. */
function initRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(['git', 'init', '-q', dir]);
  Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', 'git@github.com:nicknisi/probe.git']);
  return realpathSync(dir); // git reports the resolved path; /var is a symlink on macOS
}

function parse(res: { content: { text: string }[] }): any {
  return JSON.parse(res.content[0]!.text);
}

test('remember_lesson saves a repo-scoped lesson and reports how provenance was resolved', async () => {
  const repo = initRepo('lesson-repo');
  const memory = await import('./memory');
  memory.closeMemoryDb();

  const res = mcp.runRememberLesson({
    lesson: 'The webhook retry budget is per-endpoint, not per-account.',
    detail: 'src/webhooks/retry.ts: the limiter keys on endpoint id',
    cwd: repo,
  });
  const out = parse(res);

  expect(res.isError).toBeUndefined();
  expect(out.outcome).toBe('saved');
  expect(out.provenance).toBe('none'); // no _meta, no env id → said plainly, not invented
  expect(out.sourceVerified).toBe(false);

  const stored = memory.listLessons({ all: true }).find((r) => r.id === out.id)!;
  expect(stored.repo_container).toBe(repo);
  expect(stored.repo_remote).toBe('github.com/nicknisi/probe');
  expect(stored.source_session).toBeNull();
});

test('remember_lesson takes no session id — a codex _meta id is what resolves it', async () => {
  const repo = initRepo('lesson-meta');
  const memory = await import('./memory');
  memory.closeMemoryDb();

  const sessionId = '019f9a9b-2222-4333-8444-555555555555';
  const rolloutDir = join(tmp, 'codex', '2026', '07', '25');
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(join(rolloutDir, `rollout-2026-07-25T13-44-01-${sessionId}.jsonl`), '{}\n');

  const out = parse(
    mcp.runRememberLesson(
      { lesson: 'Codex rollouts are append-then-frozen, so an mtime skip strands them.', cwd: repo },
      { 'x-codex-turn-metadata': { session_id: sessionId }, threadId: sessionId },
    ),
  );

  expect(out.provenance).toBe('meta');
  expect(out.sourceVerified).toBe(true);
  const stored = memory.listLessons({ all: true }).find((r) => r.id === out.id)!;
  expect(stored.source_session).toBe(sessionId);
  expect(stored.source_transcript).toContain(sessionId);
});

test('remember_lesson rejects over-length input instead of truncating it', async () => {
  const repo = initRepo('lesson-long');
  const memory = await import('./memory');
  memory.closeMemoryDb();

  const res = mcp.runRememberLesson({ lesson: 'x'.repeat(400), cwd: repo });
  expect(res.isError).toBe(true);
  expect(parse(res).outcome).toBe('rejected');
  expect(parse(res).message).toContain('compress');
});

test('remember_lesson returns the conflict rather than quietly storing a variant', async () => {
  const repo = initRepo('lesson-conflict');
  const memory = await import('./memory');
  memory.closeMemoryDb();

  mcp.runRememberLesson({ lesson: 'The lesson store lives outside the cache directory.', cwd: repo });
  const out = parse(mcp.runRememberLesson({ lesson: 'The lesson store lives inside the cache directory.', cwd: repo }));

  expect(out.outcome).toBe('conflict');
  expect(out.status).toBe('needs_review');
  expect(out.conflicts).toHaveLength(1);
  expect(out.message).toContain('Raise the conflict with the user');
});

test('the MCP surface is 8 tools and remember_lesson is one of them', async () => {
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '..', 'index.ts'), '--mcp'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, SESSIONS_MEMORY_DB: join(tmp, 'memory.db') },
  });
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  await reader.read(); // initialize response
  proc.stdin.write(`${j({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  await proc.stdin.flush();
  const listed = new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  proc.stdin.end();
  await proc.exited;

  const tools = JSON.parse(listed.split('\n').filter(Boolean).pop()!).result.tools as { name: string }[];
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual([
    'get_activity_digest',
    'get_context_primer',
    'get_session_digest',
    'get_session_messages',
    'get_session_metrics',
    'grep_sessions',
    'remember_lesson',
    'search_sessions',
  ]);
}, 15000);

// The linchpin: _meta must survive the real SDK round-trip, or every provenance
// signal that is not an environment variable is unreachable in production.
test('a client _meta reaches the tool handler over a real stdio transport', async () => {
  const repo = initRepo('lesson-wire');
  const wireDb = join(tmp, 'wire-memory.db');
  const sessionId = '019f9a9b-9999-4888-8777-666666666666';
  const rolloutDir = join(tmp, 'codex', '2026', '07', '26');
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(join(rolloutDir, `rollout-2026-07-26T09-00-00-${sessionId}.jsonl`), '{}\n');

  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '..', 'index.ts'), '--mcp'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, SESSIONS_MEMORY_DB: wireDb, SESSIONS_CODEX_DIR: join(tmp, 'codex') },
  });
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  await reader.read();
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'remember_lesson',
        arguments: { lesson: 'A lesson whose provenance came over the wire.', cwd: repo },
        _meta: { 'x-codex-turn-metadata': { session_id: sessionId }, threadId: sessionId },
      },
    })}\n`,
  );
  await proc.stdin.flush();
  const called = new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  proc.stdin.end();
  await proc.exited;

  const body = JSON.parse(called.split('\n').filter(Boolean).pop()!);
  const payload = JSON.parse(body.result.content[0].text);
  expect(payload.outcome).toBe('saved');
  expect(payload.provenance).toBe('meta');
  expect(payload.sourceVerified).toBe(true);
}, 15000);
