import { type Tool } from './types';
import {
  type ExtractedMessage,
  type JsonLine,
  type ToolUse,
  extractAssistantText,
  extractToolUses,
  extractUserText,
  isGenuineUserTurn,
  isUserMessage,
  summarizeToolInput,
  tryParseJson,
} from './parser';

// The named record. Until now this codebase's normalization unit was `lines: string[]`,
// re-parsed by every consumer, and the closest thing to a normalized message —
// ExtractedMessage — carried no timestamp, no tool results, and no reasoning. Nothing
// named the record, so nobody noticed that the three dispatchers in parser.ts have no
// branch for Codex's {type:'response_item', payload:{…}} envelope: extractMessages
// returns [] for every real rollout, while extract-files/extract-commands DID learn that
// shape, so branch and files populate normally and mask the hole.
//
// A SessionRecord is a superset of Letta's trajectory-v1, and trajectory-v1 is a lossy
// projection of it — never the parse target. Three fields are ours and cannot come from
// theirs: `index` (dense and stable, the msg_index ↔ get_session_messages invariant),
// `genuine` (promptSource / compaction / injection semantics that first_prompt,
// closing_user and the digest all key off), and `usage`.

export type RecordRole = 'user' | 'assistant' | 'reasoning' | 'tool';

export interface RecordToolCall {
  /** Harness call id; '' when the harness emits none (Codex web_search_call). Joins role:'tool'. */
  id: string;
  name: string;
  /** Normalized to a parsed object by the adapter — Codex ships a JSON *string*, Pi an object. */
  args: unknown;
  /** summarizeToolInput(args), precomputed so display and FTS never re-walk args. */
  summary: string;
}

export interface RecordUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic-only 1h cache-creation subset (billed input×2). */
  cacheWrite1h?: number;
  /** Only Pi pre-computes cost. */
  costUSD?: number;
}

export interface SessionRecord {
  role: RecordRole;
  /**
   * Dense 0..n-1 over indexed records only; -1 for every other record, never undefined.
   * -1 is already this codebase's "not a real message" sentinel (cache.ts writes subagent
   * text at msg_index -1 and every reader filters `>= 0`), so reusing it keeps the
   * existing guards correct instead of inventing a second spelling.
   */
  index: number;
  /** ISO-8601, as the harness wrote it; '' on the rare line that carries no timestamp. */
  timestamp: string;
  /** user: already stripped of injected tags. assistant/reasoning/tool: raw. */
  text: string;
  /** user: isGenuineUserTurn semantics. assistant: true. reasoning/tool: false. Required,
   *  because optional-with-undefined produces two spellings that disagree. */
  genuine: boolean;
  /** Calls emitted BY this record. assistant only; [] elsewhere, never undefined. */
  toolCalls: RecordToolCall[];
  /** role==='tool' only: which call this answers. */
  toolCallId?: string;
  /** role==='tool' only. */
  isError?: boolean;
  /** assistant only, and only where the harness attaches usage to the message. Codex
   *  never does — its token_count events carry no message id — and synthesizing one from
   *  the nearest event would produce per-message numbers that cannot reconcile with the
   *  report pipeline's ccusage-matched totals. */
  usage?: RecordUsage;
  /** assistant only. Codex carries this forward from the most recent turn_context. */
  model?: string;
}

/** Whether a record takes a number. The fold below depends on this being the only rule. */
function isIndexed(r: SessionRecord): boolean {
  return (r.role === 'user' || r.role === 'assistant') && r.text.trim() !== '';
}

/**
 * Every record in a transcript, in file order, numbered.
 *
 * An index is assigned to, and only to, user/assistant records with non-empty text.
 * reasoning, tool, and empty-text records get -1. The fold that used to live inside
 * extractMessages — a pure tool-use turn's calls attaching to the head message — moved
 * out of the record and into toMessages: parseSession stays faithful to the log.
 */
