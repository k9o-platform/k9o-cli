/**
 * `k9o schedule` subcommands: list / get / create / update / delete / runs / run-now, over `client.schedules`.
 *
 * A schedule runs a function on a cron timetable. A schedule interval under 5 minutes is rejected with 400 K9O_INVALID_FIELD_VALUE (field schedule_expression), on every plan.
 */

import type { CatchupPolicy, Schedule, ScheduleRun, ScheduleStatus, UpdateScheduleInput } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, switchPair, textFlag, usageError } from "./json-flag.ts";

const CATCHUP = ["skip", "run_once", "run_all"];

function printHelp(): void {
  process.stdout.write(`
k9o schedule — run functions on a timetable

USAGE
  k9o schedule <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--status active|paused] [--function <name>] [--limit <1-200>] [--cursor <c>]
                                List schedules, newest first. Pages of --limit (default 50); pass
                                the printed cursor to --cursor for the next page.
  get <id>                      Show one schedule
  create --function <name> --cron <expr> [--timezone <tz>] [--catchup skip|run_once|run_all]
         [--collection <name>] [--disabled] [--log-ok-invocations]
                                Create a schedule. --cron is five fields (minute hour day month
                                weekday) or @yearly, @annually, @monthly, @weekly, @daily,
                                @midnight, @hourly (stored expanded). --timezone is UTC (default)
                                or Region/City.
  update <id> [--cron <expr>] [--timezone <tz>] [--catchup <policy>] [--status active|paused]
         [--log-ok-invocations | --no-log-ok-invocations]
                                Change a schedule (at least one flag). The function is fixed.
  delete <id>                   Delete a schedule
  runs <id> [--limit <1-200>] [--cursor <c>]
                                List the schedule's runs, newest first
  run-now <id>                  Start one run now, outside the timetable

LIMITS
  A schedule interval under 5 minutes is rejected with 400 K9O_INVALID_FIELD_VALUE (field schedule_expression), on every plan.

EXAMPLES
  k9o schedule create --function nightly-report --cron "0 2 * * *" --timezone Europe/Berlin
  k9o schedule update 5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01 --status paused
  k9o schedule runs 5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01 --limit 10
`.trim() + "\n");
}

export async function dispatchSchedule(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "create") return await cmdCreate(args);
    if (sub === "update") return await cmdUpdate(args);
    if (sub === "delete") return await cmdDelete(args);
    if (sub === "runs") return await cmdRuns(args);
    if (sub === "run-now") return await cmdRunNow(args);
    return usageError(format, `unknown schedule subcommand "${sub}"`, "Valid: list | get | create | update | delete | runs | run-now");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function describe(s: Schedule): string {
  return [
    `Schedule ${s.id}`,
    `  function: ${s.functionName}${s.collection !== null ? ` (collection ${s.collection})` : ""}`,
    `  cron: ${s.scheduleExpression} ${s.scheduleTimezone}`,
    `  status: ${s.status}  catchup: ${s.catchupPolicy}`,
    `  last run: ${s.lastInvocationAt ?? "-"}  next run: ${s.nextInvocationAt ?? "-"}`,
    `  created: ${s.createdAt}`,
  ].join("\n");
}

function idArg(args: ParsedArgs, sub: string): string | number {
  const id = args.positional[2];
  if (id === undefined || id.length === 0) return usageError(resolveOutputFormat(args.flags), `k9o schedule ${sub} requires <id> (positional)`, `k9o schedule ${sub} 5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01`);
  return id;
}

/** `--name` as a value, or undefined when absent; a bare `--name` is an error message. */
function valueFlag(args: ParsedArgs, name: string): string | undefined | { error: string } {
  if (args.flags[name] === "true") return { error: `--${name} needs a value` };
  return textFlag(args, name);
}

