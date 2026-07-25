import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvenance } from './provenance';
// Type-only, so it is erased and the module is still first loaded by the dynamic
// import below — after SESSIONS_MEMORY_DB points at this fixture.
import type { RememberInput, RememberResult } from './memory';

// The lesson store gets its own hermetic file. SESSIONS_MEMORY_DB exists for exactly
// this reason — without it every test here (and the primer) would read the machine's
// real lessons.
const fixtureRoot = mkdtempSync(join(tmpdir(), 'sessions-memory-'));
const dbPath = join(fixtureRoot, 'memory.db');
process.env.SESSIONS_MEMORY_DB = dbPath;

const mem = await import('./memory');

const REPO = '/repo/alpha';
const REMOTE = 'github.com/nicknisi/alpha';

const NO_SOURCE: SessionProvenance = {
  sessionId: null,
  transcript: null,
  toolUseId: null,
  provenance: 'none',
  verified: false,
  tool: '',
};

const HOOK_SOURCE: SessionProvenance = {
  sessionId: '11772ef1-6b80-46ec-9f32-97cd785efa1f',
  transcript: '/transcripts/11772ef1.jsonl',
  toolUseId: 'toolu_01LRwx',
  provenance: 'hook',
  verified: true,
  tool: 'claude',
};

function save(lesson: string, over: Partial<RememberInput> = {}): RememberResult {
  return mem.rememberLesson({
    lesson,
    container: REPO,
    remote: REMOTE,
    source: NO_SOURCE,
    ...over,
  });
}

beforeEach(() => {
  process.env.SESSIONS_MEMORY_DB = dbPath;
  mem.closeMemoryDb();
  for (const f of readdirSync(fixtureRoot)) unlinkSync(join(fixtureRoot, f));
});

afterAll(() => {
  mem.closeMemoryDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the store is not conjured by reading', () => {
  test('no memory.db means no lessons and no file left behind', () => {
    expect(existsSync(dbPath)).toBe(false);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5)).toEqual(mem.NO_LESSONS);
    expect(mem.countLessons()).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('a write creates it at the current schema version', () => {
    expect(save('Bound lesson length at write, not at read.').outcome).toBe('saved');
    expect(existsSync(dbPath)).toBe(true);
    mem.closeMemoryDb();
    const db = new Database(dbPath, { readonly: true });
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION,
    );
    db.close();
  });
});

describe('write-time bounds', () => {
  test('an over-length lesson is rejected with an instruction to compress, not truncated', () => {
    const res = save('x'.repeat(mem.LESSON_MAX_CHARS + 1));
    expect(res.outcome).toBe('rejected');
    expect(res.message).toContain('compress');
    expect(mem.countLessons()).toBe(0);
  });

  test('an over-length detail is rejected', () => {
    const res = save('A short lesson.', { detail: 'y'.repeat(mem.DETAIL_MAX_CHARS + 1) });
    expect(res.outcome).toBe('rejected');
    expect(mem.countLessons()).toBe(0);
  });

  test('repo scope outside a git repo is rejected, pointing at global scope', () => {
    const res = mem.rememberLesson({ lesson: 'Something true.', source: NO_SOURCE });
    expect(res.outcome).toBe('rejected');
    expect(res.message).toContain('global');
  });

  test('a lesson at exactly the limit is accepted', () => {
    expect(save('z'.repeat(mem.LESSON_MAX_CHARS)).outcome).toBe('saved');
  });
});

