import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { getMemoryDbPath } from './paths';
import type { SessionProvenance } from './provenance';
import type { ContextLesson, Provenance } from './types';

/**
 * The lesson store. Deliberately its own database, outside the cache.
 *
 * Every row in index.db is a reproducible projection of a transcript and is dropped
 * on a schema bump, a `--clear-cache`, or corruption. A lesson is an assertion
 * somebody made once; nothing regenerates it. The two must never share a file, a
 * lifecycle, or a recovery strategy — see the migration ladder below, which never
 * drops a table, and getMemoryDb, which quarantines corruption instead of deleting it.
 */

export type Scope = 'repo' | 'global';
export type LessonStatus = 'active' | 'needs_review' | 'superseded' | 'retired';

/** Bounded at write, not at read: the read budget stays honest and the verbose entries never land. */
export const LESSON_MAX_CHARS = 280;
export const DETAIL_MAX_CHARS = 600;

// Primer budgets. Lessons are hand-curated and few, so these are row counts, not a
// ranking function. They live here rather than in context.ts because cache.ts needs
// the default too and importing context.ts there would be a cycle.
export const LESSON_LIMIT = 5;
export const LESSON_HOOK_LIMIT = 3;

/**
 * Near-duplicate bands, as token-set Jaccard over normalized lesson text. Guesses,
 * pinned by the hand-labelled pair corpus in memory.test.ts so tuning them is a data
 * change with a regression signal rather than a vibe.
 */
export const SAME_LESSON_JACCARD = 0.85;
export const REVIEW_JACCARD = 0.55;

export interface LessonRow {
  id: number;
  content_hash: string;
  lesson: string;
  detail: string;
  scope: Scope;
  repo_container: string;
  repo_remote: string;
  files: string;
  tool: string;
  source_session: string | null;
  source_transcript: string | null;
  source_tool_use_id: string | null;
  provenance: Provenance;
  source_verified: number;
  status: LessonStatus;
  review_group: number | null;
  supersedes_id: number | null;
  superseded_by: number | null;
  created_at: string;
  last_seen_at: string;
}

interface Migration {
  to: number;
  up: (db: Database) => void;
}

// An ordered ALTER/backfill ladder. index.db drops and rebuilds on a version
// mismatch, which is correct there and catastrophic here — no step may ever DROP.
const MIGRATIONS: Migration[] = [
  {
    to: 1,
    up(db) {
      db.run(`
        CREATE TABLE lessons (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          content_hash       TEXT NOT NULL UNIQUE,
          lesson             TEXT NOT NULL,
          detail             TEXT NOT NULL DEFAULT '',
          scope              TEXT NOT NULL,
          repo_container     TEXT NOT NULL DEFAULT '',
          repo_remote        TEXT NOT NULL DEFAULT '',
          files              TEXT NOT NULL DEFAULT '[]',
          tool               TEXT NOT NULL DEFAULT '',
          source_session     TEXT,
          source_transcript  TEXT,
          source_tool_use_id TEXT,
          provenance         TEXT NOT NULL,
          source_verified    INTEGER NOT NULL DEFAULT 0,
          status             TEXT NOT NULL DEFAULT 'active',
          review_group       INTEGER,
          supersedes_id      INTEGER REFERENCES lessons(id),
          superseded_by      INTEGER REFERENCES lessons(id),
          created_at         TEXT NOT NULL,
          last_seen_at       TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX lessons_scope ON lessons(status, scope, repo_container)');
      db.run('CREATE INDEX lessons_remote ON lessons(status, repo_remote)');
      // Shortlist index for near-duplicate detection. Synced by hand (delete by id,
      // re-insert) the same way session_fts is in cache.ts.
      db.run(`
        CREATE VIRTUAL TABLE lessons_fts USING fts5(
          id UNINDEXED,
          lesson,
          detail,
          tokenize = 'porter unicode61'
        )
      `);
    },
  },
];

export const MEMORY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.to;

const TOO_NEW = 'memory.db was written by a newer sessions';

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

/** Walk the ladder from the file's version to the ladder's last step. Exported so a test can drive a synthetic v2. */
export function applyMigrations(db: Database, ladder: Migration[] = MIGRATIONS): number {
  const from = userVersion(db);
  const target = ladder[ladder.length - 1]!.to;
  if (from > target) throw new Error(`${TOO_NEW} (file v${from}, this build v${target})`);
  for (const m of ladder) {
    if (m.to <= from) continue;
    db.transaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version = ${m.to}`);
    })();
  }
  return target;
}

