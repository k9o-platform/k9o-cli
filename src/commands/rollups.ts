/**
 * `k9o rollups` subcommands: list / read / subscribe, over `client.rollups`.
 *
 * Rollups are created on a dataset (`k9o analytics rollups create`); these commands read them across the project.
 * `subscribe` follows one rollup live, one closed cell per line, until interrupted or until `--count` cells were printed.
 */

import type { RollupCellEvent } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, positionalArg, usageError, valueFlag } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o rollups — continuous aggregates of your streams

USAGE
  k9o rollups <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List the project's rollups you can read, with their endpoints
  read <slug> [--from <ISO time>] [--to <ISO time>] [--dims a,b]
                                Read the rollup's cells for a time range (default: the last 24
                                hours; at most 50000 cells). A cell below the cohort threshold
                                prints as suppressed. --dims projects onto some dimensions; only
                                count, sum, min and max measures combine.
  subscribe <slug> [--from-sequence N] [--count N]
                                Follow a rollup live, one cell per line (JSON lines with
                                --output json; a cell below the cohort threshold shows its
                                status and reason), until interrupted (Ctrl-C) or --count cells.

Rollups are created and re-attested on a dataset: k9o analytics rollups --help

EXAMPLES
  k9o rollups list
  k9o rollups read hourly-orders --from 2026-10-26T00:00:00Z --dims city
  k9o rollups subscribe hourly-orders --output json
`.trim() + "\n");
}

export async function dispatchRollups(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "read") return await cmdRead(args);
    if (sub === "subscribe") return await cmdSubscribe(args);
    return usageError(format, `unknown rollups subcommand "${sub}"`, "Valid: list | read | subscribe");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function slugArg(args: ParsedArgs, sub: string): string | number {
  const slug = positionalArg(args, 2);
  if (slug === undefined) return usageError(resolveOutputFormat(args.flags), `k9o rollups ${sub} requires <slug> (positional)`, `k9o rollups ${sub} hourly-orders`);
  return slug;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.rollups.list(), (r) => {
    if (r.rollups.length === 0) return "No rollups.";
    return ["Rollups:", ...r.rollups.map((x) => `  ${String(x["slug"] ?? x.id ?? "-").padEnd(28)}  ${String(x.attestationStatus ?? "-").padEnd(13)}  expires ${x.expiresAt ?? "-"}`)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdRead(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "read");
  if (typeof slug === "number") return slug;
  const from = valueFlag(args, "from");
  if (typeof from === "object") return usageError(format, from.error);
  const to = valueFlag(args, "to");
  if (typeof to === "object") return usageError(format, to.error);
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) return usageError(format, `--${name} must be an ISO 8601 time`, `--${name} 2026-10-26T00:00:00Z`);
  }
  const dims = valueFlag(args, "dims");
  if (typeof dims === "object") return usageError(format, dims.error);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.rollups.read(slug, {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(dims !== undefined ? { dims } : {}),
  });
  emitSuccess(format, envelope, (r) => {
    const cells = r.cells ?? [];
    const lines = cells.map((c) => (c.status === "suppressed" ? `suppressed (${c.reason ?? "cohort_below_k"})  ${JSON.stringify(c)}` : JSON.stringify(c)));
    const head = `${cells.length} cell(s)${r.k !== undefined ? `, cohort threshold k=${r.k}` : ""}${r.coverage !== undefined ? `, coverage ${JSON.stringify(r.coverage)}` : ""}`;
    return [head, ...lines].join("\n");
  });
  return EXIT_SUCCESS;
}

/** One cell per line: the payload as JSON; a suppressed cell shows its status and reason up front in the human form. */
function cellLine(format: OutputFormat, ev: RollupCellEvent): string {
  const json = JSON.stringify(ev.payload);
  if (format === "json") return json;
  return ev.suppressed ? `status=${ev.payload.status ?? "suppressed"}  reason=${ev.payload.reason ?? "cohort_below_k"}  ${json}` : json;
}

async function cmdSubscribe(args: ParsedArgs): Promise<number> {
  const format: OutputFormat = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "subscribe");
  if (typeof slug === "number") return slug;
  const fromSeq = intFlag(args, "from-sequence", 0, Number.MAX_SAFE_INTEGER);
  if (typeof fromSeq === "string") return usageError(format, fromSeq);
  const count = intFlag(args, "count", 1, Number.MAX_SAFE_INTEGER);
  if (typeof count === "string") return usageError(format, count);
  const { client } = clientFromProfile(args, { requireProject: true });

  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let printed = 0;
  const feed = client.rollups.subscribe(slug, {
    signal: stop.signal,
    ...(fromSeq !== undefined ? { fromSequence: fromSeq } : {}),
    onResync: () => {
      process.stderr.write(`note: the stream position was lost; cells in between are missing. Re-read them with: k9o rollups read ${slug}\n`);
    },
  });
  try {
    for await (const ev of feed) {
      process.stdout.write(cellLine(format, ev) + "\n");
      printed++;
      if (count !== undefined && printed >= count) break;
    }
  } finally {
    feed.close();
    stop.abort();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return EXIT_SUCCESS;
}