export function parseSession(lines: string[], tool: Tool): SessionRecord[] {
  const records =
    tool === 'codex'
      ? parseCodex(lines)
      : tool === 'pi'
        ? parsePi(lines)
        : tool === 'opencode'
          ? parseOpencode(lines)
          : parseClaude(lines);
  let idx = 0;
  for (const r of records) r.index = isIndexed(r) ? idx++ : -1;
  return records;
}

/**
 * Records → the message list the index and get_session_messages have always seen.
 * Byte-identical to extractMessages for Claude and OpenCode; identical in numbering for
 * Pi, which gains the tool calls extractToolUses never modeled (`toolCall` blocks, not
 * `tool_use`); and non-empty for Codex, where extractMessages returns [].
 */
export function toMessages(records: SessionRecord[]): ExtractedMessage[] {
  const messages: ExtractedMessage[] = [];
  // The turn's head message — where a following pure-tool-use record's calls attach.
  let current: ExtractedMessage | null = null;
  // Calls seen before any message was emitted (a session opening on a tool call).
  let pending: ToolUse[] = [];
  for (const r of records) {
    if (r.role === 'reasoning' || r.role === 'tool') continue;
    const tools = r.toolCalls.map((t) => ({ name: t.name, summary: t.summary }));
    if (r.index >= 0) {
      current = { role: r.role, text: r.text, index: r.index, genuine: r.genuine, tools: pending.concat(tools) };
      pending = [];
      messages.push(current);
    } else if (tools.length) {
      if (current) current.tools.push(...tools);
      else pending.push(...tools);
    }
  }
  return messages;
}

// ——— shared record constructors ———

function blank(role: RecordRole, timestamp: string, text: string): SessionRecord {
  return { role, index: -1, timestamp, text, genuine: role === 'assistant', toolCalls: [] };
}

function call(id: string, name: string, args: unknown): RecordToolCall {
  return { id, name, args, summary: summarizeToolInput(args) };
}

/** Content blocks of a `message`-shaped payload, or [] for any other shape. */
function blocksOf(msg: unknown): Record<string, unknown>[] {
  const content = (msg as Record<string, unknown> | undefined)?.['content'];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}

/** Concatenated `text` of the blocks whose type is one of `types`. */
function textOf(blocks: Record<string, unknown>[], ...types: string[]): string {
  return blocks
    .filter((b) => types.includes(b['type'] as string))
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
    .join(' ');
}

// ——— Claude ———

function parseClaude(lines: string[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    const ts = d.timestamp ?? '';
    if (isUserMessage(d)) {
      const text = extractUserText(d);
      if (text.trim()) {
        out.push({
          role: 'user',
          index: -1,
          timestamp: ts,
          text,
          genuine: isGenuineUserTurn(d, text.trim()),
          toolCalls: [],
        });
      }
      // The same line also carries this turn's tool results, which are the
      // highest-signal text in an agentic session and reach the index today only
      // through extract-errors' error-only path.
      for (const b of blocksOf(d.message)) {
        if (b['type'] !== 'tool_result') continue;
        const r = blank('tool', ts, resultText(b['content']));
        r.toolCallId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
        r.isError = b['is_error'] === true;
        out.push(r);
      }
      continue;
    }
    // Thinking blocks are empty on 12,768 of 12,778 real Claude records (the signature
    // is kept, the text is not), so only the rare non-empty one becomes a record.
    for (const b of blocksOf(d.message)) {
      if (b['type'] === 'thinking' && typeof b['thinking'] === 'string' && b['thinking'].trim()) {
        out.push(blank('reasoning', ts, b['thinking']));
      }
    }
    const text = extractAssistantText(d);
    const tools = extractToolUses(d);
    if (!text.trim() && tools.length === 0) continue;
    const msg = d.message as Record<string, unknown> | undefined;
    out.push({
      role: 'assistant',
      index: -1,
      timestamp: ts,
      text,
      genuine: true,
      // extractToolUses drops the call id, which is what makes a result unjoinable to
      // its call today; re-read the blocks to keep it.
      toolCalls: blocksOf(d.message)
        .filter((b) => b['type'] === 'tool_use')
        .map((b) => call(String(b['id'] ?? ''), typeof b['name'] === 'string' ? b['name'] : '?', b['input'])),
      ...usageAndModel(msg),
    });
  }
  return out;
}

