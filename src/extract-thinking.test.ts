import { test, expect } from 'bun:test';
import { extractThinking } from './extract-thinking';
import { parseSession } from './record';
import type { Tool } from './types';

const j = (o: unknown): string => JSON.stringify(o);
const thinkingOf = (lines: string[], tool: Tool): string => extractThinking(parseSession(lines, tool));

test('claude: collects thinking block text', () => {
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'consider memoization' },
          { type: 'text', text: 'done' },
        ],
      },
    }),
  ];
  expect(thinkingOf(lines, 'claude')).toBe('consider memoization');
});

// 12,768 of 12,778 real Claude thinking blocks look exactly like this: the signature is
// written, the text is not. The old walk joined them into a run of newlines.
test('claude: an empty thinking block contributes nothing, not a blank line', () => {
  const lines = [
    j({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'Er' }] },
    }),
  ];
  expect(thinkingOf(lines, 'claude')).toBe('');
});

test('pi: collects thinking from assistant content', () => {
  const lines = [
    j({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pi reasoning' }] } }),
  ];
  expect(thinkingOf(lines, 'pi')).toBe('pi reasoning');
});

test('codex: encrypted reasoning contributes nothing', () => {
  const lines = [j({ type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'xxxx' } })];
  expect(thinkingOf(lines, 'codex')).toBe('');
});

// The hole this replaced: extract-thinking used to `return ''` for Codex outright, so
// the reasoning Codex *does* write in the clear was never searchable.
test('codex: plaintext summaries and agent_reasoning events are collected once each', () => {
  const lines = [
    j({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Reading the index**' }] },
    }),
    j({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Reading the index**' } }), // the same text, echoed
    j({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Checking the cache**' } }),
  ];
  expect(thinkingOf(lines, 'codex')).toBe('**Reading the index**\n**Checking the cache**');
});