let _db: Database | null = null;
// The path the open handle belongs to. Compared on every call so a changed
// SESSIONS_MEMORY_DB reopens instead of silently serving the previous file — which
// is what a test that forgets to close would otherwise get.
let _dbPath = '';
let _readonly = false;

function openAt(path: string): Database {
  const db = new Database(path);
  db.run('PRAGMA busy_timeout=5000');
  // No WAL. This file is small, written rarely, and is the thing a user backs up,
  // exports, or copies to another machine — a single file at rest is worth more here
  // than the write concurrency index.db needs.
  db.run('PRAGMA journal_mode=DELETE');
  db.run('PRAGMA synchronous=FULL');
  db.run('PRAGMA foreign_keys=ON');
  return db;
}

// Same detection as cache.ts, opposite response: there it means "delete and rebuild",
// here it means "get out of the way and keep the bytes".
function isCorruption(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database');
}

function quarantine(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.corrupt-${stamp}`;
  renameSync(path, dest);
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    try {
      renameSync(path + sidecar, dest + sidecar);
    } catch {}
  }
  return dest;
}

/**
 * Open the store. `create` is false by default so a read never conjures a database —
 * a machine that has never saved a lesson has no memory.db, and the primer must be a
 * clean no-op there rather than leaving an empty file behind.
 */
export function getMemoryDb(opts: { create?: boolean } = {}): Database | null {
  const path = getMemoryDbPath();
  if (_db && _dbPath === path) return _db;
  if (_db) closeMemoryDb();
  if (!existsSync(path) && !opts.create) return null;
  mkdirSync(dirname(path), { recursive: true });

  let db: Database;
  try {
    db = openAt(path);
  } catch (e) {
    if (!isCorruption(e)) throw e;
    quarantine(path);
    db = openAt(path);
  }

  if (userVersion(db) > MEMORY_SCHEMA_VERSION) {
    // Older binary, newer file (a downgrade, or a synced home dir). Serve reads,
    // refuse writes — do not "repair" a schema this build does not understand.
    db.close();
    db = new Database(path, { readonly: true });
    _readonly = true;
  } else {
    try {
      applyMigrations(db);
    } catch (e) {
      db.close();
      if (!isCorruption(e)) throw e;
      quarantine(path);
      db = openAt(path);
      applyMigrations(db);
    }
  }

  _db = db;
  _dbPath = path;
  return db;
}

export function closeMemoryDb(): void {
  try {
    _db?.close();
  } catch {}
  _db = null;
  _dbPath = '';
  _readonly = false;
}

/** True when the file on disk is newer than this build, so writes are refused. */
export function isReadOnly(): boolean {
  return _readonly;
}

// Punctuation and case carry no meaning for identity here: "Bound at write!" and
// "bound at write" are the same lesson.
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(lesson: string, scope: Scope, repoKey: string): string {
  const h = new Bun.CryptoHasher('sha256');
  // \0 as the field separator: it cannot occur in a lesson, a scope, or a repo
  // path, so no combination of the three can collide with another.
  h.update(`${normalizeText(lesson)}\0${scope}\0${repoKey}`);
  return h.digest('hex');
}

// Grammatical filler only. Negations (not/no/never/cannot/without) are deliberately
// kept: they are the whole difference between a lesson and its opposite, and the
// labelled corpus in memory.test.ts is what says whether this list is doing its job.
const STOPWORDS = new Set(
  (
    'the a an and or of to in on at is are was were be been it its that this these those as by for with from but if ' +
    'then than so do does did you your we our i my me us they them their he she his her will would can could should ' +
    'when while into over under up down out about per via also just only very more most some any all each other such own too'
  ).split(' '),
);

function contentWords(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function similarityTokens(s: string): Set<string> {
  return new Set(contentWords(s));
}

/**
 * The same content words in the same order — a rewording, not a different claim.
 *
 * A token set cannot see arrangement, and arrangement is where a negation flips: "the
 * budget is per-endpoint, not per-account" and "the budget is per-account, not
 * per-endpoint" are a perfect 1.0 against each other. Calling that a duplicate would
 * throw away the correction and keep serving the stale one — the conflict failure in
 * its worst form, because nothing is flagged and nobody is told. So identical order is
 * what "already known" requires; anything else goes to review.
 */
export function sameStatement(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * Token-set Jaccard over content words. Cheap, symmetric, and explainable to a human.
 *
 * Stopwords come out first because with them in, a same-lesson reword measures 0.833
 * — under the 0.85 "same" threshold — purely on dropped articles, while unrelated
 * lessons float up on shared filler. Content words separate the labelled corpus; raw
 * tokens do not.
 */
export function jaccard(a: string, b: string): number {
  const A = similarityTokens(a);
  const B = similarityTokens(b);
  if (A.size === 0 || B.size === 0) return A.size === B.size ? 1 : 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/** OR-joined quoted tokens. Every token is alphanumeric after normalization, so nothing needs escaping. */
function ftsQuery(text: string): string {
  const tokens = [
    ...new Set(
      normalizeText(text)
        .split(' ')
        .filter((t) => t.length > 2),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 20);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export interface RepoLessons {
  lessons: ContextLesson[];
  /** Rows quarantined as conflicting. Surfaced as a count, never as content. */
  flagged: number;
  /** Active in-scope rows, so a capped primer can say how many it left out. */
  total: number;
}

export const NO_LESSONS: RepoLessons = { lessons: [], flagged: 0, total: 0 };

function toContextLesson(r: LessonRow): ContextLesson {
  return {
    id: r.id,
    lesson: r.lesson,
    detail: r.detail,
    scope: r.scope,
    provenance: r.provenance,
    verified: r.source_verified === 1,
    sessionId: r.source_session,
    savedAt: r.created_at,
  };
}

// A repo lesson matches on the container (which already collapses worktrees) or on
// the normalized origin remote, which is the only key that survives moving the
// checkout. Global lessons match everywhere.
const SCOPE_PREDICATE = `(
  (scope = 'repo' AND (repo_container = ? OR (repo_remote <> '' AND repo_remote = ?)))
  OR scope = 'global'
)`;

/**
 * Lessons for one repo, repo scope before global, newest first within each tier.
 *
 * No scoring function: sessions get one because there are hundreds and most are
 * trivial, lessons are few and hand-curated. A ranker here would be a second tuning
 * surface with no regression signal, and it would quietly absorb the junk-drawer
 * signal that `total > limit` is supposed to make loud.
 */
export function readLessonsForRepo(container: string, remote: string, limit: number): RepoLessons {
  try {
    const db = getMemoryDb();
    if (!db) return NO_LESSONS;

    const rows = db
      .query<LessonRow, [string, string, number]>(
        `SELECT * FROM lessons
         WHERE status = 'active' AND ${SCOPE_PREDICATE}
         ORDER BY (scope = 'repo') DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(container, remote, limit);

    const total =
      db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM lessons WHERE status = 'active' AND ${SCOPE_PREDICATE}`,
        )
        .get(container, remote)?.n ?? 0;

    const flagged =
      db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM lessons WHERE status = 'needs_review' AND ${SCOPE_PREDICATE}`,
        )
        .get(container, remote)?.n ?? 0;

    return { lessons: rows.map(toContextLesson), flagged, total };
  } catch {
    // The primer must never fail because of the lesson store.
    return NO_LESSONS;
  }
}

