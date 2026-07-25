import { type Tool } from './types';

export interface JsonLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  customTitle?: string;
  promptSource?: string | null;
  /** Claude marks auto-generated context-carryover turns (the "continued from a
   *  previous conversation" summary written on compaction) with this flag. */
  isCompactSummary?: boolean;
  /** True on every line of a subagent (Task) transcript — which carries the
   *  PARENT sessionId, so its injected "user" prompt would otherwise pass for
   *  the human speaking mid-session. */
  isSidechain?: boolean;
  message?: Record<string, unknown> | string;
  payload?: Record<string, unknown>;
}

export function tryParseJson(line: string): JsonLine | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export interface SessionMetadata {
  cwd: string;
  customTitle: string;
  date: string;
  createdAt: string;
  messageCount: number;
  branch: string;
  /** The id the transcript states about itself, or '' — feed it to sessionIdFor. */
  sessionId: string;
}

/**
 * Whether a line counts toward the session's conversational message count. This counts
 * LINES, not messages — a pure tool-use assistant line counts, and extractMessages folds
 * it away — so it runs ~5x above the indexed message count. That gap is real and
 * pre-existing; closing it moves the eval baseline and belongs in its own change.
 * The differential oracle (messageCount) and the one-pass indexer share this predicate
 * so they cannot drift, which is how Codex ended up counted as zero: its conversation
 * is wrapped in `response_item`, a shape neither branch below recognizes.
 */
function countsAsMessage(d: JsonLine, tool: Tool): boolean {
  if (tool === 'codex') {
    if (d.type !== 'response_item') return false;
    const p = d.payload;
    // `developer` is the injected system prompt, not a turn.
    return p?.['type'] === 'message' && (p['role'] === 'user' || p['role'] === 'assistant');
  }
  if (isUserMessage(d) || d.type === 'assistant') return true;
  if (d.type === 'message') {
    const msg = d.message;
    return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).role === 'assistant';
  }
  return false;
}

/**
 * Extract the session-level fields needed by the index in one JSON parse pass.
 * These used to be collected by six independent helpers, which made indexing an
 * actively growing (and often multi-megabyte) transcript parse the same JSONL
 * records over and over.
 */
export function extractSessionMetadata(lines: string[], tool: Tool): SessionMetadata {
  let cwd = '';
  let title = '';
  let firstDate = '?';
  let lastDate = '?';
  let count = 0;
  let branch = '';
  let sessionId = '';

  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (!cwd) {
      if (tool === 'claude' && d.cwd) {
        cwd = d.cwd;
      } else if ((tool === 'pi' || tool === 'opencode') && d.type === 'session' && d.cwd) {
        cwd = d.cwd;
      } else if (tool === 'codex' && d.type === 'session_meta') {
        const value = (d.payload as Record<string, unknown> | undefined)?.cwd;
        if (typeof value === 'string' && value) cwd = value;
      }
    }

    // Where each harness writes its own id. Claude repeats it on every line; Codex
    // and Pi state it once, in the session header. OpenCode's synthesized lines carry
    // none — its id is the synthetic path's basename.
    if (!sessionId) {
      if (tool === 'claude' && typeof d.sessionId === 'string' && d.sessionId) {
        sessionId = d.sessionId;
      } else if (tool === 'pi' && d.type === 'session') {
        const value = (d as Record<string, unknown>)['id'];
        if (typeof value === 'string' && value) sessionId = value;
      } else if (tool === 'codex' && d.type === 'session_meta') {
        const value = (d.payload as Record<string, unknown> | undefined)?.['id'];
        if (typeof value === 'string' && value) sessionId = value;
      }
    }

    if (d.type === 'custom-title') title = d.customTitle ?? '';

    if (d.timestamp?.[0] === '2') {
      const date = d.timestamp.slice(0, 10);
      if (firstDate === '?') firstDate = date;
      lastDate = date;
    }

    if (countsAsMessage(d, tool)) count++;

    if (tool === 'claude') {
      if (typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch;
    } else if (tool === 'codex' && !branch && d.type === 'session_meta') {
      const git = (d.payload as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
      if (typeof git?.branch === 'string' && git.branch) branch = git.branch;
    }
  }

  return { cwd, customTitle: title, date: lastDate, createdAt: firstDate, messageCount: count, branch, sessionId };
}

export function getCwdFromSession(lines: string[], tool: Tool): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (tool === 'claude') {
      if (d.cwd) return d.cwd;
    } else if (tool === 'pi' || tool === 'opencode') {
      // Pi's native shape; OpenCode synthesizes the same session line (see src/opencode.ts).
      if (d.type === 'session' && d.cwd) return d.cwd;
    } else if (tool === 'codex') {
      if (d.type === 'session_meta') {
        const cwd = (d.payload as Record<string, unknown>)?.cwd as string;
        if (cwd) return cwd;
      }
    }
  }
  return '';
}

