/**
 * `k9o keys` subcommands: list / get / rotate, over `client.keys`.
 *
 * Metadata only: no key material is ever shown. Reading needs the project-admin or project-auditor role; rotating
 * needs project-admin, a person's credential and a fresh MFA step-up. Rotation is never retried by the CLI; with
 * `--step-up-proof-cmd` the SDK sends it once more with the proof the user's command produced.
 */

import { KError, stepUpChallengeOf, type StepUpCall, type StepUpChallenge, type StepUpProof, type VaultKey } from "@k9o/core";
import { spawn } from "node:child_process";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { positionalArg, usageError, valueFlag } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o keys — the project's encryption keys (metadata only, never key material)

USAGE
  k9o keys <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--all]                  List the keys (not paged). By default only the active key; --all
                                adds the rotating and revoked versions. Needs the project-admin or
                                project-auditor role and a person's sign-in.
  get <key-id>                  Show one key (vkey_...)
  rotate <key-id> [--step-up-proof-cmd '<command>']
                                Rotate the active key: a new version is created, every data key is
                                re-wrapped under it and the old version is revoked. Writes to the
                                project's encrypted data wait while it runs.
                                Needs project-admin, a person's sign-in and a fresh MFA step-up.
                                Without --step-up-proof-cmd, a required step-up is printed (the
                                challenge too) and the command exits non-zero; complete the step-up,
                                then run it again. With --step-up-proof-cmd your command answers the
                                challenge: it gets the challenge as JSON on stdin and the HTTP method
                                and URL in K9O_STEPUP_METHOD and K9O_STEPUP_URL, and prints
                                {"method":"dpop|mtls|webauthn","proof":"..."} on stdout. The request
                                is then sent once more with the proof; nothing else is retried.
                                At most 3 rotations in 24 hours.

EXAMPLES
  k9o keys list --all
  k9o keys get vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90
  k9o keys rotate vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90
  k9o keys rotate vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90 --step-up-proof-cmd './sign-stepup.sh'
`.trim() + "\n");
}

export async function dispatchKeys(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "rotate") return await cmdRotate(args);
    return usageError(format, `unknown keys subcommand "${sub}"`, "Valid: list | get | rotate");
  } catch (e) {
    if (sub === "rotate" && e instanceof KError && e.code === "K9O_STEP_UP_REQUIRED") return stepUpRequired(format, e, args.positional[2], args.flags["step-up-proof-cmd"] !== undefined);
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/** The step-up requirement, said plainly. The request is not retried. */
function stepUpRequired(format: ReturnType<typeof resolveOutputFormat>, e: KError, keyId: string | undefined, answered: boolean): number {
  if (format === "json" || answered) {
    emitError(format, e);
  } else {
    const challenge = stepUpChallengeOf(e);
    process.stderr.write(
      `[${e.code}] Rotating a key needs a fresh MFA step-up, and none was presented.\n` +
        `  The gateway said: ${e.message}\n` +
        (challenge !== null ? `  Challenge: ${JSON.stringify(challenge)}\n` : "") +
        `→ Complete a step-up with your passkey, then run \`k9o keys rotate ${keyId ?? "<key-id>"}\` again, or pass --step-up-proof-cmd. The CLI does not retry.\n`,
    );
  }
  return exitCodeForError(e);
}

const PROOF_METHODS = new Set(["dpop", "mtls", "webauthn"]);

/**
 * Run the user's command to answer a step-up challenge: the challenge is JSON on stdin, the call is in
 * K9O_STEPUP_METHOD and K9O_STEPUP_URL, and stdout must be `{"method":"dpop|mtls|webauthn","proof":"..."}`.
 * It is stopped when the challenge expires (`maxAgeSec`). The command's stderr is passed through; its stdout (the proof) is never printed or put in an error.
 */