export interface RememberInput {
  lesson: string;
  detail?: string;
  scope?: Scope;
  /** resolveRepo().container — already worktree-collapsed. */
  container?: string;
  /** Normalized origin remote, so the lesson survives a moved checkout. */
  remote?: string;
  files?: string[];
  /** Explicit correction of an existing lesson. The only non-human path to supersession besides review. */
  supersedes?: number;
  source: SessionProvenance;
  now?: string;
}

export type RememberOutcome = 'saved' | 'known' | 'conflict' | 'rejected';

export interface RememberResult {
  outcome: RememberOutcome;
  id?: number;
  status?: LessonStatus;
  provenance?: Provenance;
  verified?: boolean;
  reviewGroup?: number;
  conflicts?: { id: number; lesson: string }[];
  message: string;
}

function reject(message: string): RememberResult {
  return { outcome: 'rejected', message };
}

/**
 * "Already known" is misleading when the matched row is out of service — an agent
 * would read it as "this is on file and being used". Say which it is: a retirement or
 * a supersession is a decision someone made, and re-saving the text does not undo it.
 */
function statusNote(row: LessonRow): string {
  switch (row.status) {
    case 'active':
      return '';
    case 'retired':
      return ' Note: that lesson was retired and is not served — do not re-save it, raise it with the user instead.';
    case 'superseded':
      return ` Note: that lesson was superseded by #${row.superseded_by} and is not served.`;
    case 'needs_review':
      return ' Note: that lesson is flagged as conflicting and is withheld until a human resolves it.';
  }
}

