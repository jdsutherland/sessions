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
// `sessions report`, and automated eval runs still cost real money. `report` sees
// everything for the same reason.
//
// `searchSessions` also uses this rule (see SearchOptions.includeAutomated): junk
// cwds are ~43% of a real index and are never the session a search is looking for,
// so they are removed from the candidate set rather than out-ranked. A caller who
// scopes at or inside a junk root still gets it (see `isJunkScope`), and
// `grep_sessions` — exhaustive by contract — never applies the rule at all.

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

/**
 * True when a search scope is a junk root itself, or sits at or inside one — the case
 * where applying the junk filter would exclude every session the scope selects.
 *
 * `isJunkCwd` alone is not that test: the rules are written as the prefixes a *session*
 * cwd has ("/tmp/"), so `/tmp` fails its own rule and `sessions .` run from /tmp (not a
 * git repo, so the scope is /tmp itself) reported "No sessions found". Ancestors count
 * too — a scope of `/private` selects `/private/tmp/...` — and the caller asked for
 * them explicitly, which is the whole exemption.
 */
export function isJunkScope(scope: string | undefined): boolean {
  if (!scope) return false;
  if (isJunkCwd(scope)) return true;
  const dir = scope.endsWith('/') ? scope : scope + '/';
  // The scope is the root a rule is written relative to, or an ancestor of it:
  // '/tmp/'.startsWith('/tmp/'), '/var/folders/'.startsWith('/var/').
  if ([...JUNK_SUBSTRINGS, ...JUNK_PREFIXES].some((rule) => rule.startsWith(dir))) return true;
  // Or it ends exactly at a substring rule's root, where the trailing slash is the only
  // thing isJunkCwd was missing: '/private/var/folders'.
  if (JUNK_SUBSTRINGS.some((s) => dir.includes(s))) return true;
  return false; // suffix rules have no enumerable ancestors; isJunkCwd already caught the exact dir
}

/** The same rule as `isJunkCwd`, as a single parenthesized SQL predicate that is
 *  true for the rows to KEEP. `col` is the qualified cwd column (e.g. `s.cwd`).
 *  Parenthesized so a caller can AND or OR it into a WHERE clause as one term. */
export function notJunkCwdSql(col: string): string {
  const clauses: string[] = [];
  for (const s of JUNK_SUBSTRINGS) clauses.push(`${col} NOT LIKE '%' || '${s}' || '%'`);
  for (const p of JUNK_PREFIXES) clauses.push(`${col} NOT LIKE '${p}' || '%'`);
  for (const s of JUNK_SUFFIXES) clauses.push(`${col} NOT LIKE '%' || '${s}'`);
  return `(${clauses.join(' AND ')})`;
}

/** `notJunkCwdSql` pre-joined with a leading AND, so it can be appended straight
 *  onto an existing WHERE clause. */
export function junkCwdSql(col: string): string {
  return ` AND ${notJunkCwdSql(col)}`;
}
