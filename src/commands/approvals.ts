/**
 * `k9o approvals` subcommands: list / get / approve / reject / bulk / comment / comments, over `client.approvals`.
 *
 * `list` pages with `--limit` and `--cursor`; the next cursor is printed as `More: --cursor <c>`.
 * `bulk` takes the selection as a JSON predicate in `--criteria`. The gateway answers 200 even when rows fail, so the
 * command prints the ids it decided and then the rows that failed (id, code, reason): compare them with what you meant
 * to decide.
 * `comment` posts a comment on a pending change (`approvals.comments.add`); the API requires the visibility, so the
 * command requires `--visibility` and never picks one. `comments` lists them, oldest first, with `--limit` and the
 * same `More: --cursor <c>` line as `list`.
 */

import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, jsonObjectFlag, textFlag, usageError } from "./json-flag.ts";
import type { ApprovalComment, PendingChange, PendingChangeStatus } from "@k9o/core";

const VISIBILITIES = ["everyone", "approvers_only"] as const;
const COMMENT_MAX_CHARS = 4000;
const STATUSES = ["pending_approval", "approved", "rejected", "expired", "redeemed"];

function printHelp(): void {
  process.stdout.write(`
k9o approvals — review changes waiting for approval

USAGE
  k9o approvals <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--status <s>] [--limit <1-200>] [--cursor <c>]
                                List pending changes, newest first, one page at a time (default
                                50). When more exist the output ends with "More: --cursor <c>":
                                pass it to --cursor, with the same --status, for the next page.
                                --status is pending_approval, approved, rejected, expired or
                                redeemed. Admins and auditors see every change; other members see
                                only their own.
  get <id>                      Show one change
  approve <id> [--reason <text>]
                                Approve a change. When more approvers are needed the change stays
                                pending_approval: your approval is recorded, it is not applied yet.
  reject <id> --reason <text>   Reject a change (reason required)
  bulk --action approve|reject --criteria '<json>' [--reason <text>]
                                Decide every pending change that matches a predicate. The call
                                succeeds even when rows fail: the failed rows are printed after
                                the decided ids, so compare them with what you intended. --reason
                                is required for reject.
  comment <id> --body <text> --visibility everyone|approvers_only
                                Post a comment on a change (1 to 4000 characters of plain text).
                                --visibility is required and fixed once posted: everyone is read
                                by everyone who can read the change, approvers_only by the people
                                who can decide it. A comment is never a decision; there is no edit
                                or delete. Needs a signed-in session.
  comments <id> [--limit <1-200>] [--cursor <c>]
                                List the comments you may see on a change, oldest first (default
                                50). When more exist the output ends with "More: --cursor <c>".

EXAMPLES
  k9o approvals list --status pending_approval --limit 20
  k9o approvals list --status pending_approval --limit 20 --cursor <cursor-from-More>
  k9o approvals approve apr_123 --reason "checked with finance"
  k9o approvals reject apr_123 --reason "duplicate"
  k9o approvals comment apr_123 --body "Does this match the invoice?" --visibility approvers_only
  k9o approvals comments apr_123 --limit 20
  k9o approvals bulk --action reject --reason stale --criteria '{"eq":["change.table","orders"]}'
`.trim() + "\n");
}

function describe(c: PendingChange): string {
  return [
    `Change ${c.id}`,
    `  status: ${c.status}`,
    `  ${c.operation} on ${c.collection}${c.targetRecordId !== null ? ` (${c.targetRecordId})` : ""}`,
    `  proposed by: ${c.makerId}`,
    `  created: ${c.createdAt}`,
    ...(c.expiresAt !== null ? [`  expires: ${c.expiresAt}`] : []),
    ...(c.approverId !== null ? [`  decided by: ${c.approverId} at ${c.decidedAt ?? "-"}`] : []),
    ...(c.decisionReason !== null ? [`  reason: ${c.decisionReason}`] : []),
  ].join("\n");
}

