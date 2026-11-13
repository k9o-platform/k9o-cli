/**
 * `k9o vectors` subcommands: nearest / upsert, over `client.vectors`.
 *
 * A vector collection holds embeddings you computed yourself. Its name starts with `_`. Both commands send the vector
 * in the request body, so real embeddings of any common size work.
 */

import type { NearestVectorsInput, VectorFilters, VectorMetric, VectorRow } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, jsonInput, jsonObjectFlag, textFlag, usageError } from "./json-flag.ts";

const METRICS = ["cosine", "euclidean", "dot"];

function printHelp(): void {
  process.stdout.write(`
k9o vectors — store embeddings and find the nearest ones

USAGE
  k9o vectors <subcommand> <collection> [flags...]

A vector collection's name starts with _ (for example _notes). The first upsert creates it and
fixes its dimension; every later vector must have the same length.

SUBCOMMANDS
  nearest <collection> --vector '<json array>' | --vector-file <path|->
          [--top-k <1-1000>] [--min-score <number>] [--metric cosine|euclidean|dot]
          [--filters '<json object>']
                                The rows nearest to the vector, closest first. --vector-file reads
                                the array from a file, or from stdin with -. --top-k defaults to
                                10, --metric to cosine. --filters are equality filters on id,
                                contentHash, source.<key> and metadata.<key>.
  upsert <collection> --rows '<json array>' | --rows-file <path|->
                                Insert or overwrite 1 to 1000 rows. A row is { vector, _source:
                                { handle, chunkIndex }, id?, contentHash?, text?, metadata?,
                                subjectIds? }. subjectIds (["eu_..."]) is required unless the
                                collection is shared.

EXAMPLES
  k9o vectors upsert _notes --rows '[{"vector":[1,0,0],"_source":{"handle":"a","chunkIndex":0},"subjectIds":["eu_abc"]}]'
  k9o vectors nearest _notes --vector '[0.9,0.1,0]' --top-k 3 --filters '{"metadata.lang":"en"}'
  k9o vectors nearest _notes --vector-file query.json --output json
`.trim() + "\n");
}

export async function dispatchVectors(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "nearest") return await cmdNearest(args);
    if (sub === "upsert") return await cmdUpsert(args);
    return usageError(format, `unknown vectors subcommand "${sub}"`, "Valid: nearest | upsert");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function collectionArg(args: ParsedArgs, sub: string): string | number {
  const format = resolveOutputFormat(args.flags);
  const name = args.positional[2];
  if (name === undefined || name.length === 0) return usageError(format, `k9o vectors ${sub} requires <collection> (positional)`, `k9o vectors ${sub} _notes`);
  if (!name.startsWith("_")) return usageError(format, `a vector collection name must start with _ (got "${name}")`, `k9o vectors ${sub} _${name}`);
  return name;
}

async function cmdNearest(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o vectors nearest _notes --vector '[0.9,0.1,0]'`;
  const collection = collectionArg(args, "nearest");
  if (typeof collection === "number") return collection;
  const vector = jsonInput(args, "vector", "vector-file");
  if (typeof vector === "string") return usageError(format, vector, example);
  if (vector === undefined) return usageError(format, "k9o vectors nearest requires --vector <json array> or --vector-file <path|->", example);
  if (!Array.isArray(vector.value)) return usageError(format, "the query vector must be a JSON array of numbers", example);
  const topK = intFlag(args, "top-k", 1, 1000);
  if (typeof topK === "string") return usageError(format, topK);
  let minScore: number | undefined;
  const rawMin = args.flags["min-score"];
  if (rawMin !== undefined) {
    minScore = rawMin === "true" || rawMin.trim() === "" ? Number.NaN : Number(rawMin);
    if (!Number.isFinite(minScore)) return usageError(format, "--min-score must be a number");
  }
  const metric = textFlag(args, "metric");
  if (args.flags["metric"] === "true") return usageError(format, "--metric needs a value", `Use one of: ${METRICS.join(", ")}`);
  if (metric !== undefined && !METRICS.includes(metric)) return usageError(format, `invalid --metric "${metric}"`, `Use one of: ${METRICS.join(", ")}`);
  const filters = jsonObjectFlag(args, "filters");
  if (typeof filters === "string") return usageError(format, filters, `--filters '{"metadata.lang":"en"}'`);
  const input: NearestVectorsInput = {
    queryVector: vector.value as number[],
    ...(topK !== undefined ? { topK } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
    ...(metric !== undefined ? { metric: metric as VectorMetric } : {}),
    ...(filters !== undefined ? { filters: filters as VectorFilters } : {}),
  };
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.vectors.nearest(collection, input);
  emitSuccess(format, envelope, (d) => {
    if (d.results.length === 0) return `No matches in ${d.collection}.`;
    const lines = d.results.map((r) => {
      const text = r.text === null ? "" : `  ${r.text.length > 60 ? `${r.text.slice(0, 57)}...` : r.text}`;
      return `  ${r.score.toFixed(4)}  ${r.id}  ${r._source.handle}#${r._source.chunkIndex}${text}`;
    });
    return [`Nearest in ${d.collection}:`, ...lines].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdUpsert(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o vectors upsert _notes --rows '[{"vector":[1,0,0],"_source":{"handle":"a","chunkIndex":0},"subjectIds":["eu_abc"]}]'`;
  const collection = collectionArg(args, "upsert");
  if (typeof collection === "number") return collection;
  const rows = jsonInput(args, "rows", "rows-file");
  if (typeof rows === "string") return usageError(format, rows, example);
  if (rows === undefined) return usageError(format, "k9o vectors upsert requires --rows <json array> or --rows-file <path|->", example);
  if (!Array.isArray(rows.value)) return usageError(format, "the rows must be a JSON array of row objects", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.vectors.upsert(collection, rows.value as VectorRow[]);
  emitSuccess(format, envelope, (d) => `Upserted ${d.upserted} row${d.upserted === 1 ? "" : "s"} in ${d.collection}.`);
  return EXIT_SUCCESS;
}
