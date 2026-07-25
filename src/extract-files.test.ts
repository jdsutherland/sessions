import { describe, test, expect } from 'bun:test';
import { extractFiles, extractFilesRead, MAX_FILES } from './extract-files';
import { parseSession } from './record';
import type { Tool } from './types';

function jsonl(...objs: Record<string, unknown>[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

// The indexer parses each session once and hands the record to the extractors; these
// wrappers do the same so a test never sees a record that disagrees with its lines.
const filesOf = (lines: string[], tool: Tool): string[] => extractFiles(lines, tool, parseSession(lines, tool));
const readsOf = (lines: string[], tool: Tool): string[] => extractFilesRead(lines, tool, parseSession(lines, tool));

function claudeToolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}

describe('extractFiles — claude', () => {
  test('returns [] for a session with no edits', () => {
    const lines = jsonl(
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    );
    expect(filesOf(lines, 'claude')).toEqual([]);
  });

  test('collects Edit/Write/MultiEdit paths, deduped and in first-seen order', () => {
    const lines = jsonl(
      claudeToolUse('Edit', { file_path: '/repo/a.ts' }),
      claudeToolUse('Write', { file_path: '/repo/b.ts' }),
      claudeToolUse('MultiEdit', { file_path: '/repo/c.ts' }),
      claudeToolUse('Edit', { file_path: '/repo/a.ts' }), // duplicate
    );
    expect(filesOf(lines, 'claude')).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  });

  test('reads NotebookEdit from notebook_path', () => {
    const lines = jsonl(claudeToolUse('NotebookEdit', { notebook_path: '/repo/nb.ipynb' }));
    expect(filesOf(lines, 'claude')).toEqual(['/repo/nb.ipynb']);
  });

  test('ignores non-editing tool_use blocks (Read, Bash)', () => {
    const lines = jsonl(claudeToolUse('Read', { file_path: '/repo/a.ts' }), claudeToolUse('Bash', { command: 'ls' }));
    expect(filesOf(lines, 'claude')).toEqual([]);
  });

  test('caps the result at MAX_FILES', () => {
    const lines = Array.from({ length: MAX_FILES + 10 }, (_, i) =>
      JSON.stringify(claudeToolUse('Edit', { file_path: `/repo/f${i}.ts` })),
    );
    expect(filesOf(lines, 'claude')).toHaveLength(MAX_FILES);
  });
});

describe('extractFiles — codex', () => {
  // Envelope confirmed against real ~/.codex/sessions logs: a response_item whose
  // payload is a custom_tool_call named apply_patch, with payload.input holding the patch.
  function applyPatch(input: string): Record<string, unknown> {
    return {
      type: 'response_item',
      payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', input },
    };
  }

  test('extracts Add + Update + Delete File paths from a real apply_patch envelope', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /repo/new.ts',
      '+export const x = 1;',
      '*** Update File: /repo/existing.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: /repo/gone.ts',
      '*** End Patch',
    ].join('\n');
    expect(filesOf(jsonl(applyPatch(patch)), 'codex')).toEqual(['/repo/new.ts', '/repo/existing.ts', '/repo/gone.ts']);
  });

  test('dedupes paths touched by multiple patches', () => {
    const p1 = ['*** Begin Patch', '*** Update File: /repo/a.ts', '@@', '+x', '*** End Patch'].join('\n');
    const p2 = ['*** Begin Patch', '*** Update File: /repo/a.ts', '@@', '+y', '*** End Patch'].join('\n');
    expect(filesOf(jsonl(applyPatch(p1), applyPatch(p2)), 'codex')).toEqual(['/repo/a.ts']);
  });

  test('returns [] for a codex session with no patches', () => {
    const lines = jsonl({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } });
    expect(filesOf(lines, 'codex')).toEqual([]);
  });
});

describe('extractFiles — opencode', () => {
  function ocAssistant(...content: Record<string, unknown>[]): Record<string, unknown> {
    return { type: 'message', message: { role: 'assistant', content } };
  }
  function tool(name: string, input: Record<string, unknown>): Record<string, unknown> {
    return { type: 'tool', tool: name, state: { status: 'completed', input } };
  }

  test('collects edit/write filePaths and patch file lists, deduped', () => {
    const lines = jsonl(
      ocAssistant(
        tool('edit', { filePath: '/repo/a.ts' }),
        tool('write', { filePath: '/repo/b.ts' }),
        { type: 'patch', files: ['/repo/a.ts', '/repo/c.ts'] }, // a.ts is a duplicate
      ),
    );
    expect(filesOf(lines, 'opencode')).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  });

  test('parses apply_patch headers like codex', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: /repo/new.ts',
      '+export const x = 1;',
      '*** Update File: /repo/existing.ts',
      '*** End Patch',
    ].join('\n');
    expect(filesOf(jsonl(ocAssistant(tool('apply_patch', { patchText }))), 'opencode')).toEqual([
      '/repo/new.ts',
      '/repo/existing.ts',
    ]);
  });

  test('read targets: read filePath, grep/glob path or pattern (not edited files)', () => {
    const lines = jsonl(
      ocAssistant(
        tool('read', { filePath: '/repo/read.ts' }),
        tool('grep', { pattern: 'foo', path: '/repo/src' }),
        tool('glob', { pattern: 'packages/**/x*' }),
        tool('edit', { filePath: '/repo/edited.ts' }),
      ),
    );
    expect(readsOf(lines, 'opencode')).toEqual(['/repo/read.ts', '/repo/src', 'packages/**/x*']);
    expect(filesOf(lines, 'opencode')).toEqual(['/repo/edited.ts']);
  });
});

describe('extractFiles — pi', () => {
  const piToolCall = (name: string, args: Record<string, unknown>): Record<string, unknown> => ({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: `call_${name}`, name, arguments: args }] },
  });

  test('returns [] for a session with no edits', () => {
    const lines = jsonl(
      { type: 'session', cwd: '/repo' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    );
    expect(filesOf(lines, 'pi')).toEqual([]);
  });

  // `path`, not `file_path` and not `filePath` — the key real Pi logs use.
  test('reads edit and write tool calls, keyed on arguments.path', () => {
    const lines = jsonl(
      { type: 'session', cwd: '/repo' },
      piToolCall('edit', { path: 'src/cache.ts', oldText: 'a', newText: 'b' }),
      piToolCall('write', { path: 'src/new.ts', content: 'x' }),
      piToolCall('read', { path: 'src/untouched.ts' }),
      piToolCall('bash', { command: 'ls' }),
    );
    expect(filesOf(lines, 'pi')).toEqual(['src/cache.ts', 'src/new.ts']);
    expect(readsOf(lines, 'pi')).toEqual(['src/untouched.ts']);
  });
});

test('read: claude Read/Grep targets, separate from edited files', () => {
  const j = (o: unknown): string => JSON.stringify(o);
  const lines = [
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/cache.ts' } }],
      },
    }),
    j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/parser.ts' } }],
      },
    }),
  ];
  expect(readsOf(lines, 'claude')).toEqual(['/repo/src/cache.ts']);
  expect(filesOf(lines, 'claude')).toEqual(['/repo/src/parser.ts']);
});
