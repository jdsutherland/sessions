---
name: context
description: >-
  Load a context primer for the current repo before starting work. Use when the
  user says "what was I doing here", "catch me up on this repo", "context primer",
  "what's the open thread", "where did I/we leave off" — and PROACTIVELY when a
  session opens on work that clearly continues something ("keep going on the
  refactor", "finish the migration") or when resuming a codebase after a break.
  Past sessions carry the open thread, prior decisions, and abandoned approaches
  that code and git history don't show.
argument-hint: optional repo path
---

Synthesize a prose context primer from past sessions on this repo.

## Steps

1. **Fetch the primer.** Call the `get_context_primer` MCP tool (pass `cwd` if a path was given).
2. **Lead with the lessons.** `lessons` are standing conclusions about this repo, not history — state them before the narrative, because they are what changes what you do next. A lesson with `verified: false` cannot be traced to the conversation behind it; `lessonsFlagged > 0` means some contradict each other and are withheld, so report the count instead of guessing which is right. A non-empty `lessonsQuarantined` means the lesson store was corrupt and moved aside — say so plainly and name the file, because an empty lesson list otherwise reads as "nothing was ever saved".
3. **Synthesize, don't dump.** From the JSON, write: prior decisions, what was tried/abandoned, and the current open thread.
4. **Anchor the open thread** on the most-recent session's `closing` — `closing.user` is the last thing you actually typed and `closing.assistant` is the assistant's last substantive reply (outcomes like "PR is up: …" survive); `branch` is the branch you left off on.
5. **Drill into a session worth expanding.** If one primer session needs more than its opening/closing (an ambiguous open thread, a decision you need the details of), get its full arc from `get_session_digest`: resolve the session's `filePath` via `search_sessions` (a distinctive phrase from its `intent` plus the repo as `project`), then digest that path. Expand a specific exchange with `get_session_messages(offset: exchanges[].index)` — don't page from 0.
6. **Keep it tight** — a short brief the user can act on, not a transcript.

## Closing the loop

When work in this repo turns up something the next session would otherwise re-derive — a root cause that took real effort to find, a convention the user corrected you on, an approach that looked right and wasn't — call `remember_lesson` before you finish. One transferable sentence, with the file/root cause/fix in `detail`.

Do not save what the code or git history already states, what you just did, or task status. Those are the entries nobody re-reads, and they are what turns this into a junk drawer.

## Guidelines

- Prefer the most recent + most-edited files as the likely active surface.
- If the primer is empty, say so plainly; don't invent history.