export async function dispatchApprovals(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "approve") return await cmdApprove(args);
    if (sub === "reject") return await cmdReject(args);
    if (sub === "bulk") return await cmdBulk(args);
    if (sub === "comment") return await cmdComment(args);
    if (sub === "comments") return await cmdComments(args);
    return usageError(format, `unknown approvals subcommand "${sub}"`, "Valid: list | get | approve | reject | bulk | comment | comments");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function idArg(args: ParsedArgs): string | null {
  const id = args.positional[2];
  return id === undefined || id.length === 0 ? null : id;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const status = args.flags["status"];
  if (status !== undefined && !STATUSES.includes(status)) return usageError(format, `invalid --status "${status}"`, `Use one of: ${STATUSES.join(", ")}`);
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return usageError(format, limit);
  if (args.flags["cursor"] === "true" || args.flags["cursor"] === "") return usageError(format, "--cursor needs a value");
  const cursor = args.flags["cursor"];
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.list({
    ...(status !== undefined ? { status: status as PendingChangeStatus } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No pending changes.";
    const lines = rows.map((c) => `  ${c.id.padEnd(24)}  ${c.status.padEnd(16)}  ${c.operation.padEnd(6)}  ${c.collection.padEnd(24)}  ${c.makerId}  ${c.createdAt}`);
    return ["Pending changes:", ...lines, ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals get requires <id> (positional)", "k9o approvals get apr_123");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvals.get(id), describe);
  return EXIT_SUCCESS;
}

async function cmdApprove(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals approve requires <id> (positional)", "k9o approvals approve apr_123 --reason ok");
  if (args.flags["reason"] === "true") return usageError(format, "--reason needs a value");
  const reason = textFlag(args, "reason");
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.approve(id, reason === undefined ? {} : { reason });
  emitSuccess(format, envelope, (c) =>
    c.status === "pending_approval"
      ? `Approval recorded, but more approvers are needed: the change is still pending.\n${describe(c)}`
      : `Approved. ${describe(c)}`);
  return EXIT_SUCCESS;
}

async function cmdReject(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  const example = "k9o approvals reject apr_123 --reason duplicate";
  if (id === null) return usageError(format, "k9o approvals reject requires <id> (positional)", example);
  const reason = textFlag(args, "reason");
  if (reason === undefined || reason.trim().length === 0) return usageError(format, "k9o approvals reject requires --reason <text>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvals.reject(id, { reason }), (c) => `Rejected. ${describe(c)}`);
  return EXIT_SUCCESS;
}

async function cmdBulk(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o approvals bulk --action reject --reason stale --criteria '{"eq":["change.table","orders"]}'`;
  const action = args.flags["action"];
  if (action !== "approve" && action !== "reject") return usageError(format, "k9o approvals bulk requires --action approve|reject", example);
  const criteria = jsonObjectFlag(args, "criteria");
  if (criteria === undefined) return usageError(format, "k9o approvals bulk requires --criteria '<json>'", example);
  if (typeof criteria === "string") return usageError(format, criteria, example);
  const reason = textFlag(args, "reason");
  if (args.flags["reason"] === "true") return usageError(format, "--reason needs a value");
  if (action === "reject" && (reason === undefined || reason.trim().length === 0)) return usageError(format, "bulk reject requires --reason <text>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.bulk({ action, criteria, ...(reason !== undefined ? { reason } : {}) });
  emitSuccess(format, envelope, (r) => {
    const verb = r.action === "approve" ? "Approved" : "Rejected";
    return [
      `${verb} ${r.affectedCount} change${r.affectedCount === 1 ? "" : "s"} (batch ${r.attestationId}).`,
      ...r.affectedIds.map((i) => `  ${i}`),
      ...(r.failed.length > 0
        ? [`${r.failed.length} change${r.failed.length === 1 ? "" : "s"} failed and ${r.failed.length === 1 ? "was" : "were"} not decided:`, ...r.failed.map((f) => `  ${f.id}  ${f.code}  ${f.reason}`)]
        : []),
      "The call succeeds even when rows fail: compare the ids above with what you intended.",
    ].join("\n");
  });
  return EXIT_SUCCESS;
}

/** A comment body is text from another person: drop terminal control characters, keep newlines and tabs. */
function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function describeComment(c: ApprovalComment): string {
  const body = safeText(c.body).split("\n").map((l) => `    ${l}`).join("\n");
  return `  ${c.id}  ${c.createdAt}  ${c.authorId}  ${c.visibility}\n${body}`;
}

async function cmdComment(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = 'k9o approvals comment apr_123 --body "Does this match the invoice?" --visibility everyone';
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals comment requires <id> (positional)", example);
  const body = textFlag(args, "body");
  if (body === undefined) return usageError(format, "k9o approvals comment requires --body <text>", example);
  if (body.length === 0 || Array.from(body).length > COMMENT_MAX_CHARS) return usageError(format, `--body must be 1 to ${COMMENT_MAX_CHARS} characters`, example);
  const visibility = args.flags["visibility"];
  if (visibility === undefined) return usageError(format, "k9o approvals comment requires --visibility everyone|approvers_only", example);
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) return usageError(format, `invalid --visibility "${visibility}"`, `Use one of: ${VISIBILITIES.join(", ")}`);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.comments.add(id, { body, visibility: visibility as (typeof VISIBILITIES)[number] });
  emitSuccess(format, envelope, (c) => `Comment posted on ${c.caseId}.\n${describeComment(c)}`);
  return EXIT_SUCCESS;
}

async function cmdComments(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals comments requires <id> (positional)", "k9o approvals comments apr_123");
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return usageError(format, limit);
  if (args.flags["cursor"] === "true" || args.flags["cursor"] === "") return usageError(format, "--cursor needs a value");
  const cursor = args.flags["cursor"];
  const { client } = clientFromProfile(args, { requireProject: true });
  const page = await client.approvals.comments.list(id, {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  emitSuccess(format, page, (rows) => {
    if (rows.length === 0) return "No comments.";
    return ["Comments:", ...rows.map(describeComment), ...(page.nextCursor !== null ? [`More: --cursor ${page.nextCursor}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}
