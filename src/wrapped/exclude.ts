// What counts as "your coding year" for wrapped — and what doesn't. Two classes
// of session pollute a personal year-in-review even though they're legitimately
// on disk: automated *probes* (menu-bar apps that spawn a throwaway Claude session
// every few minutes to read a token count) and automated *harness/throwaway* runs
// (eval suites and scratch apps under temp dirs). Neither is you sitting down to
// code, yet both inflate session counts, flood the error census, and seed bogus
// superlatives ("990 sessions of love, then silence" for a health-check probe).
//
// This applies to wrapped's CONTENT pass only (the fun story: abandoned projects,
// drive-bys, word of the year, errors). The spend/volume headline (tokens, cost,
// sessions, rhythm) is deliberately NOT filtered — it must reconcile with
// `sessions report`, and automated eval runs still cost real money. `report` and
// search also see everything, because you might genuinely want to *find* that run.

/** Substring the cwd must NOT contain. */
const JUNK_SUBSTRINGS = [
  '/var/folders/', // macOS temp root — eval harnesses run under $TMPDIR/eval-*
];

/** Prefix the cwd must NOT start with. */
const JUNK_PREFIXES = [
  '/private/tmp/', // scratch apps, install tests, throwaway repros
  '/tmp/',
];

/** Suffix the cwd must NOT end with. */
const JUNK_SUFFIXES = [
  '/ClaudeProbe', // CodexBar / TokenBar menu-bar health-check sessions
];

/** True when a cwd is an automated probe / harness / throwaway, not real user work. */
export function isJunkCwd(cwd: string | undefined): boolean {
  if (!cwd) return false; // unknown cwd is kept — it's real work we just can't place
  if (JUNK_SUBSTRINGS.some((s) => cwd.includes(s))) return true;
  if (JUNK_PREFIXES.some((p) => cwd.startsWith(p))) return true;
  if (JUNK_SUFFIXES.some((s) => cwd.endsWith(s))) return true;
  return false;
}

/** The same rule as `isJunkCwd`, as a SQL fragment excluding junk rows.
 *  `col` is the qualified cwd column (e.g. `s.cwd`). Emitted with a leading
 *  space and joined by AND so it can be appended straight onto a WHERE clause. */
export function junkCwdSql(col: string): string {
  const clauses: string[] = [];
  for (const s of JUNK_SUBSTRINGS) clauses.push(`${col} NOT LIKE '%' || '${s}' || '%'`);
  for (const p of JUNK_PREFIXES) clauses.push(`${col} NOT LIKE '${p}' || '%'`);
  for (const s of JUNK_SUFFIXES) clauses.push(`${col} NOT LIKE '%' || '${s}'`);
  return clauses.map((c) => ` AND ${c}`).join('');
}