export function runStepUpCommand(cmd: string): (challenge: StepUpChallenge, call: StepUpCall) => Promise<StepUpProof> {
  const fail = (message: string): KError => new KError({ code: "K9O_STEP_UP_PROOF_COMMAND_FAILED", message, context: {}, recommendation: "Check --step-up-proof-cmd: it must print {\"method\":\"dpop|mtls|webauthn\",\"proof\":\"...\"} as JSON on stdout." });
  return (challenge, call) =>
    new Promise<StepUpProof>((resolve, reject) => {
      const timeoutMs = Math.max(1, challenge.maxAgeSec) * 1000;
      const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, K9O_STEPUP_METHOD: call.method, K9O_STEPUP_URL: call.url } });
      const out: Buffer[] = [];
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill("SIGKILL");
        reject(fail(`the step-up proof command did not finish within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      child.stdin.on("error", () => undefined);
      child.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(fail(`could not run the step-up proof command: ${err.message}`));
      });
      child.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code !== 0) return reject(fail(`the step-up proof command exited with status ${code}`));
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
        } catch {
          return reject(fail("the step-up proof command did not print JSON on stdout"));
        }
        const o = parsed as Record<string, unknown> | null;
        if (typeof o !== "object" || o === null || typeof o["method"] !== "string" || !PROOF_METHODS.has(o["method"]) || typeof o["proof"] !== "string" || o["proof"].length === 0) {
          return reject(fail('the step-up proof command must print {"method":"dpop|mtls|webauthn","proof":"..."}'));
        }
        resolve({ method: o["method"], proof: o["proof"] });
      });
      child.stdin.end(JSON.stringify(challenge));
    });
}

function describe(k: VaultKey): string {
  const lines = [
    `Key ${k.id}`,
    `  version: ${k.version ?? "-"}  status: ${k.status ?? "-"}  custody: ${k.custodyMode ?? "-"}`,
    `  created: ${k.createdAt ?? "-"}  rotated: ${k.rotatedAt ?? "-"}`,
  ];
  if (k.byokRef !== null) lines.push(`  BYOK: provider ${k.byokRef.provider ?? "-"}  region ${k.byokRef.region ?? "-"}  fingerprint ${k.byokRef.externalKeyFingerprint ?? "-"}`);
  if (k.hyokRef !== null) lines.push(`  HYOK: cluster ${k.hyokRef.clusterName ?? k.hyokRef.clusterId ?? "-"}  fingerprint ${k.hyokRef.externalKeyFingerprint ?? "-"}`);
  return lines.join("\n");
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.keys.list(args.flags["all"] === "true" ? { status: "all" } : {});
  emitSuccess(format, envelope, (r) => {
    if (r.items.length === 0) return "No keys.";
    const lines = r.items.map((k) => `  ${k.id}  v${String(k.version ?? "-").padEnd(4)}  ${String(k.status ?? "-").padEnd(9)}  ${String(k.custodyMode ?? "-").padEnd(20)}  ${k.createdAt ?? "-"}`);
    return ["Keys:", ...lines].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = positionalArg(args, 2);
  if (id === undefined) return usageError(format, "k9o keys get requires <key-id> (positional)", "k9o keys get vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.keys.get(id), describe);
  return EXIT_SUCCESS;
}

async function cmdRotate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = positionalArg(args, 2);
  if (id === undefined) return usageError(format, "k9o keys rotate requires <key-id> (positional)", "k9o keys rotate vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90");
  const cmd = valueFlag(args, "step-up-proof-cmd");
  if (typeof cmd === "object") return usageError(format, cmd.error, "--step-up-proof-cmd './sign-stepup.sh'");
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.keys.rotate(id, cmd !== undefined ? { stepUp: runStepUpCommand(cmd) } : {});
  emitSuccess(format, envelope, (r) => `Rotated ${r.keyId}: version ${r.previousVersion ?? "-"} -> ${r.newVersion ?? "-"} (${r.status ?? "rotated"}).`);
  return EXIT_SUCCESS;
}