describe('idempotency', () => {
  test('an exact re-save bumps last_seen_at and inserts nothing', () => {
    const first = save('Release-please only bumps package.json, so plugin manifests go stale.', {
      now: '2026-07-01T00:00:00.000Z',
    });
    const again = save('  Release-please only bumps package.json, so plugin manifests go stale.  ', {
      now: '2026-07-20T00:00:00.000Z',
    });

    expect(again.outcome).toBe('known');
    expect(again.id).toBe(first.id!);
    expect(mem.countLessons()).toBe(1);

    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.created_at).toBe('2026-07-01T00:00:00.000Z');
    expect(row.last_seen_at).toBe('2026-07-20T00:00:00.000Z');
  });

  test('punctuation and case do not create a second row', () => {
    save('Bound lesson length at write, not at read.');
    const again = save('bound lesson length at write not at read');
    expect(again.outcome).toBe('known');
    expect(mem.countLessons()).toBe(1);
  });

  test('the same sentence in a different repo is a different lesson', () => {
    save('Bound lesson length at write, not at read.');
    const other = save('Bound lesson length at write, not at read.', { container: '/repo/beta', remote: '' });
    expect(other.outcome).toBe('saved');
    expect(mem.countLessons()).toBe(2);
  });
});

// The thresholds are guesses. This corpus is what turns tuning them into a data
// change: every pair is hand-labelled, and the assertions below say what each label
// must do at the shipped constants.
type Label = 'same' | 'conflict' | 'distinct';
const PAIRS: [string, string, Label][] = [
  [
    'stdio MCP servers need an explicit exit on stdin end or close',
    'stdio MCP servers need explicit exit on stdin end/close',
    'same',
  ],
  ['Bound lesson length at write, not at read.', 'bound lesson length at write — not at read', 'same'],
  [
    'The CLI entrypoint is the root index.ts, not src/ — grep the root before calling code dead.',
    'The CLI entrypoint is the root index.ts (not src/); grep the root before calling code dead',
    'same',
  ],
  [
    'Release-please only bumps package.json, so plugin manifests go stale.',
    'release-please only bumps package.json so the plugin manifests go stale',
    'same',
  ],
  [
    'The lesson store lives outside the cache directory.',
    'The lesson store lives inside the cache directory.',
    'conflict',
  ],
  [
    'Index rebuilds are triggered by a SCHEMA_VERSION bump.',
    'Index rebuilds are triggered by a SCHEMA_VERSION bump or an mtime change.',
    'conflict',
  ],
  [
    'Run the migration ladder before opening the database.',
    'Run the migration ladder after opening the database read-only.',
    'conflict',
  ],
  [
    'Session ids for Codex come from the rollout filename.',
    'Session ids for Codex come from the session_meta payload, not the rollout filename.',
    'conflict',
  ],
  [
    'The primer surfaces lessons before recent sessions.',
    'The primer surfaces recent sessions before earlier headlines.',
    'distinct',
  ],
  ['Bound lesson length at write, not at read.', 'stdio MCP servers need an explicit exit on stdin end', 'distinct'],
  [
    'Never delete a database that cannot be rebuilt from the transcripts.',
    'Prefer container matching over remote matching when scoping a repo.',
    'distinct',
  ],
  [
    'Codex passes session identity in _meta on every tool call.',
    'Claude Code passes a tool_use id in _meta but never a session id.',
    'distinct',
  ],
  [
    'Tests must set SESSIONS_MEMORY_DB so the primer never reads real lessons.',
    'Tests must set SESSIONS_CACHE_DIR so the index never reads the real cache.',
    'distinct',
  ],
  [
    'grep_sessions is exhaustive; search_sessions is top-k.',
    'get_session_digest is bounded; get_session_messages is not.',
    'distinct',
  ],
];

