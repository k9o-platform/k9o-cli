/**
 * `k9o analytics` (aliases `dataset`, `datasets`): datasets, their rollups and their schedules, over `client.analytics`.
 *
 * A dataset is a typed, partitioned table you append to and query with SQL. `rollups` folds a stream into a dataset over
 * fixed windows; `schedules` materializes a collection into a dataset on an interval. `reattest` (rollups and schedules)
 * is for people only: a service, workload or extension token is refused with K9O_RBAC_DENY, reason human_only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type {
  CreateDatasetInput, CreateRollupInput, Dataset, DatasetColumn, DatasetUploadOptions, ReattestDays, RollupMeasure,
} from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, jsonObjectFlag, jsonSourceFlag, listFlag, positionalArg, usageError, valueFlag } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o analytics — datasets you append to and query with SQL (aliases: dataset, datasets)

USAGE
  k9o analytics <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List the project's datasets, newest first
  get <slug>                    Show one dataset
  create <slug> --name <display name> --columns <json|@file|-> --residency per-subject|shared
         [--partition-by a,b,...]
                                Create a dataset. --columns is [{"name":"id","type":"string"}, ...];
                                types: string int32 int64 float64 bool date timestamp json bytes
                                decimal(p,s). A timestamp partition key needs a transform: created_at:day.
                                Use per-subject for personal data, shared otherwise.
  delete <slug>                 Retire a dataset (its slug is never reissued)
  query --sql <sql|@file|-> --datasets a,b,...
                                Run a read-only SELECT. Refer to each dataset as dataset.<slug>.
  read <slug> [--partition-filter <json>] [--limit N] [--cursor c]
                                Page through a dataset's rows; prints the cursor for the next page
  materialize <slug> --from-collection <name> | --from-query <saved query id>
                                Copy rows into the dataset from a collection or a saved query
  write <slug> --rows <json> | --rows-file <path|-> [--on-error skip|reject]
                                Append rows: a JSON array, or newline-delimited JSON from a file
  upload <slug> <file> [--format csv|json] [--dry-run] [--on-error skip|reject] [--delimiter c]
         [--encoding e] [--no-header] [--manifest <json|@file>]
                                Load a CSV or JSON file (up to 25 MiB). The format comes from the
                                file extension when --format is absent. --dry-run shows the detected
                                columns and a 50-row preview and writes nothing. --manifest creates
                                the dataset in the same call when the slug does not exist yet.
  download-original <slug> --out <file>
                                Save the original uploaded file
  rollups create <dataset> --slug <s> --source <stream> --measures <json|@file> --window-seconds N
         (--subject-field <f> | --non-personal) [--dimensions a,b] [--reattest-days 7|30|90|365]
  rollups list <dataset>        List the dataset's rollups
  rollups delete <dataset> <rollup-id>
  rollups reattest <dataset> <rollup-id> [--reattest-days 7|30|90|365]
                                Confirm the rollup is still wanted. HUMAN ONLY: a service, workload
                                or extension token is refused (K9O_RBAC_DENY, human_only).
  schedules create <dataset> --from-collection <name> --interval-seconds N [--reattest-days D]
  schedules list <dataset>      List the dataset's schedules with their last and next runs
  schedules delete <dataset> <schedule-id>
  schedules reattest <dataset> <schedule-id> [--reattest-days 7|30|90|365]
                                Confirm the schedule is still wanted and resume it if paused.
                                HUMAN ONLY: a service, workload or extension token is refused.

--measures is [{"name":"orders","agg":"count"},{"name":"total","agg":"sum","column":"amount"}].
Aggregations: count, last, sum, avg, min, max, count_distinct, p50, p95, p99.

EXAMPLES
  k9o analytics create orders --name Orders --residency shared \\
      --columns '[{"name":"city","type":"string"},{"name":"amount","type":"float64"}]'
  k9o analytics write orders --rows '[{"city":"Berlin","amount":42.5}]'
  k9o analytics query --sql 'SELECT city, sum(amount) FROM dataset.orders GROUP BY city' --datasets orders
  k9o analytics upload orders ./orders.csv --dry-run
  k9o analytics download-original orders --out ./orders-original.csv
`.trim() + "\n");
}

export async function dispatchAnalytics(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    switch (sub) {
      case "list": return await cmdList(args);
      case "get": return await cmdGet(args);
      case "create": return await cmdCreate(args);
      case "delete": return await cmdDelete(args);
      case "query": return await cmdQuery(args);
      case "read": return await cmdRead(args);
      case "materialize": return await cmdMaterialize(args);
      case "write": return await cmdWrite(args);
      case "upload": return await cmdUpload(args);
      case "download-original": return await cmdDownload(args);
      case "rollups": return await dispatchRollups(args);
      case "schedules": return await dispatchSchedules(args);
      default:
        return usageError(format, `unknown analytics subcommand "${sub}"`, "Valid: list | get | create | delete | query | read | materialize | write | upload | download-original | rollups | schedules");
    }
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

const SLUG_EXAMPLE = (sub: string) => `k9o analytics ${sub} orders`;

function slugArg(args: ParsedArgs, sub: string, index = 2): string | number {
  const slug = positionalArg(args, index);
  if (slug === undefined) return usageError(resolveOutputFormat(args.flags), `k9o analytics ${sub} requires <slug> (positional)`, SLUG_EXAMPLE(sub));
  return slug;
}

/** Each flag's value, or the first problem as a message. */
function need(args: ParsedArgs, name: string): string | { error: string } {
  const v = valueFlag(args, name);
  if (v === undefined) return { error: `--${name} is required` };
  return v;
}

