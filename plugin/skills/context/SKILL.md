---
name: context
description: >-
  Load a context primer for the current repo before starting work. Use when the
  user says "what was I doing here", "catch me up on this repo", "context primer",
  "what's the open thread", or when resuming work on a codebase after a break.
argument-hint: optional repo path
---

Synthesize a prose context primer from past sessions on this repo.

## Steps

1. **Fetch the primer.** Call the `get_context_primer` MCP tool (pass `cwd` if a path was given).
2. **Synthesize, don't dump.** From the JSON, write: prior decisions, what was tried/abandoned, and the current open thread.
3. **Anchor the open thread** on the most-recent session's `closing` — `closing.user` is the last thing you actually typed and `closing.assistant` is the assistant's last substantive reply (outcomes like "PR is up: …" survive); `branch` is the branch you left off on.
4. **Drill into a session worth expanding.** If one primer session needs more than its opening/closing (an ambiguous open thread, a decision you need the details of), get its full arc from `get_session_digest`: resolve the session's `filePath` via `search_sessions` (a distinctive phrase from its `intent` plus the repo as `project`), then digest that path. Expand a specific exchange with `get_session_messages(offset: exchanges[].index)` — don't page from 0.
5. **Keep it tight** — a short brief the user can act on, not a transcript.

## Guidelines

- Prefer the most recent + most-edited files as the likely active surface.
- If the primer is empty, say so plainly; don't invent history.