/** A tool_result's `content`: a bare string, or blocks with `text`. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      c && typeof c === 'object' && typeof (c as Record<string, unknown>)['text'] === 'string'
        ? ((c as Record<string, string>)['text'] as string)
        : '',
    )
    .join(' ')
    .trim();
}

function usageAndModel(msg: Record<string, unknown> | undefined): { usage?: RecordUsage; model?: string } {
  if (!msg) return {};
  const out: { usage?: RecordUsage; model?: string } = {};
  if (typeof msg['model'] === 'string') out.model = msg['model'];
  const u = msg['usage'] as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const creation = u['cache_creation'] as Record<string, unknown> | undefined;
    out.usage = {
      input: n(u['input_tokens']),
      output: n(u['output_tokens']),
      cacheRead: n(u['cache_read_input_tokens']),
      cacheWrite: n(u['cache_creation_input_tokens']),
      cacheWrite1h: n(creation?.['ephemeral_1h_input_tokens']),
    };
  }
  return out;
}

// ——— Pi ———

function parsePi(lines: string[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || d.type !== 'message') continue;
    const ts = d.timestamp ?? '';
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const blocks = blocksOf(msg);

    if (msg['role'] === 'toolResult') {
      const r = blank('tool', ts, resultText(msg['content']));
      r.toolCallId = typeof msg['toolCallId'] === 'string' ? msg['toolCallId'] : '';
      r.isError = msg['isError'] === true;
      out.push(r);
      continue;
    }
    // Pi's dedicated shell channel: a result with no call to join back to.
    if (msg['role'] === 'bashExecution') {
      const r = blank('tool', ts, typeof msg['output'] === 'string' ? msg['output'] : '');
      r.isError = typeof msg['exitCode'] === 'number' && msg['exitCode'] !== 0;
      out.push(r);
      continue;
    }
    if (msg['role'] === 'user') {
      const text = extractUserText(d);
      if (!text.trim()) continue;
      // Pi needs no promptSource: harness injections are separate line types
      // (custom_message, compaction), never role:'user'. isGenuineUserTurn agrees by
      // falling through to its heuristic, and is called anyway so the rule stays in one place.
      out.push({
        role: 'user',
        index: -1,
        timestamp: ts,
        text,
        genuine: isGenuineUserTurn(d, text.trim()),
        toolCalls: [],
      });
      continue;
    }
    if (msg['role'] !== 'assistant') continue;

    for (const b of blocks) {
      if (b['type'] === 'thinking' && typeof b['thinking'] === 'string' && b['thinking'].trim()) {
        out.push(blank('reasoning', ts, b['thinking']));
      }
    }
    // `toolCall`, not `tool_use` — the difference that made 4,075 Pi tool calls invisible.
    const toolCalls = blocks
      .filter((b) => b['type'] === 'toolCall')
      .map((b) => call(String(b['id'] ?? ''), typeof b['name'] === 'string' ? b['name'] : '?', b['arguments']));
    const text = textOf(blocks, 'text');
    if (!text.trim() && toolCalls.length === 0) continue;
    out.push({
      role: 'assistant',
      index: -1,
      timestamp: ts,
      text,
      genuine: true,
      toolCalls,
      ...piUsageAndModel(msg),
    });
  }
  return out;
}

function piUsageAndModel(msg: Record<string, unknown>): { usage?: RecordUsage; model?: string } {
  const out: { usage?: RecordUsage; model?: string } = {};
  if (typeof msg['model'] === 'string') out.model = msg['model'];
  const u = msg['usage'] as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const cost = u['cost'] as Record<string, unknown> | undefined;
    out.usage = {
      input: n(u['input']),
      output: n(u['output']),
      cacheRead: n(u['cacheRead']),
      cacheWrite: n(u['cacheWrite']),
      costUSD: typeof cost?.['total'] === 'number' ? (cost['total'] as number) : undefined,
    };
  }
  return out;
}

// ——— OpenCode ———

// src/opencode.ts already synthesizes `{type:'message', message:{role, content:[…]}}`
// lines from the SQLite DB, including its skip of messages with no renderable parts —
// which the existing index numbering depends on, so the adapter reads the synthesized
// lines rather than the DB.
function parseOpencode(lines: string[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || d.type !== 'message') continue;
    const ts = d.timestamp ?? '';
    const msg = d.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const blocks = blocksOf(msg);

    if (msg['role'] === 'user') {
      const text = extractUserText(d);
      if (!text.trim()) continue;
      out.push({
        role: 'user',
        index: -1,
        timestamp: ts,
        text,
        genuine: isGenuineUserTurn(d, text.trim()),
        toolCalls: [],
      });
      continue;
    }

    for (const b of blocks) {
      if (b['type'] === 'thinking' && typeof b['thinking'] === 'string' && b['thinking'].trim()) {
        out.push(blank('reasoning', ts, b['thinking']));
      }
    }
    // OpenCode packs the call and its result into one `tool` part, so each yields two
    // records that share a synthetic id — there is no harness call id to join on.
    const toolCalls: RecordToolCall[] = [];
    const results: SessionRecord[] = [];
    for (const b of blocks) {
      if (b['type'] !== 'tool') continue;
      const state = (b['state'] as Record<string, unknown> | undefined) ?? {};
      const id = typeof state['callID'] === 'string' ? state['callID'] : '';
      toolCalls.push(call(id, typeof b['tool'] === 'string' ? b['tool'] : '?', state['input']));
      const r = blank('tool', ts, typeof state['output'] === 'string' ? state['output'] : '');
      r.toolCallId = id;
      r.isError = state['status'] === 'error';
      results.push(r);
    }
    const text = textOf(blocks, 'text');
    if (text.trim() || toolCalls.length > 0) {
      out.push({ role: 'assistant', index: -1, timestamp: ts, text, genuine: true, toolCalls });
    }
    out.push(...results);
  }
  return out;
}

// ——— Codex ———

/**
 * Text that arrives on a user-role line but is not the human speaking. Codex has no
 * promptSource; these prefixes are the shape of every injection observed across 300
 * real rollouts (1,000 user records, 411 of them injections).
 */
