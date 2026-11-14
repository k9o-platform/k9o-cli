/**
 * Line prompts on stdin, shared by `k9o login` and `k9o init`.
 *
 * One reader serves every prompt in the process. Lines that arrive together (a pipe, a paste) wait in a queue, so a
 * second prompt gets the second line instead of finding the stream already drained. The reader pauses stdin between
 * prompts so it never keeps the process alive. `promptSecret` does not echo what is typed.
 */

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

let muted = false;
const sink = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});

let rl: Interface | undefined;
let closed = false;
const queue: string[] = [];
const waiters: Array<(line: string | null) => void> = [];

function reader(): Interface {
  if (rl !== undefined) return rl;
  rl = createInterface({ input: process.stdin, output: sink, terminal: process.stdin.isTTY === true });
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  return rl;
}

async function nextLine(): Promise<string> {
  const r = reader();
  const queued = queue.shift();
  if (queued !== undefined) return queued;
  if (closed) return "";
  r.resume();
  const line = await new Promise<string | null>((resolve) => waiters.push(resolve));
  if (!closed) r.pause();
  return line ?? "";
}

/** Print `text`, then return the next line typed or piped, trimmed. An ended input answers an empty string. */
export async function promptLine(text: string): Promise<string> {
  process.stdout.write(text);
  return (await nextLine()).trim();
}

/** Like `promptLine`, but a terminal does not echo the answer. */
export async function promptSecret(text: string): Promise<string> {
  process.stdout.write(text);
  const echoOff = process.stdin.isTTY === true;
  muted = echoOff;
  try {
    return (await nextLine()).trim();
  } finally {
    muted = false;
    if (echoOff) process.stdout.write("\n");
  }
}
