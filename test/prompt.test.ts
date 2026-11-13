import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const promptModule = fileURLToPath(new URL("../src/prompt.ts", import.meta.url));

async function run(script: string, input: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", "-e", `import { promptLine, promptSecret } from ${JSON.stringify(promptModule)};\n${script}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

describe("prompts", () => {
  test("two prompts read two lines that arrive together", async () => {
    const { out, code } = await run(
      `const a = await promptLine("email: "); const b = await promptSecret("password: "); console.log("\\n" + JSON.stringify([a, b]));`,
      "me@acme.com\nhunter2\n",
    );
    expect(code).toBe(0);
    expect(out).toContain(`["me@acme.com","hunter2"]`);
  });

  test("a third prompt after the input ended answers empty and the process exits", async () => {
    const { out, code } = await run(
      `const a = await promptLine("a: "); const b = await promptLine("b: "); console.log("\\n" + JSON.stringify([a, b]));`,
      "only-one\n",
    );
    expect(code).toBe(0);
    expect(out).toContain(`["only-one",""]`);
  });
});
