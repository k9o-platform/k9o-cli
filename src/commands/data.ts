/**
 * `k9o data` subcommands: insert / update / delete one record, over `client.from(collection)`.
 *
 * `--require-approval` asks for the write to wait in the approval queue. The answer is then either the queued change
 * (printed with its id, to decide with `k9o approvals`) or, when an `auto_approve` policy covers the write, the
 * applied record. It is not offered for bulk writes or upserts.
 */

import { isQueuedWrite } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { jsonSourceFlag, usageError } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o data — write single records

USAGE
  k9o data <subcommand> [args...] [flags...]

SUBCOMMANDS
  insert <collection> --data <json|@file|-> [--require-approval]
                                Insert one record ('-' reads the JSON from stdin)
  update <collection> <id> --data <json|@file|-> [--require-approval]
                                Change one record: --data is the patch
  delete <collection> <id> [--require-approval]
                                Delete one record

--require-approval queues the write instead of applying it. The command prints the change id
(apr_...) to decide with \`k9o approvals approve|reject <id>\`. When an auto_approve policy covers
the write it is applied at once and the record is printed. An end user cannot queue a write.
Bulk writes and upserts do not take the flag.

EXAMPLES
  k9o data insert orders --data '{"id":"o-1","total":42}' --require-approval
  k9o data update orders o-1 --data '{"total":50}'
  k9o data delete orders o-1 --require-approval
`.trim() + "\n");
}

export async function dispatchData(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "insert" || sub === "update" || sub === "delete") return await cmdWrite(sub, args);
    return usageError(format, `unknown data subcommand "${sub}"`, "Valid: insert | update | delete");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function cmdWrite(verb: "insert" | "update" | "delete", args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const collection = args.positional[2];
  const withId = verb !== "insert";
  const id = withId ? args.positional[3] : undefined;
  const example = {
    insert: `k9o data insert orders --data '{"total":42}'`,
    update: `k9o data update orders o-1 --data '{"total":50}'`,
    delete: "k9o data delete orders o-1",
  }[verb];
  if (collection === undefined || collection.length === 0) return usageError(format, `k9o data ${verb} requires <collection> (positional)`, example);
  if (withId && (id === undefined || id.length === 0)) return usageError(format, `k9o data ${verb} requires <id> (positional)`, example);

  let record: Record<string, unknown> | undefined;
  if (verb !== "delete") {
    const parsed = jsonSourceFlag(args, "data");
    if (parsed === undefined) return usageError(format, `k9o data ${verb} requires --data <json|@file|->`, example);
    if (typeof parsed === "string") return usageError(format, parsed, example);
    if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return usageError(format, "--data must be a JSON object", example);
    record = parsed.value as Record<string, unknown>;
  } else if (args.flags["data"] !== undefined) {
    return usageError(format, "k9o data delete takes no --data", example);
  }
  const approval = args.flags["require-approval"] === "true";

  const { client } = clientFromProfile(args, { requireProject: true });
  const table = client.from(collection);
  const queuedOrRow = async () => {
    if (verb === "insert") {
      const w = table.insert(record!);
      return approval ? await w.requireApproval() : await w;
    }
    if (verb === "update") {
      const w = table.update(record!).eq("id", id!);
      return approval ? await w.requireApproval() : await w;
    }
    const w = table.delete().eq("id", id!);
    return approval ? await w.requireApproval() : await w;
  };
  const result = await queuedOrRow();
  const past = { insert: "Inserted", update: "Updated", delete: "Deleted" }[verb];
  emitSuccess(format, result, (data) => {
    if (isQueuedWrite(result)) {
      const c = result.data;
      return `Queued for approval: ${c.id} (${c.operation} on ${c.collection}${c.targetRecordId !== null ? `, ${c.targetRecordId}` : ""}).\nNothing was written yet. Decide it with: k9o approvals approve ${c.id} | k9o approvals reject ${c.id} --reason <text>`;
    }
    const rid = (data as { id?: unknown } | null)?.id;
    return `${past}${typeof rid === "string" ? ` ${rid}` : ""} in ${collection}.`;
  });
  return EXIT_SUCCESS;
}
