import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWrapped, parseWrappedArgs, parseExtras } from './index.ts';
import { longestGapRange } from './compute.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sessions-wrapped-run-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claudeDir = join(tmp, 'claude');
mkdirSync(join(claudeDir, 'proj'), { recursive: true });

const event = (sessionId: string, timestamp: string, model = 'claude-opus-4-6', input = 1000, output = 500) =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd: '/Users/x/Developer/sessions',
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 10_000,
      },
    },
  }) + '\n';

writeFileSync(
  join(claudeDir, 'proj', 'a.jsonl'),
  // One long sitting (three replies 10 min apart) …
  event('s1', '2026-06-01T14:00:00Z') +
    event('s1', '2026-06-01T14:10:00Z') +
    event('s1', '2026-06-01T14:20:00Z') +
    // … then the same session resumed three weeks later — must not count as a 3-week sitting.
    event('s1', '2026-06-22T09:00:00Z') +
    // A small-hours event (03:30 UTC = 22:30 America/Chicago the previous day; use UTC tz in tests).
    event('s2', '2026-06-03T03:30:00Z', 'claude-fable-5') +
    // Out-of-year noise that must be filtered.
    event('s3', '2025-11-11T11:00:00Z'),
);
const roots = { claudeCode: claudeDir, pi: join(tmp, 'no-pi'), codex: join(tmp, 'no-codex') };
const NOW = '2026-07-13T12:00:00Z';

