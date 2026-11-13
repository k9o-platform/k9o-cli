/**
 * `k9o metadata` subcommands: filter / set / search / nearest / index get|declare, over `client.metadata`.
 *
 * Metadata columns are declared on a collection first (`index declare`); `set` writes declared columns only, and
 * `filter`, `search` and `nearest` read declared columns only. Column names in --where, --field and --column are sent as
 * `metadata.<name>`; the prefix is added when you leave it out.
 */

import type { MetadataIndexColumn, MetadataMetric, MetadataRow, MetadataWhere } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, jsonInput, jsonSourceFlag, listFlag, textFlag, usageError } from "./json-flag.ts";

const METRICS = ["cosine", "euclidean", "dot"];

function printHelp(): void {
  process.stdout.write(`
k9o metadata — filter, search and follow the columns you declared on a collection

USAGE
  k9o metadata <subcommand> [args...] [flags...]

Declare the columns first with \`index declare\`; \`set\` writes declared columns only, and the other
commands read declared columns only. A surface is collection:<name>, telemetry:<event-prefix> or
storage:<bucket> (a storage surface answers 501 K9O_NOT_IMPLEMENTED). Column names are sent as
metadata.<name>; the prefix is added when you leave it out.

SUBCOMMANDS
  filter --surface <s1[,s2,...]> [--where '<json array>'] [--limit <1-1000>] [--cursor <c>]
                                Rows whose declared columns meet --where, a JSON array of
                                { field, op, value }. ops: eq neq gt gte lt lte contains startsWith
                                endsWith in notIn. --cursor needs exactly one surface; when more
                                rows exist the output ends with "More: --cursor <c>".
  set <collection> <id> --set '<json object>'
                                Write declared columns of one record. --set takes JSON inline,
                                @file, or - for stdin. Prints the updated record.
  search --surface <collection:name> --field <column> --q <text> [--limit <1-1000>]
                                Full-text search of a declared text column (word stems; first page only).
  nearest --surface <collection:name> --column <column> --embedding '<json array>' | --embedding-file <path|->
          [--k <1-1000>] [--metric cosine|euclidean|dot] [--where '<json array>']
                                The rows nearest to the embedding, closest first (no score).
  index get <collection>        The columns declared on a collection.
  index declare <collection> --columns '<json array>'
                                Declare columns, replacing the previous declaration. --columns is a
                                JSON array of { column, indexed? } (at most 64; [] clears it). The
                                columns must already exist. Needs the project admin role.

EXAMPLES
  k9o metadata index declare posts --columns '[{"column":"title"},{"column":"body"},{"column":"priority"}]'
  k9o metadata set posts p1 --set '{"title":"Quarterly report","priority":3}'
  k9o metadata filter --surface collection:posts --where '[{"field":"priority","op":"gte","value":2}]'
  k9o metadata search --surface collection:posts --field body --q finance
  k9o metadata nearest --surface collection:posts --column embedding --embedding '[1,0,0]' --k 3
`.trim() + "\n");
}

export async function dispatchMetadata(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "filter") return await cmdFilter(args);
    if (sub === "set") return await cmdSet(args);
    if (sub === "search") return await cmdSearch(args);
    if (sub === "nearest") return await cmdNearest(args);
    if (sub === "index") {
      const action = args.positional[2];
      if (action === "get") return await cmdIndexGet(args);
      if (action === "declare") return await cmdIndexDeclare(args);
      return usageError(format, action === undefined ? "k9o metadata index requires get or declare" : `unknown index subcommand "${action}"`, "Valid: get | declare");
    }
    return usageError(format, `unknown metadata subcommand "${sub}"`, "Valid: filter | set | search | nearest | index");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/** A required text flag: its value, or a usage-error exit code. */
function requiredText(args: ParsedArgs, name: string, example: string): string | number {
  const value = textFlag(args, name);
  if (value === undefined || value.length === 0) return usageError(resolveOutputFormat(args.flags), `k9o metadata ${args.positional[1]} requires --${name} <value>`, example);
  return value;
}

/** An optional JSON array flag (inline, @file or -): undefined when absent, or a usage-error exit code. */
function arrayFlag(args: ParsedArgs, name: string, example: string): unknown[] | undefined | number {
  const parsed = jsonSourceFlag(args, name);
  if (typeof parsed === "string") return usageError(resolveOutputFormat(args.flags), parsed, example);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed.value)) return usageError(resolveOutputFormat(args.flags), `--${name} must be a JSON array`, example);
  return parsed.value;
}

