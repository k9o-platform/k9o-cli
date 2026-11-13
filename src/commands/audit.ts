/**
 * `k9o audit` subcommands.
 *
 * Wire to `client.audit.*` (GET /@{project}/audit-log). The route filters by
 * event type, actor and time window (after / before) and pages by cursor; it
 * cannot filter by target.
 *
 *   - `tail`   — follows the audit log live, one event per line, until interrupted
 *   - `replay` — one page of events after a known event or a position, from the audit log in order
 *   - `recent` — events from the last N minutes, fetched once
 *   - `query`  — historical events with the filter set
 *   - `export` — writes every matching event to an NDJSON file
 */

import { KError, type AuditEvent, type AuditReplayPage, type AuditTailEvent } from "@k9o/core";
import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat as resolveFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, usageError, valueFlag } from "./json-flag.ts";

function printAuditHelp(): void {
  process.stdout.write(`
k9o audit — query and export project audit events

USAGE
  k9o audit <subcommand> [args...] [flags...]

SUBCOMMANDS
  tail [--type <event type>]... [--json]
                                Follow the audit log live, one event per line, until interrupted
                                (Ctrl-C). Repeat --type (or comma-separate) to keep only those
                                event types. Each event has auditEventId, type, actorType,
                                occurredAt and outcome, plus eventId (the stream frame's id); read
                                the full row with query. Each event prints once. With --json
                                (or --output json) each line is one JSON object. Needs the
                                org-owner, org-admin, project-admin or project-auditor role; an
                                extension cannot tail.
  replay [--after-audit-event-id <evt_...> | --from-sequence <N>] [--limit <1-10000>]
                                Read one page of events in order, after a known event or from a
                                position in the audit log (warden.checkpoint events included).
                                Prints the page: events, nextCursor, hasMore. Page on with
                                --after-audit-event-id set to the last event while hasMore is true.
                                Needs the audit log's access.
  recent                        Events from the last N minutes, fetched once
                                 (--since-minutes, default 5; --limit). Run it again to see newer events.
  query                         Query historical events
                                 --event-type <type>  --actor <actorId>
                                 --after <ISO time>   --before <ISO time>
                                 --limit <1-200>      --cursor <cursor>
  export <file>                 Write all matching events to an NDJSON file
                                 (same filters as query; pages through the results)
`.trim() + "\n");
}

/** `--json` is the short form of `--output json`. */
function resolveOutputFormat(flags: Record<string, string>): OutputFormat {
  return flags["json"] === "true" ? "json" : resolveFormat(flags);
}

export async function dispatchAudit(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printAuditHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "tail") return await cmdAuditTail(args);
    if (sub === "replay") return await cmdAuditReplay(args);
    if (sub === "recent") return await cmdAuditRecent(args);
    if (sub === "query") return await cmdAuditQuery(args);
    if (sub === "export") return await cmdAuditExport(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown audit subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: tail | replay | recent | query | export",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function renderEvent(e: AuditEvent): string {
  return `  ${e.occurredAt}  ${e.type.padEnd(40)}  actor=${e.actorId ?? "-"}  target=${e.targetKind ?? "-"}:${e.targetId ?? "-"}`;
}

function tailLine(format: OutputFormat, e: AuditTailEvent): string {
  if (format === "json") return JSON.stringify(e);
  return `${e.occurredAt}  ${e.type.padEnd(40)}  actor=${e.actorType || "-"}  outcome=${e.outcome || "-"}  ${e.auditEventId}${e.eventId !== undefined ? `  frame=${e.eventId}` : ""}`;
}

async function cmdAuditTail(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const rawTypes = args.flags["type"];
  if (rawTypes === "true") {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--type needs a value", context: {}, recommendation: "e.g. --type data.write.access.insert" }));
    return EXIT_USAGE;
  }
  const types = rawTypes === undefined ? [] : rawTypes.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  for (const t of types) {
    if (t.includes("*") || /\s/.test(t)) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `invalid --type "${t}"`, context: {}, recommendation: "Use an audit event type such as data.write.access.insert (no wildcards)" }));
      return EXIT_USAGE;
    }
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const feed = client.audit.tail({ ...(types.length > 0 ? { types } : {}), signal: stop.signal });
  try {
    for await (const event of feed) process.stdout.write(tailLine(format, event) + "\n");
  } finally {
    feed.close();
    stop.abort();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return EXIT_SUCCESS;
}