describe('parseWrappedArgs', () => {
  test('defaults', () => {
    const o = parseWrappedArgs([]);
    expect(o.stdout).toBe(false);
    expect(o.year).toBeUndefined();
    expect(o.out).toBeUndefined();
  });

  test('parses flags', () => {
    const o = parseWrappedArgs(['--year', '2025', '--tool', 'claude', '--tz', 'UTC', '--stdout', '--offline']);
    expect(o.year).toBe(2025);
    expect(o.tool).toBe('claude-code');
    expect(o.tz).toBe('UTC');
    expect(o.stdout).toBe(true);
    expect(o.offline).toBe(true);
  });

  test('parses --roast and --roast-with', () => {
    expect(parseWrappedArgs(['--roast']).roast).toBe(true);
    const o = parseWrappedArgs(['--roast-with', 'codex']);
    expect(o.roast).toBe(true);
    expect(o.roastWith).toBe('codex');
  });

  test('rejects a bad --roast-with tool', () => {
    const r = Bun.spawnSync([
      'bun',
      '-e',
      "require('./src/wrapped/index.ts').parseWrappedArgs(['--roast-with','gemini'])",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('--roast-with');
  });

  test('rejects a bad year in a child process', () => {
    const r = Bun.spawnSync(['bun', '-e', "require('./src/wrapped/index.ts').parseWrappedArgs(['--year','20'])"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('--year');
  });

  test('unknown flag dies', () => {
    const r = Bun.spawnSync(['bun', '-e', "require('./src/wrapped/index.ts').parseWrappedArgs(['--nope'])"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('unknown option');
  });
});

describe('parseExtras', () => {
  test('accepts well-formed slides and caps fields', () => {
    const extras = parseExtras(
      JSON.stringify([
        { headline: 'You said "one more try" 11 times on a Tuesday', title: 'roast', subline: 'it did not work' },
        { headline: '   ' }, // blank headline → dropped
        { nope: true }, // no headline → dropped
        'not an object',
      ]),
    );
    expect(extras).toHaveLength(1);
    expect(extras[0]!.title).toBe('roast');
  });

  test('caps the number of slides at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ headline: `slide ${i}` }));
    expect(parseExtras(JSON.stringify(many))).toHaveLength(6);
  });

  test('caps by code points — never splits a surrogate pair', () => {
    const emoji = '🎉'.repeat(200); // 400 UTF-16 units, 200 code points
    const [slide] = parseExtras(JSON.stringify([{ headline: emoji }]));
    expect([...slide!.headline]).toHaveLength(120);
    // No lone surrogate at the cut point.
    expect(/[\uD800-\uDBFF]$/.test(slide!.headline)).toBe(false);
  });
});

describe('longestGapRange', () => {
  test('finds the widest silence strictly between active days', () => {
    expect(longestGapRange(['2026-01-01', '2026-01-02', '2026-01-10'])).toEqual({
      days: 7,
      from: '2026-01-03',
      to: '2026-01-09',
    });
  });
  test('consecutive or single days have no gap', () => {
    expect(longestGapRange(['2026-01-01', '2026-01-02'])).toBeNull();
    expect(longestGapRange(['2026-01-01'])).toBeNull();
    expect(longestGapRange([])).toBeNull();
  });
});

describe('runWrapped', () => {
  test('computes a year-scoped, sitting-aware wrapped', async () => {
    const res = await runWrapped({
      tz: 'UTC',
      stdout: true,
      offline: true,
      roots,
      now: NOW,
      noContent: true,
    });
    const data = JSON.parse(res.json);

    expect(data.year).toBe(2026);
    expect(data.period).toEqual({ from: '2026-01-01', to: '2026-07-13' });
    // s3 is 2025 — filtered; s1 + s2 remain.
    expect(data.totals.sessions).toBe(2);
    expect(data.totals.messages).toBe(5);
    // Longest sitting is the 20-minute run, not the 3-week session span.
    expect(data.longestSession.durationMs).toBe(20 * 60_000);
    expect(data.longestSession.replies).toBe(3);
    // 03:30 UTC lands in the small-hours census.
    expect(data.rhythm.nightsPastMidnight).toBe(1);
    expect(data.rhythm.latestNight.clock).toContain('3:30');
    // Token rule matches the report: input + output + cacheWrite, cacheRead excluded.
    expect(data.totals.tokens).toBe(5 * (1000 + 500 + 200));
    // Per-tool sessions are distinct (s1 spans June 1 + June 22 — aggregate's
    // sum-of-daily would say 3; the headline total and tools[] must agree).
    expect(data.tools[0].sessions).toBe(2);
    expect(data.totals.cacheReadTokens).toBe(5 * 10_000);
    expect(data.cacheHitRate).toBeCloseTo(10_000 / 11_000, 5);
    // Model adoption dates observed.
    const fable = data.models.find((m: { id: string }) => m.id === 'claude-fable-5');
    expect(fable.firstSeen).toBe('2026-06-03');
    expect(fable.firstTopDay).toBe('2026-06-03');
    expect(data.dataBegins).toBe('2026-06-01');
    // Active days are Jun 1, 3, and 22 — the 18 silent days between the 3rd
    // and the 22nd are the year's longest disappearance.
    expect(data.longestGap).toEqual({ days: 18, from: '2026-06-04', to: '2026-06-21' });
    expect(data.modelsTried).toBe(2);
  });

  test('--year selects a past calendar year in full', async () => {
    const res = await runWrapped({
      tz: 'UTC',
      stdout: true,
      offline: true,
      roots,
      now: NOW,
      year: 2025,
      noContent: true,
    });
    const data = JSON.parse(res.json);
    expect(data.period).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(data.totals.sessions).toBe(1);
  });

  test('writes self-contained HTML with no external requests and no innerHTML', async () => {
    const out = join(tmp, 'wrapped.html');
    const res = await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      out,
      noContent: true,
    });
    expect(res.htmlPath).toBe(out);
    const html = readFileSync(out, 'utf8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('wrapped');
    expect(html).toContain('2026');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('innerHTML');
    // The story spine renders.
    expect(html).toContain('id="cover"');
    expect(html).toContain('id="tokens"');
    expect(html).toContain('id="credits"');
    // The 18-day silence clears the 7-day bar for the disappearance card.
    expect(html).toContain('id="vanish"');
    // Mid-year runs disclose partial coverage.
    expect(html).toContain('so far');
  });

  test('an empty year still renders a page — including any extras', async () => {
    const extrasPath = join(tmp, 'empty-extras.json');
    writeFileSync(extrasPath, JSON.stringify([{ headline: 'Even quiet years get a slide' }]));
    const out = join(tmp, 'empty.html');
    await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      year: 2020,
      out,
      extras: extrasPath,
      noContent: true,
    });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('A quiet year');
    expect(html).not.toContain('id="tokens"');
    expect(html).toContain('Even quiet years get a slide');
  });

  test('--extras pointing at a missing file dies cleanly, not with a stack trace', () => {
    const r = Bun.spawnSync(
      [
        'bun',
        '-e',
        "require('./src/wrapped/index.ts').runWrapped({tz:'UTC',stdout:true,offline:true,extras:'/nope/missing.json',noContent:true,roots:{claudeCode:'/nope',pi:'/nope',codex:'/nope'}})",
      ],
      { cwd: '/Users/nicknisi/Developer/sessions' },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('--extras: cannot read');
  });

  test('--roast appends model-authored slides via the injected runner', async () => {
    const out = join(tmp, 'roasted.html');
    await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      out,
      roast: true,
      roastWith: 'claude',
      noContent: true,
      roastRunner: async () => '[{"title":"the verdict","headline":"3 whole sessions. a titan of industry."}]',
    });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('a titan of industry');
    expect(html).toContain('improvised by Claude from your stats');
  });

  test('a failed roast leaves the page intact', async () => {
    const out = join(tmp, 'roast-fail.html');
    await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      out,
      roast: true,
      roastWith: 'claude',
      noContent: true,
      roastRunner: async () => 'the model said no',
    });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('id="credits"'); // page still renders end to end
    expect(html).not.toContain('improvised by');
  });

  test('extras are injected as cards', async () => {
    const extrasPath = join(tmp, 'extras.json');
    writeFileSync(extrasPath, JSON.stringify([{ headline: 'A bespoke roast', title: 'from your agent' }]));
    const out = join(tmp, 'extras.html');
    await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      out,
      extras: extrasPath,
      noContent: true,
    });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('A bespoke roast');
    expect(html).toContain('id="extra-0"');
  });

  test('a long extra headline steps down to the punchline ramp instead of overflowing', async () => {
    const extrasPath = join(tmp, 'long-extras.json');
    const long = 'You spent $13,427 asking a machine to fix bugs you introduced while it watched you introduce more';
    writeFileSync(extrasPath, JSON.stringify([{ headline: long }, { headline: 'Short and mean' }]));
    const out = join(tmp, 'long-extras.html');
    await runWrapped({
      tz: 'UTC',
      stdout: false,
      offline: true,
      roots,
      now: NOW,
      out,
      extras: extrasPath,
      noContent: true,
    });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('big punchline');
    expect(html).toContain('big bigword');
  });
});
