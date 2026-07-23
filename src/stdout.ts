// Write a large payload to stdout, resolving only once it is fully flushed.
//
// Two constraints shape this helper:
//   - A bare process.stdout.write followed by the CLI's process.exit(0)
//     truncates piped output at the 64KB pipe buffer.
//   - Bun.write(Bun.stdout, …) — the previous fix for that truncation —
//     busy-loops forever (bun 1.3.x) when stdout is a pipe and the payload
//     exceeds the pipe buffer, hanging every programmatic consumer
//     (`sessions report --stdout | …`, Bun.spawn with stdout: 'pipe').
//
// Awaiting the write callback satisfies both: the callback fires only after
// the data is handed to the OS, and the node-compat write path drains pipes
// correctly.
export function writeStdoutFully(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}
