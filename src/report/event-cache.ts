// Parsed usage events, cached per transcript and keyed by mtime+size — the same signal the
// search index trusts to decide a file has not changed. A closed session is never rewritten,
// so re-reading it costs 2.7 GB of I/O to produce bytes we already had.
//
// The mtime prune bounds a scan to the window's *lower* edge; this bounds it to what actually
// changed. Together, a metrics call reads a few new transcripts instead of every one ever
// written, and stays that way as history grows.
//
// !! BUMP CACHE_VERSION WHENEVER A PARSER CHANGES WHAT IT EMITS. Transcripts are
// append-then-frozen: nothing re-parses on its own, so an old row would be served forever
// (see the v12 note in src/cache.ts for how that bug reads in production).
//
// Every failure here is non-fatal. An unwritable cache dir, a locked database, a corrupt
// file: the report parses from source instead, exactly as it did before this existed.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import type { UsageEvent } from './parsers/types.ts';
import { getCacheDir, getEventCachePath } from '../paths.ts';

// v1: path, mtime, size → the file's events as gzipped JSON, undeduped (Claude's dedupe spans
// files and runs in gatherEvents, so the stored events keep their dedupeKey). Undeduped is
// most of the bulk — a resumed session copies every prior assistant line into the new
// transcript — and it compresses ~8x, which is the difference between a 150 MB cache and
// a 17 MB one for a corpus this size. Decompressing a window's worth costs single-digit ms.
const CACHE_VERSION = 1;
const GZIP_LEVEL = 1; // 0.12 of raw at 3x the speed of the default; level 6 only reaches 0.09

interface Row {
  mtime: number;
  size: number;
  events: Uint8Array<ArrayBuffer>;
}

export interface EventCache {
  /** The file's parsed events, or null if it is absent or has changed since it was stored. */
  get(path: string, mtimeMs: number, size: number): UsageEvent[] | null;
  put(path: string, mtimeMs: number, size: number, events: UsageEvent[]): void;
  /** Write everything buffered and close. `livePaths` — supplied only by a scan that walked
   *  every transcript — drops rows for files that no longer exist. */
  close(livePaths?: string[]): void;
}

export function openEventCache(): EventCache | null {
  let db: Database;
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    db = new Database(getEventCachePath());
    db.run('PRAGMA busy_timeout=5000');
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=NORMAL');
    const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    if (!row || row.user_version !== CACHE_VERSION) {
      db.run('DROP TABLE IF EXISTS files');
      db.run(`PRAGMA user_version = ${CACHE_VERSION}`);
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        events BLOB NOT NULL
      )
    `);
  } catch {
    // Corrupt, locked, or unwritable — parse from source and leave the file alone.
    return null;
  }
  return new SqliteEventCache(db);
}

class SqliteEventCache implements EventCache {
  private readonly select;
  private pending: [string, number, number, Uint8Array][] = [];

  constructor(private readonly db: Database) {
    this.select = db.query<Row, [string]>('SELECT mtime, size, events FROM files WHERE path = ?');
  }

  get(path: string, mtimeMs: number, size: number): UsageEvent[] | null {
    try {
      const row = this.select.get(path);
      // Same staleness test as the index: a rewrite that preserves both is indistinguishable
      // from no rewrite at all, and transcripts only ever grow.
      if (!row || row.mtime !== mtimeMs || row.size !== size) return null;
      return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.events))) as UsageEvent[];
    } catch {
      return null;
    }
  }

  put(path: string, mtimeMs: number, size: number, events: UsageEvent[]): void {
    try {
      this.pending.push([path, mtimeMs, size, Bun.gzipSync(JSON.stringify(events), { level: GZIP_LEVEL })]);
    } catch {
      // Unserializable events would be a parser bug; skip the row rather than fail the report.
    }
  }

  close(livePaths?: string[]): void {
    try {
      const upsert = this.db.query(
        'INSERT INTO files (path, mtime, size, events) VALUES (?, ?, ?, ?)' +
          ' ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, events = excluded.events',
      );
      this.db.transaction(() => {
        for (const row of this.pending) upsert.run(...row);
        if (livePaths) this.prune(livePaths);
      })();
    } catch {
      // A contended or read-only database costs this run's writes, nothing more.
    }
    this.pending = [];
    try {
      this.db.close();
    } catch {}
  }

  /** Deleted transcripts, dropped. Only a full scan knows the live set — a pruned one has
   *  not looked at the old files and must not conclude they are gone. */
  private prune(livePaths: string[]): void {
    this.db.run('CREATE TEMP TABLE IF NOT EXISTS live (path TEXT PRIMARY KEY)');
    this.db.run('DELETE FROM live');
    const insert = this.db.query('INSERT OR IGNORE INTO live (path) VALUES (?)');
    for (const path of livePaths) insert.run(path);
    this.db.run('DELETE FROM files WHERE path NOT IN (SELECT path FROM live)');
  }
}
