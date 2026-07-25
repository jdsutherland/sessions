import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-lessons-'));
const claudeDir = join(fixtureRoot, 'claude', 'projects');
const memoryDb = join(fixtureRoot, 'memory.db');

function setEnv(): void {
  process.env.SESSIONS_CLAUDE_DIR = claudeDir;
  process.env.SESSIONS_MEMORY_DB = memoryDb;
}
setEnv();

const mem = await import('./memory');
const lessons = await import('./lessons');

const REPO = '/repo/alpha';
const TOOL_USE_ID = 'toolu_01LRwxAbCdEfGhIjKlMn';

function saveDeferred(lesson: string, toolUseId: string | null) {
  return mem.rememberLesson({
    lesson,
    container: REPO,
    source: {
      sessionId: null,
      transcript: null,
      toolUseId,
      provenance: toolUseId ? 'deferred' : 'none',
      verified: false,
      tool: toolUseId ? 'claude' : '',
    },
  });
}

/** A transcript carrying the tool_use id verbatim, the way Claude Code writes it. */
function writeTranscript(sessionId: string, toolUseId: string): string {
  const dir = join(claudeDir, '-repo-alpha');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'remember_lesson' }] },
    }) + '\n',
  );
  return path;
}

beforeEach(() => {
  setEnv();
  mem.closeMemoryDb();
  rmSync(memoryDb, { force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  for (const f of readdirSync(fixtureRoot)) {
    if (f.includes('.corrupt-')) rmSync(join(fixtureRoot, f));
  }
});

/** Run a `sessions lessons` action with both streams captured. */
async function capture(args: Parameters<typeof lessons.runLessons>[0]): Promise<string> {
  const chunks: string[] = [];
  const collect = (s: unknown) => {
    chunks.push(String(s));
    return true;
  };
  const err = spyOn(process.stderr, 'write').mockImplementation(collect);
  const out = spyOn(process.stdout, 'write').mockImplementation((s: unknown, cb?: unknown) => {
    collect(s);
    if (typeof cb === 'function') cb();
    return true;
  });
  try {
    await lessons.runLessons(args);
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
  return chunks.join('');
}

afterAll(() => {
  mem.closeMemoryDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('parseLessonsArgs', () => {
  test('defaults to listing this repo', () => {
    expect(lessons.parseLessonsArgs([])).toEqual({ action: 'list', all: false });
  });

  test('parses each subcommand and its flags', () => {
    expect(lessons.parseLessonsArgs(['--all']).all).toBe(true);
    expect(lessons.parseLessonsArgs(['review', '--keep', 'both'])).toMatchObject({ action: 'review', keep: 'both' });
    expect(lessons.parseLessonsArgs(['export', '--out', 'l.json'])).toMatchObject({ action: 'export', out: 'l.json' });
    expect(lessons.parseLessonsArgs(['audit']).action).toBe('audit');
    expect(lessons.parseLessonsArgs(['retire', '7'])).toMatchObject({ action: 'retire', id: 7 });
  });
});

/**
 * A row can leave service without anyone watching — a review, a retire, or an agent's
 * `supersedes`. The default listing showed only active and flagged rows, so the only
 * way to notice was `export` or opening the database.
 */
describe('the listing shows what left service', () => {
  function save(lesson: string) {
    return mem.rememberLesson({
      lesson,
      container: REPO,
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });
  }

  test('a retired lesson is listed, with the decision that took it out', async () => {
    const kept = save('Worktrees collapse to one container key.');
    const gone = save('Timezone bucketing happens once, in the report pipeline.');
    mem.retireLesson(gone.id!);

    const out = await capture({ action: 'list', all: true });
    expect(out).toContain(`#${kept.id}`);
    expect(out).toContain('1 out of service');
    expect(out).toContain(`#${gone.id} retired`);
  });

  test('a superseded lesson names its successor', async () => {
    const first = save('The lesson store lives outside the cache directory.');
    const second = mem.rememberLesson({
      lesson: 'The lesson store lives inside the cache directory.',
      container: REPO,
      supersedes: first.id,
      source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
    });

    const out = await capture({ action: 'list', all: true });
    expect(out).toContain(`#${first.id} superseded by #${second.id}`);
  });
});

describe('a quarantined store is never a silent empty list', () => {
  test('list says the store was moved aside instead of reporting no lessons', async () => {
    writeFileSync(memoryDb, 'this is not a sqlite database at all');
    const out = await capture({ action: 'list', all: true });
    expect(out).toContain('the lesson store was corrupt and was moved aside');
    expect(out).toContain('.corrupt-');
    expect(out).toContain('Nothing was deleted');
  });

  test('review says it too, rather than "no conflicting lessons"', async () => {
    writeFileSync(memoryDb, 'this is not a sqlite database at all');
    const out = await capture({ action: 'review', all: false });
    expect(out).toContain('moved aside');
  });
});

describe('audit recovers deferred provenance', () => {
  test('a tool-use id found in a transcript promotes the row to recovered', () => {
    saveDeferred('A lesson saved when the session id was unknown.', TOOL_USE_ID);
    const transcript = writeTranscript('11772ef1-6b80-46ec-9f32-97cd785efa1f', TOOL_USE_ID);

    const res = lessons.auditDeferred();
    expect(res).toMatchObject({ scanned: 1, recovered: 1, unresolved: 0, grepFailed: false });

    const row = mem.listLessons({ all: true })[0]!;
    expect(row.provenance).toBe('recovered');
    expect(row.source_session).toBe('11772ef1-6b80-46ec-9f32-97cd785efa1f');
    expect(row.source_transcript).toBe(transcript);
    expect(row.source_verified).toBe(1);
  });

  test('a tool-use id in no transcript stays deferred rather than being guessed at', () => {
    saveDeferred('A lesson whose transcript is gone.', TOOL_USE_ID);
    mkdirSync(claudeDir, { recursive: true });

    const res = lessons.auditDeferred();
    expect(res).toMatchObject({ scanned: 1, recovered: 0, unresolved: 1 });
    const row = mem.listLessons({ all: true })[0]!;
    expect(row.provenance).toBe('deferred');
    expect(row.source_session).toBeNull();
  });

  test('rows with no tool-use id are not scanned — there is nothing to trace', () => {
    saveDeferred('A lesson with no anchor at all.', null);
    expect(lessons.auditDeferred()).toMatchObject({ scanned: 0, recovered: 0 });
  });

  test('the audit does not touch a row whose provenance is already established', () => {
    mem.rememberLesson({
      lesson: 'A lesson that already knows where it came from.',
      container: REPO,
      source: {
        sessionId: 'sess-known',
        transcript: '/transcripts/sess-known.jsonl',
        toolUseId: TOOL_USE_ID,
        provenance: 'hook',
        verified: true,
        tool: 'claude',
      },
    });
    writeTranscript('some-other-session', TOOL_USE_ID);

    expect(lessons.auditDeferred().scanned).toBe(0);
    expect(mem.listLessons({ all: true })[0]!.source_session).toBe('sess-known');
  });
});
