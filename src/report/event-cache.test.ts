import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherEvents } from './extract.ts';
import { openEventCache } from './event-cache.ts';

// The cache dir is redirected for the whole file: nothing here may touch ~/.cache/sessions.
const tmp = mkdtempSync(join(tmpdir(), 'sessions-event-cache-'));
process.env['SESSIONS_CACHE_DIR'] = join(tmp, 'cache');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };
const transcript = join(claudeDir, 'proj', 'a.jsonl');

/** `id` is fixed-width on purpose: a test can swap it without changing the file's size. */
const event = (id: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/x/Developer/sessions',
    timestamp: ts,
    requestId: 'req_1',
    message: { id, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
  }) + '\n';

beforeEach(() => {
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(join(tmp, 'cache'), { recursive: true, force: true });
  mkdirSync(join(claudeDir, 'proj'), { recursive: true });
  writeFileSync(transcript, event('msg_1', '2026-06-01T14:30:00Z'));
  // A whole-millisecond mtime, so a test can restore it exactly: a fresh write lands on
  // sub-millisecond precision that utimes cannot reproduce.
  const stamp = new Date();
  utimesSync(transcript, stamp, stamp);
});

describe('the per-file event cache', () => {
  test('a second scan replays the stored events instead of re-reading the transcript', async () => {
    const first = await gatherEvents({ roots, cache: true });
    expect(first).toHaveLength(1);

    // Rewrite the file with different content of the same size, then put its mtime back:
    // mtime+size is the whole key, so a scan cannot tell and must serve what it stored.
    // That is the tradeoff the search index already takes, stated as a test.
    const { mtime, size } = statSync(transcript);
    writeFileSync(transcript, event('msg_9', '2026-06-01T14:30:00Z'));
    expect(statSync(transcript).size).toBe(size);
    utimesSync(transcript, mtime, mtime);

    const second = await gatherEvents({ roots, cache: true });
    expect(second).toHaveLength(1);
    expect(second[0]!.dedupeKey).toBe('msg_1|req_1');
  });

  test('a transcript that grew is re-read, not served stale', async () => {
    await gatherEvents({ roots, cache: true });
    writeFileSync(transcript, event('msg_1', '2026-06-01T14:30:00Z') + event('msg_2', '2026-06-01T14:31:00Z'));
    expect(await gatherEvents({ roots, cache: true })).toHaveLength(2);
  });

  test('cached events keep their dedupeKey, so the cross-file dedupe still runs on a hit', async () => {
    // The same API response copied into a second transcript: one event, parsed or replayed.
    writeFileSync(join(claudeDir, 'proj', 'b.jsonl'), event('msg_1', '2026-06-01T14:30:00Z'));
    expect(await gatherEvents({ roots, cache: true })).toHaveLength(1);
    expect(await gatherEvents({ roots, cache: true })).toHaveLength(1);
  });

  test('a full scan drops rows for transcripts that are gone; a bounded one does not', async () => {
    await gatherEvents({ roots, cache: true });
    const { mtimeMs, size } = statSync(transcript);
    rmSync(transcript);

    // A window-bounded scan never looked at the whole corpus, so it leaves the row alone.
    await gatherEvents({ roots, cache: true, since: Date.now() - 60_000 });
    const kept = openEventCache()!;
    expect(kept.get(transcript, mtimeMs, size)).toHaveLength(1);
    kept.close();

    // An unbounded scan did look, so it prunes what it did not find.
    await gatherEvents({ roots, cache: true });
    const pruned = openEventCache()!;
    expect(pruned.get(transcript, mtimeMs, size)).toBeNull();
    pruned.close();
  });

  test('fixture roots stay out of the shared cache unless a caller insists', async () => {
    await gatherEvents({ roots });
    expect(existsSync(join(tmp, 'cache', 'usage-events.db'))).toBe(false);
  });

  test('an unusable cache dir costs the cache and nothing else', async () => {
    const saved = process.env['SESSIONS_CACHE_DIR'];
    // A file where the cache dir should be: both the mkdir and the open fail.
    const blocked = join(tmp, 'blocked');
    writeFileSync(blocked, 'not a directory');
    process.env['SESSIONS_CACHE_DIR'] = join(blocked, 'nested');
    try {
      expect(openEventCache()).toBeNull();
      expect(await gatherEvents({ roots, cache: true })).toHaveLength(1);
    } finally {
      process.env['SESSIONS_CACHE_DIR'] = saved;
    }
  });
});