describe('jaccard thresholds', () => {
  test('every reworded pair reads as the same lesson', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'same') continue;
      expect(mem.jaccard(a, b)).toBeGreaterThanOrEqual(mem.SAME_LESSON_JACCARD);
    }
  });

  test('every conflicting pair lands in the review band', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'conflict') continue;
      const j = mem.jaccard(a, b);
      expect(j).toBeGreaterThanOrEqual(mem.REVIEW_JACCARD);
      expect(j).toBeLessThan(mem.SAME_LESSON_JACCARD);
    }
  });

  test('no distinct pair is ever mistaken for the same lesson', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'distinct') continue;
      expect(mem.jaccard(a, b)).toBeLessThan(mem.SAME_LESSON_JACCARD);
    }
  });

  test('at most one distinct pair is over-flagged into review', () => {
    // The band buys recall on purpose: a missed conflict serves two contradictory
    // lessons as fact, while an over-flag costs one keep-both keystroke. One pair in
    // this corpus (two true statements about primer ordering) pays that cost.
    const overFlagged = PAIRS.filter(
      ([a, b, label]) => label === 'distinct' && mem.jaccard(a, b) >= mem.REVIEW_JACCARD,
    );
    expect(overFlagged.length).toBeLessThanOrEqual(1);
  });

  // Set similarity is blind to word order, so a claim and its reversal score a
  // perfect 1.0. sameStatement is the guard, and these are the pairs that prove it
  // is load-bearing rather than decorative.
  const REVERSALS: [string, string][] = [
    ['The retry budget is per-endpoint, not per-account.', 'The retry budget is per-account, not per-endpoint.'],
    ['Bound lesson length at write, not at read.', 'Bound lesson length at read, not at write.'],
    ['Prefer the container key over the remote key.', 'Prefer the remote key over the container key.'],
  ];

  test('a reversed claim scores as identical and is still not the same statement', () => {
    for (const [a, b] of REVERSALS) {
      expect(mem.jaccard(a, b)).toBe(1);
      expect(mem.sameStatement(a, b)).toBe(false);
    }
  });

  test('a genuine reword is the same statement', () => {
    for (const [a, b, label] of PAIRS) {
      if (label !== 'same') continue;
      expect(mem.sameStatement(a, b)).toBe(true);
    }
  });

  test('jaccard is symmetric and self-identical', () => {
    const [a, b] = PAIRS[4]!;
    expect(mem.jaccard(a, b)).toBeCloseTo(mem.jaccard(b, a), 10);
    expect(mem.jaccard(a, a)).toBe(1);
  });
});

describe('near-duplicates flag both rows', () => {
  const A = 'The lesson store lives outside the cache directory.';
  const B = 'The lesson store lives inside the cache directory.';

  test('a conflicting save quarantines the incumbent as well as the newcomer', () => {
    const first = save(A);
    const second = save(B);

    expect(second.outcome).toBe('conflict');
    expect(second.conflicts).toEqual([{ id: first.id!, lesson: A }]);

    const rows = mem.listLessons({ container: REPO, remote: REMOTE });
    expect(rows.map((r) => r.status)).toEqual(['needs_review', 'needs_review']);
    expect(new Set(rows.map((r) => r.review_group))).toEqual(new Set([second.id!]));
  });

  test('neither conflicting row is served, and the count is', () => {
    save(A);
    save(B);
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons).toEqual([]);
    expect(read.flagged).toBe(2);
    expect(read.total).toBe(0);
  });

  test('nothing is merged or overwritten — the incumbent text is byte-identical', () => {
    const first = save(A);
    save(B);
    const incumbent = mem.listLessons({ container: REPO, remote: REMOTE }).find((r) => r.id === first.id)!;
    expect(incumbent.lesson).toBe(A);
  });

  test('a same-lesson reword bumps the incumbent instead of flagging', () => {
    const first = save('stdio MCP servers need an explicit exit on stdin end or close');
    const again = save('stdio MCP servers need explicit exit on stdin end/close');
    expect(again.outcome).toBe('known');
    expect(again.id).toBe(first.id!);
    expect(mem.countLessons()).toBe(1);
  });

  test('a reversed claim is flagged as a conflict, not swallowed as a duplicate', () => {
    const first = save('The retry budget is per-endpoint, not per-account.');
    const reversed = save('The retry budget is per-account, not per-endpoint.');

    expect(reversed.outcome).toBe('conflict');
    expect(reversed.conflicts).toEqual([
      { id: first.id!, lesson: 'The retry budget is per-endpoint, not per-account.' },
    ]);
    expect(mem.countLessons()).toBe(2);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).flagged).toBe(2);
  });

  test('a lesson in another repo never conflicts with this one', () => {
    save(A);
    const other = save(B, { container: '/repo/beta', remote: '' });
    expect(other.outcome).toBe('saved');
    expect(other.status).toBe('active');
  });
});

