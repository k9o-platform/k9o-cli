/**
 * `k9o custody status`: how the active project's keys are held, over `client.custody.status()`.
 *
 * Read-only; needs the project-admin or project-auditor role. Changing custody is a Console action.
 */

import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { usageError } from "./json-flag.ts";
import type { CustodyStatus } from "@k9o/core";

function printHelp(): void {
  process.stdout.write(`
k9o custody — how the project's keys are held (read-only)

USAGE
  k9o custody status [--output json]

SUBCOMMANDS
  status                        Show the custody mode, whether an external key source is attached,
                                its provider, the last custody job and, for an HSM, its vendor,
                                cluster and region. Needs the project-admin or project-auditor role.
                                Changing custody is a Console action.

EXAMPLES
  k9o custody status
  k9o custody status --output json
`.trim() + "\n");
}

function describe(s: CustodyStatus): string {
  const lines = [
    `Custody mode: ${s.mode}`,
    `Attached: ${s.attached ? "yes" : "no"}`,
    `Provider: ${s.provider ?? "-"}`,
    `Last job: ${s.lastJob === null ? "-" : `${s.lastJob.kind} ${s.lastJob.status}${s.lastJob.completedAt !== null ? ` (completed ${s.lastJob.completedAt})` : ""}`}`,
  ];
  if (s.hsm !== null) {
    lines.push(
      `HSM vendor: ${s.hsm.vendor ?? "-"}`,
      `HSM cluster: ${s.hsm.clusterId}`,
      `HSM region: ${s.hsm.region}`,
      `HSM attestation: ${s.hsm.attestation.status ?? "-"}${s.hsm.attestation.verifiedAt !== null ? ` (verified ${s.hsm.attestation.verifiedAt})` : ""}`,
    );
  }
  return lines.join("\n");
}

export async function dispatchCustody(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "status") {
      const { client } = clientFromProfile(args, { requireProject: true });
      emitSuccess(format, await client.custody.status(), describe);
      return EXIT_SUCCESS;
    }
    return usageError(format, `unknown custody subcommand "${sub}"`, "Valid: status");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}