/**
 * The git branch a session ran on, read from the logs (not the current worktree).
 * Claude writes `gitBranch` on every line, so the last non-empty one is "where
 * you left off". Codex records its starting branch once in `session_meta`. Pi
 * and OpenCode carry no git metadata, so they return ''.
 */
export function sessionBranch(lines: string[], tool: Tool): string {
  if (tool === 'codex') {
    for (const line of lines) {
      const d = tryParseJson(line);
      if (d?.type !== 'session_meta') continue;
      const git = (d.payload as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
      const b = git?.branch;
      if (typeof b === 'string' && b) return b;
    }
    return '';
  }
  if (tool === 'claude') {
    let branch = '';
    for (const line of lines) {
      const d = tryParseJson(line);
      const b = d?.gitBranch;
      if (typeof b === 'string' && b) branch = b; // keep the last non-empty
    }
    return branch;
  }
  return ''; // pi, opencode: no git metadata in logs
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function stripInjected(text: string): string {
  const patterns = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
    /<command-name>[\s\S]*?<\/command-name>/g,
    /<command-message>[\s\S]*?<\/command-message>/g,
    /<command-args>[\s\S]*?<\/command-args>/g,
    // Agent/harness injections that ride in on a user-role line but are not the
    // human talking: task-completion pings, `!`-mode shell echoes, teammate relays.
    // `\b[^>]*` tolerates attributes on the opening tag (e.g. <teammate-message
    // teammate_id="..." color="...">), which these tags carry in multi-agent logs.
    /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/g,
    /<bash-input\b[^>]*>[\s\S]*?<\/bash-input>/g,
    /<bash-stdout\b[^>]*>[\s\S]*?<\/bash-stdout>/g,
    /<bash-stderr\b[^>]*>[\s\S]*?<\/bash-stderr>/g,
    /<teammate-message\b[^>]*>[\s\S]*?<\/teammate-message>/g,
  ];
  for (const p of patterns) {
    text = text.replace(p, '');
  }
  return text;
}

export function extractUserText(d: JsonLine): string {
  const msg = d.message;
  if (!msg || typeof msg !== 'object') return '';
  const content = (msg as Record<string, unknown>).content;
  const texts: string[] = [];

  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        typeof c === 'object' &&
        c !== null &&
        ((c as Record<string, unknown>).type === 'text' || (c as Record<string, unknown>).type === 'input_text')
      ) {
        texts.push((c as Record<string, string>).text ?? '');
      }
    }
  } else if (typeof content === 'string') {
    texts.push(content);
  }
  return stripInjected(texts.join(' '));
}

export function isUserMessage(d: JsonLine): boolean {
  if (d.type === 'user') return true;
  if (d.type === 'message') {
    const msg = d.message;
    return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).role === 'user';
  }
  return false;
}

/** Claude prepends this exact line to every skill body it injects as a user turn. */
const SKILL_INJECTION_PREAMBLE = /^Base directory for this skill:/;

/**
 * Whether a user-role line is a genuine human turn — not a tool result, a
 * system-injected turn, a compaction summary, or a skill body injected as a
 * user message. The disqualifiers below fire regardless of `promptSource`
 * because agent/harness injections (compaction carryover, task-completion
 * pings echoed as `!`-mode shell lines) can arrive with any source.
 * Claude lines then carry `promptSource`: when the field is present, only
 * `typed` and `queued` count (a present-but-null value, as tool results and
 * skill loads have, is rejected). Older logs and pi/codex have no
 * `promptSource`, so fall back to a heuristic: non-empty text that isn't a
 * skill-injection preamble. (Tag-wrapped injections — <task-notification>,
 * <bash-input>, <bash-stdout>, <teammate-message> — are already emptied by
 * stripInjected upstream, so they never reach here with text.)
 */
export function isGenuineUserTurn(d: JsonLine, strippedText: string): boolean {
  if (d.isCompactSummary === true) return false;
  if (!strippedText) return false;
  if (SKILL_INJECTION_PREAMBLE.test(strippedText)) return false;
  if ('promptSource' in d) {
    return d.promptSource === 'typed' || d.promptSource === 'queued';
  }
  return true;
}