function describe(d: Dataset): string {
  const cols = (d.schema ?? []).map((c) => `${c.name}:${c.type}`).join(", ");
  return [
    `Dataset ${d.slug}${d.displayName !== undefined ? ` (${d.displayName})` : ""}`,
    `  residency: ${d.residencyClass ?? "-"}  storage: ${d.storageTarget?.kind ?? "-"}`,
    `  partitions: ${(d.partitionKeys ?? []).join(", ") || "-"}`,
    `  columns: ${cols || "-"}`,
    `  created: ${d.createdAt ?? "-"}`,
  ].join("\n");
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.list(), (rows) => {
    if (rows.length === 0) return "No datasets.";
    return ["Datasets:", ...rows.map((d) => `  ${d.slug.padEnd(28)}  ${String(d.residencyClass ?? "-").padEnd(11)}  ${d.displayName ?? ""}`)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "get");
  if (typeof slug === "number") return slug;
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.get(slug), describe);
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o analytics create orders --name Orders --residency shared --columns '[{"name":"city","type":"string"}]'`;
  const slug = slugArg(args, "create");
  if (typeof slug === "number") return slug;
  const name = need(args, "name");
  if (typeof name === "object") return usageError(format, name.error, example);
  const residency = need(args, "residency");
  if (typeof residency === "object") return usageError(format, residency.error, example);
  if (residency !== "per-subject" && residency !== "shared") return usageError(format, `invalid --residency "${residency}"`, "Use per-subject or shared");
  const cols = jsonSourceFlag(args, "columns");
  if (cols === undefined) return usageError(format, "--columns is required", example);
  if (typeof cols === "string") return usageError(format, cols);
  if (!Array.isArray(cols.value)) return usageError(format, "--columns must be a JSON array of {name, type}");
  const partitionBy = listFlag(args, "partition-by");
  if (typeof partitionBy === "string") return usageError(format, partitionBy);
  const input: CreateDatasetInput = {
    displayName: name,
    columns: cols.value as DatasetColumn[],
    residencyClass: residency,
    ...(partitionBy !== undefined ? { partitionBy } : {}),
  };
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.create(slug, input), (d) => `Created. ${describe(d)}`);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "delete");
  if (typeof slug === "number") return slug;
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.delete(slug), () => `Dataset "${slug}" retired.`);
  return EXIT_SUCCESS;
}

/** Text from an inline value, `@file`, or `-` (stdin). */
function textSource(raw: string): string | { error: string } {
  if (raw !== "-" && !raw.startsWith("@")) return raw;
  try {
    return readFileSync(raw === "-" ? 0 : raw.slice(1), "utf8");
  } catch (e) {
    return { error: `Failed to read ${raw === "-" ? "stdin" : raw.slice(1)}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function cmdQuery(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o analytics query --sql 'SELECT count(*) FROM dataset.orders' --datasets orders`;
  const sqlRaw = need(args, "sql");
  if (typeof sqlRaw === "object") return usageError(format, sqlRaw.error, example);
  const datasets = listFlag(args, "datasets");
  if (datasets === undefined) return usageError(format, "--datasets is required", example);
  if (typeof datasets === "string") return usageError(format, datasets);
  const sql = textSource(sqlRaw);
  if (typeof sql === "object") return usageError(format, sql.error);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.query({ sql, datasets }));
  return EXIT_SUCCESS;
}

async function cmdRead(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "read");
  if (typeof slug === "number") return slug;
  const filter = jsonObjectFlag(args, "partition-filter");
  if (typeof filter === "string") return usageError(format, filter);
  const limit = intFlag(args, "limit", 1, Number.MAX_SAFE_INTEGER);
  if (typeof limit === "string") return usageError(format, limit);
  const cursor = valueFlag(args, "cursor");
  if (typeof cursor === "object") return usageError(format, cursor.error);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.analytics.read(slug, {
    ...(filter !== undefined ? { partitionFilter: filter } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No rows.";
    return [...rows.map((r) => JSON.stringify(r)), ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdMaterialize(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "materialize");
  if (typeof slug === "number") return slug;
  const col = valueFlag(args, "from-collection");
  if (typeof col === "object") return usageError(format, col.error);
  const q = valueFlag(args, "from-query");
  if (typeof q === "object") return usageError(format, q.error);
  if ((col === undefined) === (q === undefined)) {
    return usageError(format, "pass exactly one of --from-collection and --from-query", `k9o analytics materialize ${slug} --from-collection orders`);
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.analytics.materialize(slug, col !== undefined ? { fromCollection: col } : { fromQuery: q! });
  emitSuccess(format, envelope, (r) => `Materialized into ${slug}: read ${r.rowsRead ?? "-"}, ingested ${r.ingested ?? "-"}, rejected ${r.rejected ?? "-"}.`);
  return EXIT_SUCCESS;
}

function onErrorFlag(args: ParsedArgs): "skip" | "reject" | undefined | { error: string } {
  const v = valueFlag(args, "on-error");
  if (v === undefined) return undefined;
  if (typeof v === "object") return v;
  if (v !== "skip" && v !== "reject") return { error: `invalid --on-error "${v}" (use skip or reject)` };
  return v;
}

const ingestText = (r: { ingested?: number; skipped?: number; skippedDetails?: unknown[] }): string =>
  `ingested ${r.ingested ?? "-"}, skipped ${r.skipped ?? 0}${(r.skippedDetails?.length ?? 0) > 0 ? `\n${r.skippedDetails!.slice(0, 20).map((d) => `  skipped: ${JSON.stringify(d)}`).join("\n")}` : ""}`;

async function cmdWrite(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "write");
  if (typeof slug === "number") return slug;
  const example = `k9o analytics write ${slug} --rows '[{"city":"Berlin","amount":42.5}]'`;
  const inline = valueFlag(args, "rows");
  if (typeof inline === "object") return usageError(format, inline.error);
  const file = valueFlag(args, "rows-file");
  if (typeof file === "object") return usageError(format, file.error);
  if ((inline === undefined) === (file === undefined)) return usageError(format, "pass exactly one of --rows and --rows-file", example);
  const onError = onErrorFlag(args);
  if (typeof onError === "object") return usageError(format, onError.error);
  let rows: Array<Record<string, unknown>> | string;
  if (inline !== undefined) {
    try {
      const parsed: unknown = JSON.parse(inline);
      if (!Array.isArray(parsed) || parsed.length === 0) return usageError(format, "--rows must be a non-empty JSON array of objects", example);
      rows = parsed as Array<Record<string, unknown>>;
    } catch {
      return usageError(format, "--rows is not valid JSON", example);
    }
  } else {
    const text = textSource(file === "-" ? "-" : `@${file}`);
    if (typeof text === "object") return usageError(format, text.error);
    // A JSON array goes as an array; anything else is sent as newline-delimited JSON.
    let arr: unknown;
    try { arr = JSON.parse(text); } catch { arr = undefined; }
    rows = Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : text;
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.analytics.write(slug, rows, onError !== undefined ? { onError } : {});
  emitSuccess(format, envelope, (r) => `Wrote to ${slug}: ${ingestText(r)}`);
  return EXIT_SUCCESS;
}

async function cmdUpload(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "upload");
  if (typeof slug === "number") return slug;
  const path = positionalArg(args, 3);
  if (path === undefined) return usageError(format, "k9o analytics upload requires <file> (positional)", `k9o analytics upload ${slug} ./orders.csv`);
  const fmtFlag = valueFlag(args, "format");
  if (typeof fmtFlag === "object") return usageError(format, fmtFlag.error);
  const ext = /\.(csv|json)$/i.exec(path)?.[1]?.toLowerCase();
  const fileFormat = fmtFlag ?? ext;
  if (fileFormat !== "csv" && fileFormat !== "json") return usageError(format, fmtFlag === undefined ? "cannot tell the format from the file name" : `invalid --format "${fmtFlag}"`, "Pass --format csv or --format json");
  const onError = onErrorFlag(args);
  if (typeof onError === "object") return usageError(format, onError.error);
  const delimiter = valueFlag(args, "delimiter");
  if (typeof delimiter === "object") return usageError(format, delimiter.error);
  const encoding = valueFlag(args, "encoding");
  if (typeof encoding === "object") return usageError(format, encoding.error);
  const manifestRaw = valueFlag(args, "manifest");
  if (typeof manifestRaw === "object") return usageError(format, manifestRaw.error);
  let manifest: CreateDatasetInput | undefined;
  if (manifestRaw !== undefined) {
    const t = textSource(manifestRaw);
    if (typeof t === "object") return usageError(format, t.error);
    try { manifest = JSON.parse(t) as CreateDatasetInput; } catch { return usageError(format, "--manifest is not valid JSON"); }
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    return usageError(format, `Failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const options: DatasetUploadOptions = {
    format: fileFormat,
    fileName: path.split(/[\\/]/).pop()!,
    ...(args.flags["dry-run"] === "true" ? { dryRun: true } : {}),
    ...(onError !== undefined ? { onError } : {}),
    ...(delimiter !== undefined ? { delimiter } : {}),
    ...(encoding !== undefined ? { encoding } : {}),
    ...(args.flags["no-header"] === "true" ? { hasHeader: false } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.analytics.upload(slug, bytes, options);
  if (options.dryRun === true) {
    emitSuccess(format, envelope);
  } else {
    emitSuccess(format, envelope, (r) => `Uploaded ${path} to ${slug}: ${ingestText(r)}`);
  }
  return EXIT_SUCCESS;
}

async function cmdDownload(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args, "download-original");
  if (typeof slug === "number") return slug;
  const out = valueFlag(args, "out") ?? positionalArg(args, 3);
  if (typeof out === "object") return usageError(format, out.error);
  if (out === undefined) return usageError(format, "k9o analytics download-original requires --out <file>", `k9o analytics download-original ${slug} --out ./orders-original.csv`);
  const { client } = clientFromProfile(args, { requireProject: true });
  const file = await client.analytics.downloadOriginal(slug);
  writeFileSync(out, file.bytes);
  emitSuccess(format, { data: { file: out, bytes: file.bytes.length, contentType: file.contentType, fileName: file.fileName }, meta: {} },
    (d) => `Saved ${d.bytes} bytes to ${d.file}${d.fileName !== null ? ` (original name ${d.fileName})` : ""}.`);
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// rollups
// ---------------------------------------------------------------------------

function reattestDays(args: ParsedArgs): ReattestDays | undefined | string {
  const v = valueFlag(args, "reattest-days");
  if (v === undefined) return undefined;
  if (typeof v === "object") return v.error;
  if (!["7", "30", "90", "365"].includes(v)) return "--reattest-days must be 7, 30, 90 or 365";
  return Number(v) as ReattestDays;
}

function parentArgs(args: ParsedArgs, group: string, verb: string): { dataset: string; id: string | undefined } | number {
  const format = resolveOutputFormat(args.flags);
  const dataset = positionalArg(args, 3);
  if (dataset === undefined) return usageError(format, `k9o analytics ${group} ${verb} requires <dataset> (positional)`, `k9o analytics ${group} ${verb} orders`);
  return { dataset, id: positionalArg(args, 4) };
}

async function dispatchRollups(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const verb = args.positional[2];
  if (verb === undefined) return usageError(format, "k9o analytics rollups needs a subcommand", "Valid: create | list | delete | reattest");
  if (!["create", "list", "delete", "reattest"].includes(verb)) return usageError(format, `unknown rollups subcommand "${verb}"`, "Valid: create | list | delete | reattest");
  const p = parentArgs(args, "rollups", verb);
  if (typeof p === "number") return p;
  const { dataset, id } = p;
  const days = reattestDays(args);
  if (typeof days === "string") return usageError(format, days);

  if (verb === "list") {
    const { client } = clientFromProfile(args, { requireProject: true });
    emitSuccess(format, await client.analytics.rollups.list(dataset), (r) => {
      if (r.rollups.length === 0) return "No rollups.";
      return ["Rollups:", ...r.rollups.map((x) => `  ${String(x.id ?? x["slug"] ?? "-").padEnd(36)}  ${String(x["slug"] ?? "-").padEnd(24)}  ${x.attestationStatus ?? "-"}  expires ${x.expiresAt ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (verb === "delete" || verb === "reattest") {
    if (id === undefined) return usageError(format, `k9o analytics rollups ${verb} requires <rollup-id> (positional)`, `k9o analytics rollups ${verb} ${dataset} <rollup-id>`);
    const { client } = clientFromProfile(args, { requireProject: true });
    if (verb === "delete") {
      emitSuccess(format, await client.analytics.rollups.delete(dataset, id), () => `Deleted rollup ${id}.`);
    } else {
      emitSuccess(format, await client.analytics.rollups.reattest(dataset, id, days !== undefined ? { reattestIntervalDays: days } : {}),
        (r) => `Re-attested rollup ${id}: ${r.attestationStatus ?? "-"}, expires ${r.expiresAt ?? "-"}.`);
    }
    return EXIT_SUCCESS;
  }

  // create
  const example = `k9o analytics rollups create orders --slug hourly --source orders-stream --measures '[{"name":"orders","agg":"count"}]' --window-seconds 3600 --non-personal`;
  const slug = need(args, "slug");
  if (typeof slug === "object") return usageError(format, slug.error, example);
  const source = need(args, "source");
  if (typeof source === "object") return usageError(format, source.error, example);
  const measures = jsonSourceFlag(args, "measures");
  if (measures === undefined) return usageError(format, "--measures is required", example);
  if (typeof measures === "string") return usageError(format, measures);
  if (!Array.isArray(measures.value)) return usageError(format, "--measures must be a JSON array of {name, agg, column?}");
  const win = intFlag(args, "window-seconds", 60, Number.MAX_SAFE_INTEGER);
  if (win === undefined) return usageError(format, "--window-seconds is required", example);
  if (typeof win === "string") return usageError(format, win);
  const dims = listFlag(args, "dimensions");
  if (typeof dims === "string") return usageError(format, dims);
  const subjectField = valueFlag(args, "subject-field");
  if (typeof subjectField === "object") return usageError(format, subjectField.error);
  const nonPersonal = args.flags["non-personal"] === "true";
  if ((subjectField !== undefined) === nonPersonal) return usageError(format, "pass exactly one of --subject-field and --non-personal", example);
  const input: CreateRollupInput = {
    slug,
    source,
    measures: measures.value as RollupMeasure[],
    windowSeconds: win,
    ...(dims !== undefined ? { dimensions: dims } : {}),
    ...(days !== undefined ? { reattestIntervalDays: days } : {}),
    ...(subjectField !== undefined ? { subjectField } : { nonPersonal: true }),
  };
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.analytics.rollups.create(dataset, input), (r) => `Created rollup ${r.id ?? r["slug"] ?? slug}: ${r.attestationStatus ?? "active"}, expires ${r.expiresAt ?? "-"}.`);
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

async function dispatchSchedules(args: ParsedArgs): Promise<number> {
  const format: OutputFormat = resolveOutputFormat(args.flags);
  const verb = args.positional[2];
  if (verb === undefined) return usageError(format, "k9o analytics schedules needs a subcommand", "Valid: create | list | delete | reattest");
  if (!["create", "list", "delete", "reattest"].includes(verb)) return usageError(format, `unknown schedules subcommand "${verb}"`, "Valid: create | list | delete | reattest");
  const p = parentArgs(args, "schedules", verb);
  if (typeof p === "number") return p;
  const { dataset, id } = p;
  const days = reattestDays(args);
  if (typeof days === "string") return usageError(format, days);

  if (verb === "list") {
    const { client } = clientFromProfile(args, { requireProject: true });
    emitSuccess(format, await client.analytics.schedules.list(dataset), (r) => {
      if (r.schedules.length === 0) return "No schedules.";
      return ["Schedules:", ...r.schedules.map((s) => `  ${String(s.id ?? "-").padEnd(36)}  ${s.attestationStatus ?? "-"}  last ${s.lastRunAt ?? "-"} (${s.lastRunStatus ?? "-"})  next ${s.nextRunAt ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (verb === "delete" || verb === "reattest") {
    if (id === undefined) return usageError(format, `k9o analytics schedules ${verb} requires <schedule-id> (positional)`, `k9o analytics schedules ${verb} ${dataset} <schedule-id>`);
    const { client } = clientFromProfile(args, { requireProject: true });
    if (verb === "delete") {
      emitSuccess(format, await client.analytics.schedules.delete(dataset, id), () => `Deleted schedule ${id}.`);
    } else {
      emitSuccess(format, await client.analytics.schedules.reattest(dataset, id, days !== undefined ? { reattestIntervalDays: days } : {}),
        (s) => `Re-attested schedule ${id}: ${s.attestationStatus ?? "-"}, expires ${s.expiresAt ?? "-"}.`);
    }
    return EXIT_SUCCESS;
  }

  const example = `k9o analytics schedules create orders --from-collection orders --interval-seconds 3600`;
  const col = need(args, "from-collection");
  if (typeof col === "object") return usageError(format, col.error, example);
  const interval = intFlag(args, "interval-seconds", 60, Number.MAX_SAFE_INTEGER);
  if (interval === undefined) return usageError(format, "--interval-seconds is required", example);
  if (typeof interval === "string") return usageError(format, interval);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.analytics.schedules.create(dataset, {
    fromCollection: col,
    intervalSeconds: interval,
    ...(days !== undefined ? { reattestIntervalDays: days } : {}),
  });
  emitSuccess(format, envelope, (s) => `Created schedule ${s.id ?? "-"}: next run ${s.nextRunAt ?? "-"}, expires ${s.expiresAt ?? "-"}.`);
  return EXIT_SUCCESS;
}