describe('review resolution', () => {
  const A = 'Index rebuilds are triggered by a SCHEMA_VERSION bump.';
  const B = 'Index rebuilds are triggered by a SCHEMA_VERSION bump or an mtime change.';

  test('keep-new supersedes the incumbent and never deletes it', () => {
    const first = save(A);
    const second = save(B);
    expect(mem.resolveReview(second.reviewGroup!, 'new')).toBe(2);

    const rows = mem.listLessons({ container: REPO, remote: REMOTE, all: true });
    const oldRow = rows.find((r) => r.id === first.id)!;
    const newRow = rows.find((r) => r.id === second.id)!;
    expect(oldRow.status).toBe('superseded');
    expect(oldRow.superseded_by).toBe(newRow.id);
    expect(newRow.status).toBe('active');
    expect(newRow.supersedes_id).toBe(oldRow.id);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.lesson)).toEqual([B]);
  });

  test('keep-old retires the newcomer and restores the incumbent', () => {
    save(A);
    const second = save(B);
    mem.resolveReview(second.reviewGroup!, 'old');
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.lesson)).toEqual([A]);
  });

  test('keep-both reactivates every row in the group', () => {
    save(A);
    const second = save(B);
    mem.resolveReview(second.reviewGroup!, 'both');
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.length).toBe(2);
    expect(read.flagged).toBe(0);
  });

  test('reviewGroups lists the pending conflicts and empties once resolved', () => {
    save(A);
    const second = save(B);
    expect(mem.reviewGroups().map((g) => g.rows.length)).toEqual([2]);
    mem.resolveReview(second.reviewGroup!, 'both');
    expect(mem.reviewGroups()).toEqual([]);
  });
});

describe('retiring by hand', () => {
  test('a retired lesson leaves the primer but stays readable', () => {
    const saved = save('A lesson that should not have been saved.');
    expect(mem.retireLesson(saved.id!)).toBe(true);

    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
    const row = mem.listLessons({ all: true })[0]!;
    expect(row.status).toBe('retired');
    expect(row.lesson).toBe('A lesson that should not have been saved.');
  });

  test('retiring an unknown or already-retired lesson reports no change', () => {
    const saved = save('A lesson that should not have been saved.');
    expect(mem.retireLesson(999)).toBe(false);
    expect(mem.retireLesson(saved.id!)).toBe(true);
    expect(mem.retireLesson(saved.id!)).toBe(false);
  });

  test('a retired lesson does not block re-saving the same text later', () => {
    const saved = save('A lesson that should not have been saved.');
    mem.retireLesson(saved.id!);
    // The content hash is still taken, so this is recognized rather than duplicated —
    // and the retirement holds, which the caller is told rather than left to assume.
    const again = save('A lesson that should not have been saved.');
    expect(again.outcome).toBe('known');
    expect(again.status).toBe('retired');
    expect(again.message).toContain('was retired and is not served');
    expect(mem.countLessons()).toBe(1);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons).toEqual([]);
  });
});

describe('explicit supersession', () => {
  test('supersedes retires the old row and skips the review band', () => {
    const first = save('The lesson store lives outside the cache directory.');
    const second = save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(second.outcome).toBe('saved');
    expect(second.status).toBe('active');

    const rows = mem.listLessons({ all: true });
    expect(rows.find((r) => r.id === first.id)!.status).toBe('superseded');
    expect(rows.find((r) => r.id === second.id)!.supersedes_id).toBe(first.id!);
  });

  test('superseding an unknown or already-superseded lesson is refused', () => {
    expect(save('A new claim.', { supersedes: 999 }).outcome).toBe('rejected');
    const first = save('The lesson store lives outside the cache directory.');
    save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(save('A third position entirely.', { supersedes: first.id }).outcome).toBe('rejected');
  });
});