/**
 * Rows the CLI writes into the transcript in a conversational role but that are
 * harness bookkeeping, not conversation: transport-error banners, interrupt
 * markers, tool-load acks, client-side prompt scaffolding. They are short, so FTS5's
 * length normalization scores them like a whole analysis, and most are USER rows — so
 * they also collect the user-hit boost. On the author's index, seven of the top ten
 * hits for "rate limiting" were `API Error: Rate limit reached`.
 *
 * These rows stay IN message_fts and are removed on the way OUT, in searchSessions —
 * the same place junk cwds are filtered, and for the same reason: `grep_sessions` is
 * exhaustive by contract, so "how many times did I hit a rate limit" has to keep
 * finding every one of them. Two consequences worth keeping: the denylist is editable
 * without a reindex, and adding an entry hides text from ranking rather than
 * destroying it.
 *
 * The banner family reaches the index by a second route as well: extractErrors copies
 * a transport banner into `session_fts.context_text`, where it ranks at bm25 2.0 and
 * needs no message hit to place a session. That column is one blob per session with no
 * per-line granularity to filter on read, so it is filtered on the way in instead —
 * `isHarnessNoise` below, same list. Only the text is dropped: a banner is still
 * evidence the session hit an error, so `errored` and error_count keep counting it and
 * wrapped's error census is unaffected.
 *
 * Explicit strings only, deliberately — a length or shape heuristic here would eat
 * real short messages ("yes, use the raw body"). Counts below are occurrences in the
 * author's index; extend the lists as new banners show up.
 */
const NOISE_EXACT = new Set([
  '[Request interrupted by user]', // ×380
  '[Request interrupted by user for tool use]',
  'No response requested.',
  'Tool loaded.', // ×33
  'Keep up with the conversation and suggest replies', // ×132 — the most frequent of the lot
  // A human could plausibly type this one, which is only safe because the filter runs
  // on read: all 53 stay in grep, they just stop competing for a ranked slot.
  'Continue from where you left off.', // ×53
]);

/** The transport-error banner family: `API Error: 401 …`, `API Error: Rate limit reached`, … */
const NOISE_PREFIXES = ['API Error: '];

/** The denylist as a parenthesized SQL predicate that is true for the rows that ARE
 *  noise. `col` is the qualified text column (e.g. `m.text`). Parenthesized so a caller
 *  can negate it or AND it into a WHERE clause as one term; the mirror of
 *  `notJunkCwdSql` in wrapped/exclude.ts. SQL rather than a JS predicate because the
 *  read path never materializes message text — a broad query matches tens of thousands
 *  of rows and ~37MB of it. Comparisons are case-sensitive (`=`, not LIKE) so they
 *  match the strings exactly as written above. */
export function harnessNoiseSql(col: string): string {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const clauses = [`trim(${col}) IN (${[...NOISE_EXACT].map(quote).join(', ')})`];
  for (const p of NOISE_PREFIXES) clauses.push(`substr(trim(${col}), 1, ${p.length}) = ${quote(p)}`);
  return `(${clauses.join(' OR ')})`;
}

/** The same denylist as a JS predicate, for the write-path caller that has the text in
 *  hand (the `context_text` projection in cache.ts). Trims and compares case-sensitively
 *  so the two call sites agree on exactly which strings are noise. */
export function isHarnessNoise(text: string): boolean {
  const t = text.trim();
  return NOISE_EXACT.has(t) || NOISE_PREFIXES.some((p) => t.startsWith(p));
}

export interface GenuineUserTurn {
  sessionId: string;
  timestamp: string;
  text: string;
}

/**
 * A genuine human turn with its place in time — the boundary marker wrapped's
 * loop metric splits autonomous runs on. Takes an already-parsed JSONL line
 * (the report walkers yield parsed objects, not strings). Beyond the
 * `isGenuineUserTurn` rules this also rejects sidechain lines: a subagent
 * transcript carries the parent sessionId, so its injected task prompt would
 * otherwise read as the human speaking mid-loop.
 */
export function genuineUserTurnFromLine(v: unknown): GenuineUserTurn | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as JsonLine;
  if (d.isSidechain === true || !isUserMessage(d)) return null;
  const { sessionId, timestamp } = d;
  if (!sessionId || !timestamp) return null;
  const text = extractUserText(d).trim();
  if (!text || !isGenuineUserTurn(d, text)) return null;
  return { sessionId, timestamp, text };
}

/** Genuine human user turns, in order, as stripped (not length-clamped) text. */
export function genuineUserTexts(lines: string[], _tool: Tool): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d).trim(); // extractUserText already stripInjected
    if (text && isGenuineUserTurn(d, text)) out.push(text);
  }
  return out;
}