async function cmdAuditReplay(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const after = valueFlag(args, "after-audit-event-id");
  if (typeof after === "object") return usageError(format, after.error);
  const seq = valueFlag(args, "from-sequence");
  if (typeof seq === "object") return usageError(format, seq.error);
  if (after === undefined && seq === undefined) {
    return usageError(format, "k9o audit replay needs --after-audit-event-id or --from-sequence", "k9o audit replay --from-sequence 0 --limit 50");
  }
  if (after !== undefined && seq !== undefined) return usageError(format, "use only one of --after-audit-event-id and --from-sequence");
  if (after !== undefined && !/^evt_[0-9A-Za-z]{1,40}$/.test(after)) return usageError(format, "--after-audit-event-id must look like evt_ followed by letters and digits");
  if (seq !== undefined && !/^\d+$/.test(seq)) return usageError(format, "--from-sequence must be a whole number, 0 or more");
  const limit = intFlag(args, "limit", 1, 10_000);
  if (typeof limit === "string") return usageError(format, limit);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.audit.replay({
    ...(after !== undefined ? { afterAuditEventId: after } : {}),
    ...(seq !== undefined ? { fromSequence: seq } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  emitSuccess(format, envelope, (p: AuditReplayPage) => {
    const head = `${p.events.length} event(s), hasMore=${p.hasMore}, nextCursor=${p.nextCursor === null ? "-" : String(p.nextCursor)}`;
    return [head, ...p.events.map((e) => `${e.sequence ?? "-"}  ${tailLine("human", e)}`)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdAuditRecent(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const sinceMinutes = args.flags["since-minutes"] !== undefined ? parseInt(args.flags["since-minutes"]!, 10) : 5;
  const limit = args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : 100;
  const after = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const envelope = await client.audit.query({ after, limit });
  emitSuccess(format, envelope, (events) => {
    if (events.length === 0) return `No audit events in the last ${sinceMinutes} minute(s).`;
    return [`${events.length} event(s) in the last ${sinceMinutes} minute(s):`, ...events.map(renderEvent)].join("\n");
  });
  return EXIT_SUCCESS;
}

type AuditFlags = {
  eventType?: string | undefined; actorId?: string | undefined;
  after?: string | undefined; before?: string | undefined;
  limit?: number | undefined; cursor?: string | undefined;
};

/** Map flags to the route's filters. `--type`, `--since` and `--until` are older spellings of `--event-type`, `--after` and `--before`. */
function parseAuditQueryFlags(args: ParsedArgs): AuditFlags {
  for (const gone of ["target-kind", "target-id"]) {
    if (args.flags[gone] !== undefined) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `--${gone} is not supported: the audit log cannot be filtered by target`,
        context: { flag: gone },
        recommendation: "Filter with --event-type, --actor, --after or --before.",
      });
    }
  }
  return {
    eventType: args.flags["event-type"] ?? args.flags["type"],
    actorId: args.flags["actor"],
    after: args.flags["after"] ?? args.flags["since"],
    before: args.flags["before"] ?? args.flags["until"],
    limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
    cursor: args.flags["cursor"],
  };
}

async function cmdAuditQuery(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.audit.query(parseAuditQueryFlags(args));
  emitSuccess(format, envelope, (events) => {
    if (events.length === 0) return "No matching audit events.";
    return [`${events.length} event(s):`, ...events.map(renderEvent)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdAuditExport(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const outFile = args.flags["out"] ?? args.positional[2];
  if (outFile === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o audit export requires --out <file> (or positional path)",
      context: {},
      recommendation: "k9o audit export events.ndjson --after 2026-01-01T00:00:00Z",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const filters = parseAuditQueryFlags(args);
  // Page through every matching event (the route returns at most 200 a page).
  // --limit, when given, caps the total written.
  const cap = filters.limit;
  const events: AuditEvent[] = [];
  let cursor = filters.cursor;
  for (;;) {
    const pageSize = cap !== undefined ? Math.min(200, cap - events.length) : 200;
    const envelope = await client.audit.query({ ...filters, limit: pageSize, cursor });
    events.push(...envelope.data);
    const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
    if (next === null || envelope.data.length === 0 || (cap !== undefined && events.length >= cap)) break;
    cursor = next;
  }
  // One event per line: NDJSON.
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  writeFileSync(outFile, lines, "utf8");
  emitSuccess(format, {
    data: { file: outFile, count: events.length },
    meta: {},
  }, (d) => `Wrote ${d.count} audit events to ${d.file} (NDJSON format).`);
  return EXIT_SUCCESS;
}