// Seven lessons with nothing in common — the fill for limit/ordering tests. Anything
// less varied gets quarantined as a near-duplicate before the assertion runs.
const UNRELATED = [
  'Worktrees collapse to one container key, so a branch lesson applies on main.',
  'Timezone bucketing happens once, in the report pipeline.',
  'Trajectory export drops reasoning blocks the format cannot carry.',
  'The fzf picker reads from stderr so stdout stays pipeable.',
  'Pricing data is fetched at build time and embedded.',
  'OpenCode keeps every conversation in one SQLite file.',
  'A junk scope in the corpus means an automated probe, not real work.',
];

describe('scope and retrieval', () => {
  test('repo lessons come before global ones, newest first inside each tier', () => {
    save('Repo lesson one about the alpha indexer.', { now: '2026-07-01T00:00:00.000Z' });
    save('Repo lesson two about alpha queue draining.', { now: '2026-07-02T00:00:00.000Z' });
    save('A global truth about stdio transports everywhere.', { scope: 'global', now: '2026-07-03T00:00:00.000Z' });

    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.map((l) => l.scope)).toEqual(['repo', 'repo', 'global']);
    expect(read.lessons[0]!.lesson).toContain('queue draining');
  });

  test('global lessons reach a repo that has none of its own', () => {
    save('A global truth about stdio transports everywhere.', { scope: 'global' });
    const read = mem.readLessonsForRepo('/repo/unrelated', '', 5);
    expect(read.lessons.map((l) => l.scope)).toEqual(['global']);
  });

  test('another repo never sees this one repo-scoped lessons', () => {
    save('Repo lesson one about the alpha indexer.');
    expect(mem.readLessonsForRepo('/repo/beta', 'github.com/nicknisi/beta', 5).lessons).toEqual([]);
  });

  test('the remote matches a moved checkout the container no longer names', () => {
    save('Repo lesson one about the alpha indexer.');
    const moved = mem.readLessonsForRepo('/elsewhere/alpha', REMOTE, 5);
    expect(moved.lessons.length).toBe(1);
  });

  test('total counts what the limit left out, so the primer can say +N more', () => {
    UNRELATED.forEach((l, i) => save(l, { now: `2026-07-0${i + 1}T00:00:00.000Z` }));
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.length).toBe(5);
    expect(read.total).toBe(UNRELATED.length);
  });

  test('a global lesson never displaces a repo one when the limit bites', () => {
    save('A global truth about stdio transports everywhere.', { scope: 'global', now: '2026-07-09T00:00:00.000Z' });
    UNRELATED.slice(0, 5).forEach((l, i) => save(l, { now: `2026-07-0${i + 1}T00:00:00.000Z` }));
    const read = mem.readLessonsForRepo(REPO, REMOTE, 5);
    expect(read.lessons.every((l) => l.scope === 'repo')).toBe(true);
  });

  test('superseded and retired rows are not served', () => {
    const first = save('The lesson store lives outside the cache directory.');
    save('The lesson store lives inside the cache directory.', { supersedes: first.id });
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.map((l) => l.id)).not.toContain(first.id);
  });
});