export function firstPrompt(lines: string[], tool: Tool): string {
  const genuine = genuineUserTexts(lines, tool);
  return genuine.length ? clean(genuine[0]!) : '';
}

export function customTitle(lines: string[]): string {
  let title = '';
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (d.type === 'custom-title') {
      title = ((d as Record<string, unknown>).customTitle as string) ?? '';
    }
  }
  return title;
}

export function firstTimestamp(lines: string[]): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    const ts = d.timestamp as string | undefined;
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function messageCount(lines: string[], tool: Tool): number {
  let count = 0;
  for (const line of lines) {
    const d = tryParseJson(line);
    if (d && countsAsMessage(d, tool)) count++;
  }
  return count;
}

/**
 * The last dated line in a transcript. Scans backwards, so the common case (the
 * final line carries a timestamp) still returns on the first iteration.
 *
 * This is the differential oracle for `extractSessionMetadata().date` — the two
 * must agree exactly. An earlier version searched only the last 200 lines and,
 * finding nothing dated there, fell back to the *first* timestamp in the file;
 * that fallback reported a session's date as its start rather than its end, and
 * no real transcript ever reached it (Claude dates every line).
 */
export function lastTimestamp(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = tryParseJson(lines[i]!);
    if (!d) continue;
    const ts = d.timestamp as string | undefined;
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function contentMatches(lines: string[], query: string): boolean {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    if (text.toLowerCase().includes(query)) return true;
  }
  return false;
}

/** A tool invocation the assistant made, reduced to its name and one salient input. */
export interface ToolUse {
  name: string;
  /** One-line, human-readable summary of the salient input (command, path, url, …); '' if none. */
  summary: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  index: number;
  /** Tool calls belonging to this turn (empty for most user turns). See extractMessages. */
  tools: ToolUse[];
}

/** Input fields, most-informative first, used to summarize a tool call for display. */
const TOOL_SUMMARY_KEYS = [
  'command',
  // Codex's exec_command spells it `cmd`; without this the fallback below picks
  // whichever string property happens to come first (workdir, justification, …).
  'cmd',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
  'old_string',
];

/** Reduce a tool_use input object to a single short, human-readable line. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  let val: string | undefined;
  for (const k of TOOL_SUMMARY_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      val = v;
      break;
    }
  }
  if (val === undefined) {
    const firstStr = Object.values(o).find((v) => typeof v === 'string' && v.trim());
    if (typeof firstStr === 'string') val = firstStr;
  }
  if (!val) return '';
  const s = val.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * The tool_use blocks on a single assistant/message line, in order. Recognizes the
 * Claude/Anthropic content-array shape (`{type:'tool_use', name, input}`); returns []
 * for shapes it doesn't model (most pi/codex tool calls), which is a display-only gap.
 */
export function extractToolUses(d: JsonLine): ToolUse[] {
  const msg = d.message;
  if (!msg || typeof msg !== 'object') return [];
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'tool_use') {
      const rec = c as Record<string, unknown>;
      out.push({ name: typeof rec.name === 'string' ? rec.name : '?', summary: summarizeToolInput(rec.input) });
    }
  }
  return out;
}

export function extractAssistantText(d: JsonLine): string {
  if (d.type === 'assistant') {
    const msg = d.message;
    if (typeof msg === 'string') return msg;
    if (!msg || typeof msg !== 'object') return '';
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const c of content) {
        if (typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text') {
          texts.push((c as Record<string, string>).text ?? '');
        }
      }
      return texts.join(' ');
    }
  }
  if (d.type === 'message') {
    const msg = d.message;
    if (typeof msg !== 'object' || msg === null) return '';
    if ((msg as Record<string, unknown>).role !== 'assistant') return '';
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const c of content) {
        if (typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text') {
          texts.push((c as Record<string, string>).text ?? '');
        }
      }
      return texts.join(' ');
    }
  }
  return '';
}

export interface ExtractedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Sequential over ALL non-empty messages — identical to getSessionMessages numbering. */
  index: number;
  /** user turns: isGenuineUserTurn; assistant turns: always true. */
  genuine: boolean;
  /**
   * Tool calls belonging to this turn. A pure-tool-use assistant line carries no text
   * and so gets no index of its own; its calls fold into the current turn's head
   * message here. This keeps numbering dense (array[i].index === i) — the invariant
   * get_session_messages pagination and search-hit offsets both depend on.
   */
  tools: ToolUse[];
}

