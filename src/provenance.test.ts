import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-prov-'));
const claudeDir = join(fixtureRoot, 'claude', 'projects');
const codexDir = join(fixtureRoot, 'codex', 'sessions');
const handoffDir = join(fixtureRoot, 'handoff');

function setEnv(): void {
  process.env.SESSIONS_CLAUDE_DIR = claudeDir;
  process.env.SESSIONS_CODEX_DIR = codexDir;
  process.env.SESSIONS_HANDOFF_DIR = handoffDir;
}
setEnv();

const prov = await import('./provenance');

const CLAUDE_ID = '11772ef1-6b80-46ec-9f32-97cd785efa1f';
const STALE_ID = 'c57c50e1-0000-4000-8000-000000000000';
const CODEX_ID = '019f9a9b-1111-4222-8333-444444444444';
const TOOL_USE_ID = 'toolu_01LRwxAbCdEf';

/** A Claude transcript at `<projects>/<cwd-slug>/<session-id>.jsonl`. */
function writeClaudeTranscript(id: string): string {
  const dir = join(claudeDir, '-Users-nicknisi-Developer-sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  return path;
}

/** A Codex rollout at `<sessions>/YYYY/MM/DD/rollout-<ISO>-<session-id>.jsonl`. */
function writeCodexRollout(id: string): string {
  const dir = join(codexDir, '2026', '07', '25');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-25T13-44-01-${id}.jsonl`);
  writeFileSync(path, '{}\n');
  return path;
}

const codexMeta = (id: string): Record<string, unknown> => ({
  'x-codex-turn-metadata': { session_id: id, thread_id: id, turn_id: 't1', model: 'gpt-5.5' },
  threadId: id,
});

const claudeMeta = (): Record<string, unknown> => ({ 'claudecode/toolUseId': TOOL_USE_ID, progressToken: 2 });

beforeEach(() => {
  setEnv();
  rmSync(join(fixtureRoot, 'claude'), { recursive: true, force: true });
  rmSync(join(fixtureRoot, 'codex'), { recursive: true, force: true });
  rmSync(handoffDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the resolution ladder', () => {
  test("codex states its session id on the call, and the rollout confirms it: 'meta'", () => {
    const rollout = writeCodexRollout(CODEX_ID);
    const r = prov.resolveProvenance(codexMeta(CODEX_ID), {});
    expect(r.provenance).toBe('meta');
    expect(r.sessionId).toBe(CODEX_ID);
    expect(r.transcript).toBe(rollout);
    expect(r.verified).toBe(true);
    expect(r.tool).toBe('codex');
  });

  test('a codex id whose rollout is not on disk is kept but marked unverified', () => {
    const r = prov.resolveProvenance(codexMeta(CODEX_ID), {});
    expect(r.provenance).toBe('meta');
    expect(r.sessionId).toBe(CODEX_ID);
    expect(r.transcript).toBeNull();
    expect(r.verified).toBe(false);
  });

  test("the hook handoff wins over a stale env id: 'hook'", () => {
    // The measured `claude -c` case: both processes inherit STALE_ID, the hook was
    // handed the real one, and only the real one has a transcript.
    const transcript = writeClaudeTranscript(CLAUDE_ID);
    prov.writeHandoff(STALE_ID, {
      sessionId: CLAUDE_ID,
      transcriptPath: transcript,
      cwd: '/repo',
      source: 'resume',
      writtenAt: '2026-07-25T13:00:00.000Z',
    });

    const r = prov.resolveProvenance(claudeMeta(), { CLAUDE_CODE_SESSION_ID: STALE_ID });
    expect(r.provenance).toBe('hook');
    expect(r.sessionId).toBe(CLAUDE_ID);
    expect(r.sessionId).not.toBe(STALE_ID);
    expect(r.transcript).toBe(transcript);
    expect(r.verified).toBe(true);
    expect(r.toolUseId).toBe(TOOL_USE_ID);
  });

  test('a handoff pointing at a transcript that no longer exists is not trusted', () => {
    prov.writeHandoff(STALE_ID, {
      sessionId: CLAUDE_ID,
      transcriptPath: join(fixtureRoot, 'gone.jsonl'),
      cwd: '/repo',
      source: 'startup',
      writtenAt: '2026-07-25T13:00:00.000Z',
    });
    const r = prov.resolveProvenance(claudeMeta(), { CLAUDE_CODE_SESSION_ID: STALE_ID });
    expect(r.provenance).toBe('deferred');
    expect(r.sessionId).toBeNull();
  });

  test("an env id with a transcript on disk is verified: 'env'", () => {
    const transcript = writeClaudeTranscript(CLAUDE_ID);
    const r = prov.resolveProvenance(claudeMeta(), { CLAUDE_CODE_SESSION_ID: CLAUDE_ID });
    expect(r.provenance).toBe('env');
    expect(r.sessionId).toBe(CLAUDE_ID);
    expect(r.transcript).toBe(transcript);
    expect(r.verified).toBe(true);
  });

  // The load-bearing one: an unverifiable id must be dropped, not stored. `claude -c`
  // spawns MCP servers with a pre-resume id that exists nowhere on disk, and a later
  // resume could mint that uuid for real and attach this lesson to a stranger.
  test('a stale env id with no transcript is dropped, not stored', () => {
    const r = prov.resolveProvenance(claudeMeta(), { CLAUDE_CODE_SESSION_ID: STALE_ID });
    expect(r.provenance).toBe('deferred');
    expect(r.sessionId).toBeNull();
    expect(r.transcript).toBeNull();
    expect(r.toolUseId).toBe(TOOL_USE_ID);
    expect(r.verified).toBe(false);
  });

  test("nothing identifying at all: 'none', every source field null", () => {
    const r = prov.resolveProvenance(undefined, {});
    expect(r).toEqual({
      sessionId: null,
      transcript: null,
      toolUseId: null,
      provenance: 'none',
      verified: false,
      tool: '',
    });
  });

  test('a stale env id with no tool-use id either falls all the way to none', () => {
    const r = prov.resolveProvenance({}, { CLAUDE_CODE_SESSION_ID: STALE_ID });
    expect(r.provenance).toBe('none');
    expect(r.sessionId).toBeNull();
  });
});

describe('ids from a client are never trusted as paths', () => {
  test('a traversal attempt is treated as absent', () => {
    const r = prov.resolveProvenance(undefined, { CLAUDE_CODE_SESSION_ID: '../../etc/passwd' });
    expect(r.provenance).toBe('none');
  });

  test('a glob metacharacter in a codex id is treated as absent', () => {
    writeCodexRollout(CODEX_ID);
    const r = prov.resolveProvenance(codexMeta('*'), {});
    expect(r.provenance).toBe('none');
  });

  test('writeHandoff refuses an unsafe key', () => {
    prov.writeHandoff('../escape', {
      sessionId: CLAUDE_ID,
      transcriptPath: '/tmp/x.jsonl',
      cwd: '/repo',
      source: 'startup',
      writtenAt: '2026-07-25T13:00:00.000Z',
    });
    expect(existsSync(join(fixtureRoot, 'escape.json'))).toBe(false);
  });
});

describe('handoff files', () => {
  test('a written handoff reads back', () => {
    const h = {
      sessionId: CLAUDE_ID,
      transcriptPath: '/transcripts/x.jsonl',
      cwd: '/repo',
      source: 'startup',
      writtenAt: '2026-07-25T13:00:00.000Z',
    };
    prov.writeHandoff(STALE_ID, h);
    expect(prov.readHandoff(STALE_ID)).toEqual(h);
  });

  test('a missing or malformed handoff is null, not a throw', () => {
    expect(prov.readHandoff(STALE_ID)).toBeNull();
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, `${STALE_ID}.json`), '{not json');
    expect(prov.readHandoff(STALE_ID)).toBeNull();
  });
});