describe('provenance is carried, never invented', () => {
  test('a verified hook source is stored whole', () => {
    const res = save('A lesson with real provenance.', { source: HOOK_SOURCE });
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(res.provenance).toBe('hook');
    expect(row.source_session).toBe(HOOK_SOURCE.sessionId);
    expect(row.source_transcript).toBe(HOOK_SOURCE.transcript);
    expect(row.source_verified).toBe(1);
  });

  test("an unresolvable source stores nulls and says 'none'", () => {
    save('A lesson with no provenance at all.');
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.source_session).toBeNull();
    expect(row.source_transcript).toBeNull();
    expect(row.source_tool_use_id).toBeNull();
    expect(row.provenance).toBe('none');
    expect(row.source_verified).toBe(0);
    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons[0]!.verified).toBe(false);
  });

  test('a deferred row is recoverable and promotes to recovered', () => {
    save('A lesson saved with only a tool-use id.', {
      source: {
        sessionId: null,
        transcript: null,
        toolUseId: 'toolu_01Deferred',
        provenance: 'deferred',
        verified: false,
        tool: 'claude',
      },
    });
    const pending = mem.deferredLessons();
    expect(pending.map((r) => r.source_tool_use_id)).toEqual(['toolu_01Deferred']);

    mem.recoverLesson(pending[0]!.id, 'sess-abc', '/transcripts/sess-abc.jsonl');
    const row = mem.listLessons({ container: REPO, remote: REMOTE })[0]!;
    expect(row.provenance).toBe('recovered');
    expect(row.source_session).toBe('sess-abc');
    expect(row.source_verified).toBe(1);
    expect(mem.deferredLessons()).toEqual([]);
  });
});

describe('export', () => {
  test('every row round-trips through export, including quarantined ones', () => {
    save('The lesson store lives outside the cache directory.', { source: HOOK_SOURCE, files: ['src/memory.ts'] });
    save('The lesson store lives inside the cache directory.');

    const exported = mem.exportLessons();
    expect(exported.length).toBe(2);
    expect(exported[0]!.files).toEqual(['src/memory.ts']);
    expect(exported[0]!.source.provenance).toBe('hook');
    expect(exported.every((e) => e.status === 'needs_review')).toBe(true);
    // Portable on its own: no ids into another table, no columns that need the mirror.
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });
});

describe('the migration ladder', () => {
  test('a later version is applied over an existing file, and the row survives', () => {
    save('A lesson written by the v1 build.', { detail: 'root cause and fix', now: '2026-07-01T00:00:00.000Z' });
    mem.closeMemoryDb();

    // A synthetic v2 step. The v1 step must be skipped, not re-run — the ladder walks
    // from the file's version, never from zero.
    const db = new Database(dbPath);
    const applied = mem.applyMigrations(db, [
      {
        to: 1,
        up: () => {
          throw new Error('v1 must not re-run on a v1 file');
        },
      },
      { to: 2, up: (d) => d.run("ALTER TABLE lessons ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown'") },
    ]);

    expect(applied).toBe(2);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(2);
    const row = db.query<{ lesson: string; detail: string; confidence: string }, []>('SELECT * FROM lessons').get()!;
    expect(row.lesson).toBe('A lesson written by the v1 build.');
    expect(row.detail).toBe('root cause and fix');
    expect(row.confidence).toBe('unknown');
    db.close();
  });

  test('a file newer than the build is served read-only, never rewritten', () => {
    save('A lesson from the future build.');
    mem.closeMemoryDb();

    const bump = new Database(dbPath);
    bump.run(`PRAGMA user_version = ${mem.MEMORY_SCHEMA_VERSION + 5}`);
    bump.close();

    expect(mem.readLessonsForRepo(REPO, REMOTE, 5).lessons.length).toBe(1);
    expect(mem.isReadOnly()).toBe(true);

    const refused = save('A lesson an older build tried to add.');
    expect(refused.outcome).toBe('rejected');
    expect(refused.message).toContain('upgrade');

    mem.closeMemoryDb();
    const after = new Database(dbPath, { readonly: true });
    expect(after.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      mem.MEMORY_SCHEMA_VERSION + 5,
    );
    expect(after.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n).toBe(1);
    after.close();
  });

  test('a corrupt file is quarantined for recovery, not deleted', () => {
    writeFileSync(dbPath, 'this is not a sqlite database at all');
    const res = save('A lesson written after the corruption.');
    expect(res.outcome).toBe('saved');

    const quarantined = readdirSync(fixtureRoot).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(readFileSync(join(fixtureRoot, quarantined[0]!), 'utf-8')).toBe('this is not a sqlite database at all');
    expect(mem.countLessons()).toBe(1);
  });
});