function renderRows(rows: MetadataRow[], next: string | null): string {
  if (rows.length === 0) return "No rows.";
  const lines = rows.map((r) => `  ${r.surface}  ${r.recordId ?? r.eventId ?? ""}  ${JSON.stringify(r.metadata)}`);
  return [...lines, ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
}

async function cmdFilter(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o metadata filter --surface collection:posts --where '[{"field":"priority","op":"gte","value":2}]'`;
  const surfaces = listFlag(args, "surface");
  if (typeof surfaces === "string") return usageError(format, surfaces, example);
  if (surfaces === undefined || surfaces.length === 0) return usageError(format, "k9o metadata filter requires --surface <surface>[,<surface>...]", example);
  const where = arrayFlag(args, "where", example);
  if (typeof where === "number") return where;
  const limit = intFlag(args, "limit", 1, 1000);
  if (typeof limit === "string") return usageError(format, limit);
  if (args.flags["cursor"] === "true") return usageError(format, "--cursor needs a value");
  const cursor = textFlag(args, "cursor");
  const { client } = clientFromProfile(args, { requireProject: true });
  const page = await client.metadata.filter({
    surfaces,
    ...(where !== undefined ? { where: where as MetadataWhere[] } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  emitSuccess(format, { data: page.data, meta: page.meta }, (rows) => renderRows(rows, page.cursor));
  return EXIT_SUCCESS;
}

async function cmdSet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o metadata set posts p1 --set '{"title":"Quarterly report"}'`;
  const collection = args.positional[2];
  const id = args.positional[3];
  if (collection === undefined || id === undefined) return usageError(format, "k9o metadata set requires <collection> and <id> (positional)", example);
  const parsed = jsonSourceFlag(args, "set");
  if (typeof parsed === "string") return usageError(format, parsed, example);
  if (parsed === undefined) return usageError(format, "k9o metadata set requires --set <json object>", example);
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return usageError(format, "--set must be a JSON object", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.metadata.set(collection, id, parsed.value as Record<string, unknown>);
  emitSuccess(format, envelope, (row) => `Updated ${collection}/${id}: ${JSON.stringify(row)}`);
  return EXIT_SUCCESS;
}

async function cmdSearch(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o metadata search --surface collection:posts --field body --q finance`;
  const surface = requiredText(args, "surface", example);
  if (typeof surface === "number") return surface;
  const field = requiredText(args, "field", example);
  if (typeof field === "number") return field;
  const q = requiredText(args, "q", example);
  if (typeof q === "number") return q;
  const limit = intFlag(args, "limit", 1, 1000);
  if (typeof limit === "string") return usageError(format, limit);
  const { client } = clientFromProfile(args, { requireProject: true });
  const page = await client.metadata.search({ surface, field, q, ...(limit !== undefined ? { limit } : {}) });
  emitSuccess(format, { data: page.data, meta: page.meta }, (rows) => renderRows(rows, page.cursor));
  return EXIT_SUCCESS;
}

async function cmdNearest(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o metadata nearest --surface collection:posts --column embedding --embedding '[1,0,0]'`;
  const surface = requiredText(args, "surface", example);
  if (typeof surface === "number") return surface;
  const column = requiredText(args, "column", example);
  if (typeof column === "number") return column;
  const embedding = jsonInput(args, "embedding", "embedding-file");
  if (typeof embedding === "string") return usageError(format, embedding, example);
  if (embedding === undefined) return usageError(format, "k9o metadata nearest requires --embedding <json array> or --embedding-file <path|->", example);
  if (!Array.isArray(embedding.value)) return usageError(format, "the embedding must be a JSON array of numbers", example);
  const k = intFlag(args, "k", 1, 1000);
  if (typeof k === "string") return usageError(format, k);
  if (args.flags["metric"] === "true") return usageError(format, "--metric needs a value", `Use one of: ${METRICS.join(", ")}`);
  const metric = textFlag(args, "metric");
  if (metric !== undefined && !METRICS.includes(metric)) return usageError(format, `invalid --metric "${metric}"`, `Use one of: ${METRICS.join(", ")}`);
  const where = arrayFlag(args, "where", example);
  if (typeof where === "number") return where;
  const { client } = clientFromProfile(args, { requireProject: true });
  const page = await client.metadata.vectors.nearest({
    surface,
    column,
    embedding: embedding.value as number[],
    ...(k !== undefined ? { k } : {}),
    ...(metric !== undefined ? { metric: metric as MetadataMetric } : {}),
    ...(where !== undefined ? { where: where as MetadataWhere[] } : {}),
  });
  emitSuccess(format, { data: page.data, meta: page.meta }, (rows) => renderRows(rows, null));
  return EXIT_SUCCESS;
}

function renderIndex(d: { collection: string; columns: Array<{ column: string; indexed: boolean }> }): string {
  if (d.columns.length === 0) return `No columns declared on ${d.collection}.`;
  return [`Declared columns on ${d.collection}:`, ...d.columns.map((c) => `  ${c.column}${c.indexed ? "  (indexed)" : ""}`)].join("\n");
}

async function cmdIndexGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const collection = args.positional[3];
  if (collection === undefined) return usageError(format, "k9o metadata index get requires <collection> (positional)", "k9o metadata index get posts");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.metadata.index.get(collection), renderIndex);
  return EXIT_SUCCESS;
}

async function cmdIndexDeclare(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o metadata index declare posts --columns '[{"column":"title"},{"column":"tags","indexed":true}]'`;
  const collection = args.positional[3];
  if (collection === undefined) return usageError(format, "k9o metadata index declare requires <collection> (positional)", example);
  const columns = arrayFlag(args, "columns", example);
  if (typeof columns === "number") return columns;
  if (columns === undefined) return usageError(format, "k9o metadata index declare requires --columns <json array>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.metadata.index.declare(collection, columns as MetadataIndexColumn[]), renderIndex);
  return EXIT_SUCCESS;
}