function insertFts(db: Database, id: number, lesson: string, detail: string): void {
  db.run('DELETE FROM lessons_fts WHERE id = ?', [id]);
  db.run('INSERT INTO lessons_fts (id, lesson, detail) VALUES (?, ?, ?)', [id, lesson, detail]);
}

/** Active rows in the same scope bucket that share indexed tokens with `lesson`. */
function shortlist(db: Database, lesson: string, scope: Scope, container: string): LessonRow[] {
  const match = ftsQuery(lesson);
  if (!match) return [];
  const bucket = scope === 'global' ? "l.scope = 'global'" : "l.scope = 'repo' AND l.repo_container = ?";
  const params: (string | number)[] = scope === 'global' ? [match] : [match, container];
  try {
    return db
      .query<LessonRow, any[]>(
        `SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.id
         WHERE lessons_fts MATCH ? AND l.status = 'active' AND ${bucket}`,
      )
      .all(...params);
  } catch {
    return [];
  }
}

/**
 * Save a lesson, or say why it was not saved.
 *
 * Four things keep this from becoming a junk drawer, in order of how much work they
 * do: the length bounds above, exact-content idempotency, near-duplicate quarantine,
 * and making the pressure visible in the primer.
 */
export function rememberLesson(input: RememberInput): RememberResult {
  const lesson = input.lesson.trim();
  const detail = (input.detail ?? '').trim();
  const scope: Scope = input.scope ?? 'repo';
  const container = input.container ?? '';
  const remote = input.remote ?? '';

  if (!lesson) return reject('lesson is empty.');
  if (lesson.length > LESSON_MAX_CHARS) {
    return reject(
      `lesson is ${lesson.length} chars, over the ${LESSON_MAX_CHARS} limit — compress it to one transferable sentence and move the specifics into detail.`,
    );
  }
  if (detail.length > DETAIL_MAX_CHARS) {
    return reject(
      `detail is ${detail.length} chars, over the ${DETAIL_MAX_CHARS} limit — keep the file, root cause, and fix; drop the narrative.`,
    );
  }
  if (scope === 'repo' && !container) {
    return reject('scope "repo" needs a git repo — run from inside one, or save this as scope "global".');
  }

  const db = getMemoryDb({ create: true });
  if (!db) return reject('could not open the lesson store.');
  if (_readonly) {
    return reject(
      `${getMemoryDbPath()} was written by a newer sessions build; upgrade before saving so its schema is not rewritten by an older one.`,
    );
  }

  const now = input.now ?? new Date().toISOString();
  const repoKey = scope === 'global' ? '' : container;
  const hash = contentHash(lesson, scope, repoKey);

  // Exact re-save: the highest-volume junk source is the same agent saving the same
  // lesson every session. Bump the recurrence signal, insert nothing.
  const existing = db.query<LessonRow, [string]>('SELECT * FROM lessons WHERE content_hash = ?').get(hash);
  if (existing) {
    db.run('UPDATE lessons SET last_seen_at = ? WHERE id = ?', [now, existing.id]);
    return {
      outcome: 'known',
      id: existing.id,
      status: existing.status,
      provenance: existing.provenance,
      verified: existing.source_verified === 1,
      message: `already known — lesson #${existing.id}, last seen bumped. Nothing inserted.${statusNote(existing)}`,
    };
  }

  // An explicit supersedes is a stated relationship, so it retires the incumbent
  // before the near-duplicate scan runs and never lands in review.
  let superseded: LessonRow | null = null;
  if (input.supersedes !== undefined) {
    superseded = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(input.supersedes);
    if (!superseded) return reject(`no lesson #${input.supersedes} to supersede.`);
    if (superseded.superseded_by !== null) {
      return reject(`lesson #${input.supersedes} was already superseded by #${superseded.superseded_by}.`);
    }
  }

  const candidates = superseded ? [] : shortlist(db, lesson, scope, container);
  let same: LessonRow | null = null;
  const band: LessonRow[] = [];
  for (const row of candidates) {
    const j = jaccard(lesson, row.lesson);
    if (j < REVIEW_JACCARD) continue;
    if (j >= SAME_LESSON_JACCARD && sameStatement(lesson, row.lesson)) {
      same = row;
      break;
    }
    // Everything else that overlaps this much is contested, including a perfect
    // token-set match whose words are rearranged.
    band.push(row);
  }

  // Same lesson worded differently — treat it as a recurrence, not a new row.
  if (same) {
    db.run('UPDATE lessons SET last_seen_at = ? WHERE id = ?', [now, same.id]);
    return {
      outcome: 'known',
      id: same.id,
      status: same.status,
      provenance: same.provenance,
      verified: same.source_verified === 1,
      message: `already known — lesson #${same.id} says the same thing ("${same.lesson}"). Last seen bumped, nothing inserted.${statusNote(same)}`,
    };
  }

  const conflict = band.length > 0;
  const status: LessonStatus = conflict ? 'needs_review' : 'active';
  const src = input.source;

  const id = db.transaction(() => {
    db.run(
      `INSERT INTO lessons (content_hash, lesson, detail, scope, repo_container, repo_remote, files, tool,
                            source_session, source_transcript, source_tool_use_id, provenance, source_verified,
                            status, supersedes_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        lesson,
        detail,
        scope,
        scope === 'global' ? '' : container,
        scope === 'global' ? '' : remote,
        JSON.stringify(input.files ?? []),
        src.tool,
        src.sessionId,
        src.transcript,
        src.toolUseId,
        src.provenance,
        src.verified ? 1 : 0,
        status,
        superseded?.id ?? null,
        now,
        now,
      ],
    );
    const newId = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
    insertFts(db, newId, lesson, detail);

    if (superseded) {
      db.run("UPDATE lessons SET status = 'superseded', superseded_by = ? WHERE id = ?", [newId, superseded.id]);
    }
    if (conflict) {
      // Flag BOTH rows. Quarantining only the newcomer would keep serving the
      // possibly-stale incumbent as fact while the correction sits invisible —
      // the exact inversion of what a conflict should do.
      db.run('UPDATE lessons SET status = ?, review_group = ? WHERE id = ?', ['needs_review', newId, newId]);
      for (const row of band) {
        db.run('UPDATE lessons SET status = ?, review_group = ? WHERE id = ?', ['needs_review', newId, row.id]);
      }
    }
    return newId;
  })();

  if (conflict) {
    return {
      outcome: 'conflict',
      id,
      status: 'needs_review',
      provenance: src.provenance,
      verified: src.verified,
      reviewGroup: id,
      conflicts: band.map((r) => ({ id: r.id, lesson: r.lesson })),
      message:
        `saved #${id} as needs_review — it overlaps ${band.length === 1 ? 'an existing lesson' : `${band.length} existing lessons`}, ` +
        `now also flagged: ${band.map((r) => `#${r.id} "${r.lesson}"`).join('; ')}. ` +
        'Neither is served in the primer until a human picks. Raise the conflict with the user, or run `sessions lessons review`.',
    };
  }

  const note = superseded ? ` It supersedes #${superseded.id}.` : '';
  return {
    outcome: 'saved',
    id,
    status,
    provenance: src.provenance,
    verified: src.verified,
    message: `saved lesson #${id} (${scope} scope, provenance ${src.provenance}${src.verified ? ', verified' : ''}).${note}`,
  };
}

export interface ListOptions {
  container?: string;
  remote?: string;
  all?: boolean;
  status?: LessonStatus;
}

export function listLessons(opts: ListOptions = {}): LessonRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.all) {
    conditions.push(SCOPE_PREDICATE);
    params.push(opts.container ?? '', opts.remote ?? '');
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .query<LessonRow, any[]>(`SELECT * FROM lessons ${where} ORDER BY (scope = 'repo') DESC, created_at DESC, id DESC`)
    .all(...params);
}

