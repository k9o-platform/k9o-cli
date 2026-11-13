/** `k9o vectors nearest|upsert` against a fake gateway. */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope, runCli, tempCredentials, type Handler } from "./helpers.ts";

async function signedIn(argv: string[], handler: Handler, json = true) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path, ...(json ? ["--output", "json"] : [])], handler);
  } finally {
    c.cleanup();
  }
}

const BASE = "/@portal";
const found = {
  results: [
    { id: "rec_1", score: 0.98, _source: { handle: "doc-a", chunkIndex: 0 }, contentHash: "h1", text: "alpha", metadata: { lang: "en" }, model: null, chunk: 0 },
    { id: "rec_2", score: 0.5, _source: { handle: "doc-b", chunkIndex: 3 }, contentHash: null, text: null, metadata: {}, model: null, chunk: 3 },
  ],
  collection: "_notes",
};
const row = { vector: [1, 0, 0], _source: { handle: "a", chunkIndex: 0 }, subjectIds: ["eu_abc"] };

describe("k9o vectors nearest", () => {
  it("posts every option and prints the results", async () => {
    const r = await signedIn(
      ["vectors", "nearest", "_notes", "--vector", "[0.9,0.1,0]", "--top-k", "2", "--min-score", "0.25", "--metric", "euclidean", "--filters", '{"metadata.lang":"en"}'],
      () => ({ body: envelope(found) }),
      false,
    );
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/vectors/_notes/search`,
      body: { queryVector: [0.9, 0.1, 0], topK: 2, minScore: 0.25, metric: "euclidean", filters: { "metadata.lang": "en" } },
    });
    expect(r.stdout).toContain("Nearest in _notes:");
    expect(r.stdout).toContain("0.9800  rec_1  doc-a#0  alpha");
    expect(r.stdout).toContain("0.5000  rec_2  doc-b#3");
  });

  it("--output json prints the envelope", async () => {
    const r = await signedIn(["vectors", "nearest", "_notes", "--vector", "[1]"], () => ({ body: envelope(found) }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data.results).toHaveLength(2);
    expect(r.calls[0]!.body).toEqual({ queryVector: [1] });
  });

  it("reads the vector from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k9o-vec-"));
    try {
      const file = join(dir, "q.json");
      writeFileSync(file, "[0.5, 0.25]");
      const r = await signedIn(["vectors", "nearest", "_notes", "--vector-file", file], () => ({ body: envelope(found) }));
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ queryVector: [0.5, 0.25] });
      const missing = await signedIn(["vectors", "nearest", "_notes", "--vector-file", join(dir, "none.json")], () => undefined);
      expect(missing.code).toBe(2);
      expect(missing.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so when nothing matches", async () => {
    const r = await signedIn(["vectors", "nearest", "_notes", "--vector", "[1]"], () => ({ body: envelope({ results: [], collection: "_notes" }) }), false);
    expect(r.stdout).toContain("No matches in _notes.");
  });

  it("refuses bad flags before any request", async () => {
    const argvs = [
      ["vectors", "nearest"],
      ["vectors", "nearest", "notes", "--vector", "[1]"],
      ["vectors", "nearest", "_notes"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--vector-file", "x.json"],
      ["vectors", "nearest", "_notes", "--vector", "nope"],
      ["vectors", "nearest", "_notes", "--vector", '{"a":1}'],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--top-k", "0"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--top-k", "1001"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--min-score", "high"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--metric", "l2"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--filters", "[]"],
      ["vectors", "nearest", "_notes", "--vector", "[1]", "--filters", "nope"],
    ];
    for (const argv of argvs) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code]).toEqual([argv.join(" "), 2]);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a vector the SDK refuses (empty, non-numeric) sends nothing", async () => {
    for (const v of ["[]", '["a"]']) {
      const r = await signedIn(["vectors", "nearest", "_notes", "--vector", v], () => undefined);
      expect(r.code).not.toBe(0);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a missing collection exits non-zero with the gateway's code", async () => {
    const r = await signedIn(["vectors", "nearest", "_none", "--vector", "[1]"], () => ({ status: 404, body: { code: "K9O_COLLECTION_NOT_FOUND", message: "Collection '_none' does not exist in this project", context: {}, recommendation: null } }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("K9O_COLLECTION_NOT_FOUND");
  });
});

describe("k9o vectors upsert", () => {
  it("posts { rows } and prints the count", async () => {
    const r = await signedIn(["vectors", "upsert", "_notes", "--rows", JSON.stringify([row])], () => ({ body: envelope({ upserted: 1, collection: "_notes" }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/vectors/_notes/upsert`, body: { rows: [row] } });
    expect(r.stdout).toContain("Upserted 1 row in _notes.");
  });

  it("reads rows from a file and prints json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k9o-vec-"));
    try {
      const file = join(dir, "rows.json");
      writeFileSync(file, JSON.stringify([row, row]));
      const r = await signedIn(["vectors", "upsert", "_notes", "--rows-file", file], () => ({ body: envelope({ upserted: 2, collection: "_notes" }) }));
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).data).toEqual({ upserted: 2, collection: "_notes" });
      expect((r.calls[0]!.body as { rows: unknown[] }).rows).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses bad input before any request", async () => {
    const argvs = [
      ["vectors", "upsert"],
      ["vectors", "upsert", "notes", "--rows", "[]"],
      ["vectors", "upsert", "_notes"],
      ["vectors", "upsert", "_notes", "--rows", "nope"],
      ["vectors", "upsert", "_notes", "--rows", "{}"],
      ["vectors", "upsert", "_notes", "--rows", "[]"],
      ["vectors", "upsert", "_notes", "--rows", "[]", "--rows-file", "x.json"],
    ];
    for (const argv of argvs) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code === 0]).toEqual([argv.join(" "), false]);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("surfaces a subject attribution refusal", async () => {
    const r = await signedIn(["vectors", "upsert", "_notes", "--rows", JSON.stringify([{ vector: [1], _source: { handle: "a", chunkIndex: 0 } }])], () => ({ status: 400, body: { code: "K9O_VECTOR_SUBJECT_ATTRIBUTION_REQUIRED", message: "subjectIds required", context: {}, recommendation: null } }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("K9O_VECTOR_SUBJECT_ATTRIBUTION_REQUIRED");
  });
});

describe("k9o vectors help", () => {
  it("lists both subcommands; an unknown one is a usage error", async () => {
    const h = await signedIn(["vectors", "nearest", "--help"], () => undefined, false);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("nearest <collection>");
    expect(h.stdout).toContain("upsert <collection>");
    expect((await signedIn(["vectors", "nope"], () => undefined)).code).toBe(2);
    expect((await signedIn(["vectors"], () => undefined, false)).code).toBe(2);
  });
});
