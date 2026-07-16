---
name: recall
description: >-
  Recall what was done on a specific project or topic from past AI coding
  sessions. Use when the user says "what did I do on [project]", "recall
  [topic]", "history of [project]", "when did I last work on [thing]" — but
  also when they reference prior work without asking for history explicitly:
  "didn't we already fix this", "what was that approach we tried", "why did
  we do it this way", "what happened to [file/feature]". Use PROACTIVELY
  before re-deriving a decision or re-solving a problem a past session
  likely settled — past conversations hold rationale and dead ends that
  never made it into git.
argument-hint: project name or path
---

Recall past work on a specific project or topic.

## Steps

1. **Classify the question.** Each shape has a cheapest path:
   - **Needle** — "what did we decide about X?" → search, then read just the matched exchange.
   - **Arc** — "where did we leave off on X?" → digest the relevant session(s).
   - **Artifact** — "what happened to this file?" → search with the `files` filter.

2. **Find candidate sessions.** Call `search_sessions`:
   - Needle/arc: `query` = topic keywords; add `project` if a path was given; `limit`: 10.
   - Artifact: `files`: [path or suffix], no `query` — results come back newest first.

   Each result carries `messageHits` — the specific messages that matched (`index`, `role`, `snippet`). The snippets alone often answer a needle question.

3. **Digest the best 1-3 candidates.** Call `get_session_digest` with each candidate's `filePath`. One bounded call (~2k tokens) returns the session's arc: every genuine user turn paired with its exchange's final assistant reply, each with a message `index`. For "where did we leave off", the last exchange of the newest session's digest usually is the answer.

4. **Expand only what you need.** To read around a specific point, call `get_session_messages` with `offset` = a `messageHits[].index` (from search) or `exchanges[].index` (from digest) and a small `limit` (5-10). Never page a transcript from offset 0 when a hit or digest index is available.

5. **Summarize the history.** Write a chronological summary:

   ### Sessions on {project/topic}

   For each relevant session:
   - **{date}** ({tool}) — What was worked on, key decisions made, outcome

   **Overall arc:** How the work evolved across sessions.

## Guidelines

- Budget discipline: digests are bounded, transcripts are not. Prefer one digest over five pages of messages; expand at most the exchanges you need.
- If a digest returns empty `exchanges` (no genuine human turns), fall back to `get_session_messages`.
- Order chronologically (oldest first) to show the arc of work.
- For vague date-range asks ("what was I doing last week?"), use `get_activity_digest` with a date range instead of search.
- Focus on decisions and outcomes, not implementation details.
- If there are many sessions, group by phase or milestone rather than listing each one.