function pageFlags(args: ParsedArgs): { limit?: number; cursor?: string } | string {
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return limit;
  const cursor = valueFlag(args, "cursor");
  if (typeof cursor === "object") return cursor.error;
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const status = args.flags["status"];
  if (status !== undefined && status !== "active" && status !== "paused") return usageError(format, `invalid --status "${status}"`, "Use active or paused");
  const fn = valueFlag(args, "function");
  if (typeof fn === "object") return usageError(format, fn.error);
  const page = pageFlags(args);
  if (typeof page === "string") return usageError(format, page);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.schedules.list({
    ...(status !== undefined ? { status: status as ScheduleStatus } : {}),
    ...(fn !== undefined ? { functionName: fn } : {}),
    ...page,
  });
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No schedules.";
    const lines = rows.map((s) => `  ${s.id}  ${s.status.padEnd(6)}  ${s.functionName.padEnd(24)}  ${s.scheduleExpression} ${s.scheduleTimezone}`);
    return ["Schedules:", ...lines, ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args, "get");
  if (typeof id === "number") return id;
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.schedules.get(id), describe);
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o schedule create --function nightly-report --cron "0 2 * * *"`;
  const fn = valueFlag(args, "function");
  if (typeof fn === "object") return usageError(format, fn.error, example);
  const cron = valueFlag(args, "cron");
  if (typeof cron === "object") return usageError(format, cron.error, example);
  if (fn === undefined) return usageError(format, "k9o schedule create requires --function <name>", example);
  if (cron === undefined) return usageError(format, "k9o schedule create requires --cron <expression>", example);
  const timezone = valueFlag(args, "timezone");
  if (typeof timezone === "object") return usageError(format, timezone.error);
  const catchup = valueFlag(args, "catchup");
  if (typeof catchup === "object") return usageError(format, catchup.error);
  if (catchup !== undefined && !CATCHUP.includes(catchup)) return usageError(format, `invalid --catchup "${catchup}"`, `Use one of: ${CATCHUP.join(", ")}`);
  const collection = valueFlag(args, "collection");
  if (typeof collection === "object") return usageError(format, collection.error);
  const log = switchPair(args, "log-ok-invocations", "no-log-ok-invocations");
  if (typeof log === "string") return usageError(format, log);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.schedules.create({
    functionName: fn,
    scheduleExpression: cron,
    ...(timezone !== undefined ? { scheduleTimezone: timezone } : {}),
    ...(catchup !== undefined ? { catchupPolicy: catchup as CatchupPolicy } : {}),
    ...(collection !== undefined ? { collection } : {}),
    ...(args.flags["disabled"] === "true" ? { enabled: false } : {}),
    ...(log !== undefined ? { logOkInvocations: log } : {}),
  });
  emitSuccess(format, envelope, (s) => `Created. ${describe(s)}`);
  return EXIT_SUCCESS;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args, "update");
  if (typeof id === "number") return id;
  const patch: UpdateScheduleInput = {};
  const cron = valueFlag(args, "cron");
  if (typeof cron === "object") return usageError(format, cron.error);
  if (cron !== undefined) patch.scheduleExpression = cron;
  const timezone = valueFlag(args, "timezone");
  if (typeof timezone === "object") return usageError(format, timezone.error);
  if (timezone !== undefined) patch.scheduleTimezone = timezone;
  const catchup = valueFlag(args, "catchup");
  if (typeof catchup === "object") return usageError(format, catchup.error);
  if (catchup !== undefined) {
    if (!CATCHUP.includes(catchup)) return usageError(format, `invalid --catchup "${catchup}"`, `Use one of: ${CATCHUP.join(", ")}`);
    patch.catchupPolicy = catchup as CatchupPolicy;
  }
  const status = valueFlag(args, "status");
  if (typeof status === "object") return usageError(format, status.error);
  if (status !== undefined) {
    if (status !== "active" && status !== "paused") return usageError(format, `invalid --status "${status}"`, "Use active or paused");
    patch.status = status;
  }
  const log = switchPair(args, "log-ok-invocations", "no-log-ok-invocations");
  if (typeof log === "string") return usageError(format, log);
  if (log !== undefined) patch.logOkInvocations = log;
  if (Object.keys(patch).length === 0) {
    return usageError(format, "k9o schedule update needs at least one of --cron, --timezone, --catchup, --status, --log-ok-invocations, --no-log-ok-invocations", `k9o schedule update ${id} --status paused`);
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.schedules.update(id, patch), (s) => `Updated. ${describe(s)}`);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args, "delete");
  if (typeof id === "number") return id;
  const { client } = clientFromProfile(args, { requireProject: true });
  const done = await client.schedules.delete(id);
  emitSuccess(format, { data: null, meta: done.meta }, () => `Deleted schedule ${id}.`);
  return EXIT_SUCCESS;
}

async function cmdRuns(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args, "runs");
  if (typeof id === "number") return id;
  const page = pageFlags(args);
  if (typeof page === "string") return usageError(format, page);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.schedules.runs(id, page);
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No runs.";
    const lines = rows.map((r: ScheduleRun) => `  ${r.id}  ${r.status.padEnd(10)}  attempts=${r.attemptCount}  ${r.triggeredAt}${r.errorDetail !== null ? `  ${r.errorDetail}` : ""}`);
    return ["Runs:", ...lines, ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdRunNow(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args, "run-now");
  if (typeof id === "number") return id;
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.schedules.runNow(id), () => `Run requested for schedule ${id}. Follow it with: k9o schedule runs ${id}`);
  return EXIT_SUCCESS;
}