export interface MessageSummary {
  firstPrompt: string;
  closingUser: string;
  closingAssistant: string;
}

/**
 * The single numbering authority for message extraction. Every non-empty
 * user/assistant message in order, with a sequential index and a `genuine` flag
 * for user turns (injected skill bodies and tool results still consume an index —
 * they are counted, just flagged — so genuineness is metadata, never numbering).
 * Search-hit indices (message_fts) and get_session_messages pagination must agree
 * exactly, so both derive from this function.
 */
export function extractMessages(lines: string[]): ExtractedMessage[] {
  const messages: ExtractedMessage[] = [];
  let idx = 0;
  // The turn's head message — where a following pure-tool-use line's calls attach.
  let current: ExtractedMessage | null = null;
  // Tool calls seen before any message was emitted (rare: a session opening on a tool
  // call). Buffered here and flushed onto the first emitted message.
  let pending: ToolUse[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (isUserMessage(d)) {
      const text = extractUserText(d);
      if (text.trim()) {
        current = { role: 'user', text, index: idx++, genuine: isGenuineUserTurn(d, text.trim()), tools: pending };
        pending = [];
        messages.push(current);
      }
      // A user line with no text is a tool_result/empty turn — it carries no tool_use
      // and must not reset `current` (assistant calls after it still belong to the turn).
    } else {
      const text = extractAssistantText(d);
      const tools = extractToolUses(d);
      if (text.trim()) {
        current = { role: 'assistant', text, index: idx++, genuine: true, tools: pending.concat(tools) };
        pending = [];
        messages.push(current);
      } else if (tools.length) {
        // Pure tool-use turn: no text row (so no index), fold its calls into the head.
        if (current) current.tools.push(...tools);
        else pending.push(...tools);
      }
    }
  }
  return messages;
}

/** Thin projection of extractMessages — same messages, same numbering, no genuine flag. */
export function getSessionMessages(lines: string[]): SessionMessage[] {
  return extractMessages(lines).map(({ role, text, index, tools }) => ({ role, text, index, tools }));
}

/** Max length of each stored closing message (bounds the indexed columns). */
export const CLOSING_MAX = 500;

/**
 * Remove output-style "★ Insight" marker lines and their `──` fence lines while
 * keeping the body text, then collapse the blank runs they leave behind. This is
 * markup cleanup, not outcome detection — the body (often the useful part) stays.
 */
export function stripInsightFences(text: string): string {
  // Match only the literal output-style markup: a `★ Insight` marker line and
  // box-drawing `─` fence lines. Requiring the star and the `─` char (not ASCII
  // `-`) avoids eating a genuine markdown `-----` rule or a bare "Insight" line.
  const kept = text.split('\n').filter((l) => !/^\s*★\s*Insight\s*─*\s*$/.test(l) && !/^\s*─{5,}\s*$/.test(l));
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the prompt/closing columns from an extraction the index already needs
 * for message_fts. Keeping this as a projection avoids three additional full
 * transcript passes in the hot indexing path.
 */
export function summarizeMessages(messages: ExtractedMessage[]): MessageSummary {
  let first = '';
  let lastUser = '';
  let lastAssistant = '';

  for (const message of messages) {
    if (message.role === 'user' && message.genuine) {
      if (!first) first = message.text;
      lastUser = message.text;
    } else if (message.role === 'assistant') {
      lastAssistant = message.text;
    }
  }

  const finish = (text: string): string => {
    const stripped = stripInjected(text).trim();
    return stripped.length > CLOSING_MAX ? stripped.slice(0, CLOSING_MAX) : stripped;
  };

  return {
    firstPrompt: first ? clean(first) : '',
    closingUser: finish(lastUser),
    closingAssistant: finish(stripInsightFences(lastAssistant)),
  };
}

/**
 * Last user message and last assistant message from a session, stripped of
 * injected tags and truncated to CLOSING_MAX. Both roles are returned so the
 * synthesis layer (Phase 2) can decide what the open thread is — the last
 * assistant turn alone is often a question or tool call, not an outcome.
 */
export function closingMessages(lines: string[]): { user: string; assistant: string } {
  const summary = summarizeMessages(extractMessages(lines));
  return { user: summary.closingUser, assistant: summary.closingAssistant };
}

export function findMatchContext(lines: string[], query: string): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    const pos = text.toLowerCase().indexOf(query);
    if (pos >= 0) {
      const start = Math.max(0, pos - 30);
      const end = Math.min(text.length, pos + query.length + 70);
      let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < text.length) snippet = snippet + '…';
      return snippet;
    }
  }
  return '';
}