const CODEX_INJECTED =
  /^(<environment_context|<user_action|<turn_aborted|<recommended_plugins|<image\b|<skill\b|<user_shell_command|# AGENTS\.md instructions for )/;

/** Codex writes two parallel streams; only these belong to the model-facing history. */
function codexPayload(d: JsonLine, stream: 'response_item' | 'event_msg'): Record<string, unknown> | null {
  if (d.type !== stream) return null;
  const p = d.payload;
  return p && typeof p === 'object' ? p : null;
}

/**
 * Codex, both streams reconciled.
 *
 * `response_item` is the model-facing history and `event_msg` is the UI event log, and
 * they overlap: all 2,311 assistant texts in a 300-session corpus are byte-duplicated
 * by `event_msg agent_message`. So messages come from `response_item` only — reading
 * both would double every Codex assistant turn in message_fts.
 *
 * What `event_msg` alone has: `user_message`, which is Codex's genuineness oracle (the
 * harness echoes what the human actually typed, and nothing it injected), and
 * `agent_reasoning`, the plaintext of reasoning that `response_item` ships encrypted.
 */
function parseCodex(lines: string[]): SessionRecord[] {
  const parsed = lines.map(tryParseJson);

  // Pass 1: the genuineness oracle. The user_message event usually lands AFTER its
  // response_item twin (572 of 589 matched pairs), so this cannot be done in one pass.
  const typed = new Set<string>();
  const userTexts: string[] = [];
  for (const d of parsed) {
    if (!d) continue;
    const ev = codexPayload(d, 'event_msg');
    if (ev?.['type'] === 'user_message' && typeof ev['message'] === 'string') typed.add(ev['message'].trim());
    const ri = codexPayload(d, 'response_item');
    if (ri?.['type'] === 'message' && ri['role'] === 'user') userTexts.push(extractUserText({ message: ri }).trim());
  }
  // Trust the join only when it demonstrably joins. If Codex ever normalizes whitespace
  // differently between the two streams every turn would silently flip to genuine:false
  // and first_prompt would go blank again — indistinguishable from the bug this fixes —
  // so a session whose streams do not meet falls back to the injection prefixes alone.
  const joins = typed.size > 0 && userTexts.some((t) => typed.has(t));

  const out: SessionRecord[] = [];
  const seenReasoning = new Set<string>();
  let model: string | undefined;

  for (const d of parsed) {
    if (!d) continue;
    const ts = d.timestamp ?? '';

    if (d.type === 'turn_context') {
      // Codex attaches the model to the turn, not the message; carry it forward.
      const m = d.payload?.['model'];
      if (typeof m === 'string' && m) model = m;
      continue;
    }

    const ev = codexPayload(d, 'event_msg');
    if (ev) {
      // agent_reasoning is the plaintext of reasoning whose response_item form is
      // encrypted; 117 of 430 duplicate a summary, so dedupe on the text itself.
      if (ev['type'] === 'agent_reasoning' && typeof ev['text'] === 'string' && ev['text'].trim()) {
        if (!seenReasoning.has(ev['text'].trim())) {
          seenReasoning.add(ev['text'].trim());
          out.push(blank('reasoning', ts, ev['text']));
        }
      }
      continue;
    }

    const p = codexPayload(d, 'response_item');
    if (!p) continue;

    switch (p['type']) {
      case 'message': {
        // `developer` is the injected system prompt, not a turn.
        if (p['role'] === 'developer') break;
        if (p['role'] === 'user') {
          const text = extractUserText({ message: p });
          if (!text.trim()) break;
          const genuine = !CODEX_INJECTED.test(text.trim()) && (!joins || typed.has(text.trim()));
          out.push({ role: 'user', index: -1, timestamp: ts, text, genuine, toolCalls: [] });
          break;
        }
        const text = textOf(blocksOf(p), 'output_text', 'text');
        if (!text.trim()) break;
        out.push({ role: 'assistant', index: -1, timestamp: ts, text, genuine: true, toolCalls: [], model });
        break;
      }
      case 'reasoning': {
        // 7,162 of 7,339 reasoning records are encrypted with an empty summary; only
        // the 177 with a summary carry anything readable.
        const summary = Array.isArray(p['summary'])
          ? p['summary']
              .map((s) => (s && typeof s === 'object' ? ((s as Record<string, string>)['text'] ?? '') : ''))
              .join('\n')
          : '';
        if (!summary.trim() || seenReasoning.has(summary.trim())) break;
        seenReasoning.add(summary.trim());
        out.push(blank('reasoning', ts, summary));
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'web_search_call':
      case 'tool_search_call': {
        const r = blank('assistant', ts, '');
        r.model = model;
        r.toolCalls = [codexCall(p)];
        out.push(r);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'tool_search_output': {
        const r = blank('tool', ts, typeof p['output'] === 'string' ? p['output'] : '');
        r.toolCallId = typeof p['call_id'] === 'string' ? p['call_id'] : '';
        out.push(r);
        break;
      }
    }
  }
  return out;
}

/** Codex ships tool arguments three ways: a JSON string, a raw string, and an object. */
function codexCall(p: Record<string, unknown>): RecordToolCall {
  const id = typeof p['call_id'] === 'string' ? p['call_id'] : '';
  const name = typeof p['name'] === 'string' ? p['name'] : (p['type'] as string);
  const raw = p['arguments'] ?? p['input'] ?? p['action'];
  if (typeof raw === 'string') {
    // function_call.arguments is JSON; custom_tool_call.input is the patch/script itself.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return call(id, name, parsed);
    } catch {}
    return call(id, name, { input: raw });
  }
  return call(id, name, raw ?? {});
}