export function countLessons(): number {
  const db = getMemoryDb();
  if (!db) return 0;
  try {
    return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n ?? 0;
  } catch {
    return 0;
  }
}

export interface ReviewGroup {
  group: number;
  rows: LessonRow[];
}

export function reviewGroups(): ReviewGroup[] {
  const db = getMemoryDb();
  if (!db) return [];
  const rows = db
    .query<LessonRow, []>(
      "SELECT * FROM lessons WHERE status = 'needs_review' AND review_group IS NOT NULL ORDER BY review_group, id",
    )
    .all();
  const groups = new Map<number, LessonRow[]>();
  for (const r of rows) {
    const g = r.review_group!;
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

export type ReviewChoice = 'new' | 'old' | 'both';

/**
 * Resolve one review group. Nothing is edited in place and nothing is merged: the
 * losing row is marked superseded or retired and stays readable.
 */
export function resolveReview(group: number, choice: ReviewChoice, now = new Date().toISOString()): number {
  const db = getMemoryDb();
  if (!db || _readonly) return 0;
  const rows = db
    .query<LessonRow, [number]>("SELECT * FROM lessons WHERE review_group = ? AND status = 'needs_review' ORDER BY id")
    .all(group);
  if (rows.length === 0) return 0;

  // The group key is the newcomer's own id, so it is the last row by id.
  const winner = rows[rows.length - 1]!;
  const losers = rows.slice(0, -1);

  db.transaction(() => {
    if (choice === 'both') {
      for (const r of rows) db.run("UPDATE lessons SET status = 'active', review_group = NULL WHERE id = ?", [r.id]);
      return;
    }
    if (choice === 'new') {
      db.run("UPDATE lessons SET status = 'active', review_group = NULL, last_seen_at = ? WHERE id = ?", [
        now,
        winner.id,
      ]);
      for (const r of losers) {
        db.run("UPDATE lessons SET status = 'superseded', review_group = NULL, superseded_by = ? WHERE id = ?", [
          winner.id,
          r.id,
        ]);
        db.run('UPDATE lessons SET supersedes_id = ? WHERE id = ?', [r.id, winner.id]);
      }
      return;
    }
    // keep-old: the newcomer is retired, the incumbents go back to active.
    db.run("UPDATE lessons SET status = 'retired', review_group = NULL WHERE id = ?", [winner.id]);
    for (const r of losers) db.run("UPDATE lessons SET status = 'active', review_group = NULL WHERE id = ?", [r.id]);
  })();

  return rows.length;
}

/** Take a lesson out of service by hand. Marked, never removed — the text stays readable. */
export function retireLesson(id: number): boolean {
  const db = getMemoryDb();
  if (!db || _readonly) return false;
  db.run("UPDATE lessons SET status = 'retired' WHERE id = ? AND status IN ('active', 'needs_review')", [id]);
  return (db.query<{ n: number }, []>('SELECT changes() AS n').get()?.n ?? 0) > 0;
}

/** Rows whose session is unknown but whose tool_use id is traceable in the transcripts. */
export function deferredLessons(): LessonRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  return db
    .query<LessonRow, []>(
      "SELECT * FROM lessons WHERE provenance = 'deferred' AND source_tool_use_id IS NOT NULL ORDER BY id",
    )
    .all();
}

/** Back-fill a deferred row from an audit hit. 'recovered' records that it was traced, not stated. */
export function recoverLesson(id: number, sessionId: string, transcript: string): void {
  const db = getMemoryDb();
  if (!db || _readonly) return;
  db.run(
    `UPDATE lessons SET source_session = ?, source_transcript = ?, provenance = 'recovered', source_verified = 1
     WHERE id = ? AND provenance = 'deferred'`,
    [sessionId, transcript, id],
  );
}

export interface ExportedLesson {
  id: number;
  lesson: string;
  detail: string;
  scope: Scope;
  repo: { container: string; remote: string };
  files: string[];
  tool: string;
  source: {
    session: string | null;
    transcript: string | null;
    toolUseId: string | null;
    provenance: Provenance;
    verified: boolean;
  };
  status: LessonStatus;
  supersedes: number | null;
  supersededBy: number | null;
  createdAt: string;
  lastSeenAt: string;
}

/** Portable form of the whole store — the reason uninstall can honestly leave the file alone. */
export function exportLessons(): ExportedLesson[] {
  const db = getMemoryDb();
  if (!db) return [];
  const rows = db.query<LessonRow, []>('SELECT * FROM lessons ORDER BY id').all();
  return rows.map((r) => ({
    id: r.id,
    lesson: r.lesson,
    detail: r.detail,
    scope: r.scope,
    repo: { container: r.repo_container, remote: r.repo_remote },
    files: parseFiles(r.files),
    tool: r.tool,
    source: {
      session: r.source_session,
      transcript: r.source_transcript,
      toolUseId: r.source_tool_use_id,
      provenance: r.provenance,
      verified: r.source_verified === 1,
    },
    status: r.status,
    supersedes: r.supersedes_id,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}

export function parseFiles(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Delete the store outright. Only ever reached through an explicit, confirmed `--purge-lessons`. */
export function purgeLessons(): boolean {
  closeMemoryDb();
  const path = getMemoryDbPath();
  let removed = false;
  for (const f of [path, path + '-wal', path + '-shm', path + '-journal']) {
    try {
      unlinkSync(f);
      if (f === path) removed = true;
    } catch {}
  }
  return removed;
}
