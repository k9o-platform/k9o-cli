/**
 * `k9o function trigger` subcommands: list / create / update / delete, over `client.functions.triggers`.
 *
 * An event trigger runs a function when a record is inserted, updated, deleted or upserted in a collection.
 * For triggers on a timetable use `k9o schedule`.
 */

import type { FunctionTrigger, TriggerEvent, UpdateTriggerInput } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { jsonSourceFlag, listFlag, switchPair, usageError } from "./json-flag.ts";

const EVENTS = ["insert", "update", "delete", "upsert"];

export function printTriggerHelp(): void {
  process.stdout.write(`
k9o function trigger — run a function when records change

USAGE
  k9o function trigger <subcommand> <function> [args...] [flags...]

SUBCOMMANDS
  list <function>               List the function's triggers, newest first
  create <function> --collection <name> --events <e1,e2,...> [--filter <json|@file|->]
         [--disabled] [--log-ok-invocations]
                                Create an event trigger. --events is 1 to 4 of insert, update,
                                delete, upsert. Without --filter it fires on every matching event.
  update <function> <trigger-id> [--events <list>] [--filter <json> | --clear-filter]
         [--enable | --disable] [--log-ok-invocations | --no-log-ok-invocations]
                                Change a trigger (at least one flag). The collection is fixed.
  delete <function> <trigger-id>
                                Delete a trigger. Deleting twice is an error.

All of these need the project admin role. For timetables see \`k9o schedule\`.

EXAMPLES
  k9o function trigger create notify --collection orders --events insert,update
  k9o function trigger update notify 0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11 --disable
  k9o function trigger delete notify 0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11
`.trim() + "\n");
}

export async function dispatchFunctionTrigger(args: ParsedArgs): Promise<number> {
  const action = args.positional[2];
  const format = resolveOutputFormat(args.flags);
  if (action === undefined || args.flags["help"] === "true") {
    printTriggerHelp();
    return action === undefined && args.flags["help"] !== "true" ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (action === "list") return await cmdList(args);
    if (action === "create") return await cmdCreate(args);
    if (action === "update") return await cmdUpdate(args);
    if (action === "delete") return await cmdDelete(args);
    return usageError(format, `unknown function trigger subcommand "${action}"`, "Valid: list | create | update | delete");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function describe(t: FunctionTrigger): string {
  return `${t.id}  ${t.enabled ? "enabled " : "disabled"}  ${(t.collection ?? "-").padEnd(24)}  ${t.events.join(",")}${t.filter !== null ? `  filter=${JSON.stringify(t.filter)}` : ""}`;
}

function fnArg(args: ParsedArgs, action: string, example: string): string | number {
  const fn = args.positional[3];
  if (fn === undefined || fn.length === 0) return usageError(resolveOutputFormat(args.flags), `k9o function trigger ${action} requires <function> (positional)`, example);
  return fn;
}

function eventsFlag(args: ParsedArgs): TriggerEvent[] | undefined | string {
  const list = listFlag(args, "events");
  if (list === undefined || typeof list === "string") return list;
  if (list.length < 1 || list.length > 4 || list.some((e) => !EVENTS.includes(e))) return `--events must list 1 to 4 of: ${EVENTS.join(", ")}`;
  return list as TriggerEvent[];
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const fn = fnArg(args, "list", "k9o function trigger list notify");
  if (typeof fn === "number") return fn;
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.functions.triggers.list(fn), (rows) =>
    rows.length === 0 ? `No triggers on ${fn}.` : [`Triggers on ${fn}:`, ...rows.map((t) => `  ${describe(t)}`)].join("\n"));
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o function trigger create notify --collection orders --events insert,update";
  const fn = fnArg(args, "create", example);
  if (typeof fn === "number") return fn;
  const collection = args.flags["collection"];
  if (collection === undefined || collection === "true") return usageError(format, "k9o function trigger create requires --collection <name>", example);
  const events = eventsFlag(args);
  if (events === undefined) return usageError(format, "k9o function trigger create requires --events <e1,e2,...>", example);
  if (typeof events === "string") return usageError(format, events, example);
  const filter = jsonSourceFlag(args, "filter");
  if (typeof filter === "string") return usageError(format, filter);
  if (filter !== undefined && (filter.value === null || typeof filter.value !== "object" || Array.isArray(filter.value))) return usageError(format, "--filter must be a JSON object");
  const log = switchPair(args, "log-ok-invocations", "no-log-ok-invocations");
  if (typeof log === "string") return usageError(format, log);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.functions.triggers.create(fn, {
    collection,
    events,
    ...(filter !== undefined ? { filter: filter.value as Record<string, unknown> } : {}),
    ...(args.flags["disabled"] === "true" ? { enabled: false } : {}),
    ...(log !== undefined ? { logOkInvocations: log } : {}),
  });
  emitSuccess(format, envelope, (t) => `Created trigger on ${fn}:\n  ${describe(t)}`);
  return EXIT_SUCCESS;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o function trigger update notify <trigger-id> --disable";
  const fn = fnArg(args, "update", example);
  if (typeof fn === "number") return fn;
  const id = args.positional[4];
  if (id === undefined || id.length === 0) return usageError(format, "k9o function trigger update requires <trigger-id> (positional)", example);
  const patch: UpdateTriggerInput = {};
  const events = eventsFlag(args);
  if (typeof events === "string") return usageError(format, events, example);
  if (events !== undefined) patch.events = events;
  const filter = jsonSourceFlag(args, "filter");
  if (typeof filter === "string") return usageError(format, filter);
  if (filter !== undefined && args.flags["clear-filter"] === "true") return usageError(format, "use only one of --filter and --clear-filter");
  if (filter !== undefined) {
    if (filter.value === null || typeof filter.value !== "object" || Array.isArray(filter.value)) return usageError(format, "--filter must be a JSON object");
    patch.filter = filter.value as Record<string, unknown>;
  } else if (args.flags["clear-filter"] === "true") {
    patch.filter = null;
  }
  const enable = args.flags["enable"] === "true";
  const disable = args.flags["disable"] === "true";
  if (enable && disable) return usageError(format, "use only one of --enable and --disable");
  if (enable || disable) patch.enabled = enable;
  const log = switchPair(args, "log-ok-invocations", "no-log-ok-invocations");
  if (typeof log === "string") return usageError(format, log);
  if (log !== undefined) patch.logOkInvocations = log;
  if (Object.keys(patch).length === 0) {
    return usageError(format, "k9o function trigger update needs at least one of --events, --filter, --clear-filter, --enable, --disable, --log-ok-invocations, --no-log-ok-invocations", example);
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.functions.triggers.update(fn, id, patch), (t) => `Updated trigger on ${fn}:\n  ${describe(t)}`);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o function trigger delete notify <trigger-id>";
  const fn = fnArg(args, "delete", example);
  if (typeof fn === "number") return fn;
  const id = args.positional[4];
  if (id === undefined || id.length === 0) return usageError(format, "k9o function trigger delete requires <trigger-id> (positional)", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const done = await client.functions.triggers.delete(fn, id);
  emitSuccess(format, { data: null, meta: done.meta }, () => `Deleted trigger ${id} from ${fn}.`);
  return EXIT_SUCCESS;
}
