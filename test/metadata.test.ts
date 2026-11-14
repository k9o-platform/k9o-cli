/** `k9o metadata filter|set|search|nearest|index` against a fake gateway. */

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

const BASE = "/@portal/metadata";
const p1 = { surface: "collection:posts", scope: "posts", recordId: "p1", metadata: { title: "Quarterly report", priority: 3 } };
const rows = { status: 200, body: envelope([p1], { cursor: { next: "cur_2" } }) };
const index = { collection: "posts", columns: [{ column: "body", indexed: false }, { column: "tags", indexed: true }] };

describe("k9o metadata filter", () => {
  it("posts surfaces, a prefixed where, limit and cursor, and prints the rows with the next cursor", async () => {
    const r = await signedIn(
      ["metadata", "filter", "--surface", "collection:posts", "--where", '[{"field":"priority","op":"gte","value":2}]', "--limit", "5", "--cursor", "cur_1"],
      () => rows,
      false,
    );
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/query`,
      body: { surfaces: ["collection:posts"], where: [{ field: "metadata.priority", op: "gte", value: 2 }], limit: 5, cursor: "cur_1" },
    });
    expect(r.stdout).toContain("collection:posts  p1  ");
    expect(r.stdout).toContain("More: --cursor cur_2");
  });

  it("takes several surfaces and prints json", async () => {
    const r = await signedIn(["metadata", "filter", "--surface", "collection:posts,telemetry:collection."], () => rows);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ surfaces: ["collection:posts", "telemetry:collection."] });
    expect(JSON.parse(r.stdout).data[0].recordId).toBe("p1");
  });

  it("refuses bad flags before any request", async () => {
    const argvs = [
      ["metadata", "filter"],
      ["metadata", "filter", "--surface", "collection:posts", "--where", "nope"],
      ["metadata", "filter", "--surface", "collection:posts", "--where", '{"a":1}'],
      ["metadata", "filter", "--surface", "collection:posts", "--limit", "0"],
      ["metadata", "filter", "--surface", "posts"],
      ["metadata", "filter", "--surface", "collection:a,collection:b", "--cursor", "c"],
    ];
    for (const argv of argvs) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code === 0, r.calls.length]).toEqual([argv.join(" "), false, 0]);
    }
  });

  it("exits non-zero with the gateway's code on 413 and 501", async () => {
    const big = await signedIn(["metadata", "filter", "--surface", "collection:posts"], () => ({ status: 413, body: { code: "K9O_QUERY_RESULT_TOO_LARGE", message: "x", context: { cap: 10000 } } }));
    expect(big.code).not.toBe(0);
    expect(big.stderr).toContain("K9O_QUERY_RESULT_TOO_LARGE");
    const nope = await signedIn(["metadata", "filter", "--surface", "storage:photos"], () => ({ status: 501, body: { code: "K9O_NOT_IMPLEMENTED", message: "x", context: {} } }));
    expect(nope.stderr).toContain("K9O_NOT_IMPLEMENTED");
  });
});

describe("k9o metadata set", () => {
  it("patches { metadata } and prints the record", async () => {
    const r = await signedIn(["metadata", "set", "posts", "p1", "--set", '{"title":"New","priority":9}'], () => ({ body: envelope({ id: "p1", title: "New", priority: 9 }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "PATCH", path: `${BASE}/collection/posts/p1`, body: { metadata: { title: "New", priority: 9 } } });
    expect(r.stdout).toContain("Updated posts/p1:");
  });

  it("reads --set from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k9o-meta-"));
    try {
      const file = join(dir, "set.json");
      writeFileSync(file, '{"title":"F"}');
      const r = await signedIn(["metadata", "set", "posts", "p1", "--set", `@${file}`], () => ({ body: envelope({ id: "p1" }) }));
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ metadata: { title: "F" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses bad input before any request", async () => {
    for (const argv of [["metadata", "set"], ["metadata", "set", "posts"], ["metadata", "set", "posts", "p1"], ["metadata", "set", "posts", "p1", "--set", "[]"], ["metadata", "set", "posts", "p1", "--set", "{}"]]) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code === 0, r.calls.length]).toEqual([argv.join(" "), false, 0]);
    }
  });
});

describe("k9o metadata search", () => {
  it("posts surface, prefixed field, q and limit", async () => {
    const r = await signedIn(["metadata", "search", "--surface", "collection:posts", "--field", "body", "--q", "finance", "--limit", "3"], () => rows);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/search`, body: { surface: "collection:posts", field: "metadata.body", q: "finance", limit: 3 } });
  });

  it("refuses missing flags before any request", async () => {
    for (const argv of [["metadata", "search"], ["metadata", "search", "--surface", "collection:posts", "--field", "body"], ["metadata", "search", "--surface", "telemetry:x", "--field", "body", "--q", "a"]]) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code === 0, r.calls.length]).toEqual([argv.join(" "), false, 0]);
    }
  });
});

describe("k9o metadata nearest", () => {
  it("posts the prefixed column, embedding, k, metric and where", async () => {
    const r = await signedIn(
      ["metadata", "nearest", "--surface", "collection:posts", "--column", "embedding", "--embedding", "[1,0,0]", "--k", "3", "--metric", "dot", "--where", '[{"field":"priority","op":"gt","value":1}]'],
      () => rows,
      false,
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/vectors/nearest`,
      body: { surface: "collection:posts", column: "metadata.embedding", embedding: [1, 0, 0], k: 3, metric: "dot", where: [{ field: "metadata.priority", op: "gt", value: 1 }] },
    });
    expect(r.stdout).toContain("p1");
  });

  it("reads the embedding from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k9o-meta-"));
    try {
      const file = join(dir, "e.json");
      writeFileSync(file, "[0.5, 0.25]");
      const r = await signedIn(["metadata", "nearest", "--surface", "collection:posts", "--column", "embedding", "--embedding-file", file], () => rows);
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ surface: "collection:posts", column: "metadata.embedding", embedding: [0.5, 0.25] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses bad input before any request", async () => {
    const base = ["metadata", "nearest", "--surface", "collection:posts", "--column", "embedding"];
    for (const extra of [[], ["--embedding", "nope"], ["--embedding", '{"a":1}'], ["--embedding", "[1]", "--embedding-file", "x.json"], ["--embedding", "[1]", "--k", "0"], ["--embedding", "[1]", "--metric", "l2"], ["--embedding", "[]"]]) {
      const r = await signedIn([...base, ...extra], () => undefined);
      expect([extra.join(" "), r.code === 0, r.calls.length]).toEqual([extra.join(" "), false, 0]);
    }
  });
});

describe("k9o metadata index", () => {
  it("gets the declaration", async () => {
    const r = await signedIn(["metadata", "index", "get", "posts"], () => ({ body: envelope(index) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/index/posts` });
    expect(r.stdout).toContain("Declared columns on posts:");
    expect(r.stdout).toContain("tags  (indexed)");
  });

  it("declares columns with PUT", async () => {
    const r = await signedIn(["metadata", "index", "declare", "posts", "--columns", '[{"column":"body"},{"column":"tags","indexed":true}]'], () => ({ body: envelope(index) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "PUT", path: `${BASE}/index/posts`, body: { columns: [{ column: "body" }, { column: "tags", indexed: true }] } });
    expect(JSON.parse(r.stdout).data.collection).toBe("posts");
  });

  it("refuses bad input before any request", async () => {
    const tooMany = JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ column: `c${i}` })));
    for (const argv of [
      ["metadata", "index"],
      ["metadata", "index", "drop", "posts"],
      ["metadata", "index", "get"],
      ["metadata", "index", "declare", "posts"],
      ["metadata", "index", "declare", "posts", "--columns", "{}"],
      ["metadata", "index", "declare", "posts", "--columns", tooMany],
      ["metadata", "index", "declare", "posts", "--columns", '[{"column":"id"}]'],
    ]) {
      const r = await signedIn(argv, () => undefined);
      expect([argv.join(" "), r.code === 0, r.calls.length]).toEqual([argv.join(" "), false, 0]);
    }
  });

  it("prints help and rejects unknown subcommands", async () => {
    expect((await signedIn(["metadata", "filter", "--help"], () => undefined)).code).toBe(0);
    expect((await signedIn(["metadata", "bogus"], () => undefined)).code).toBe(2);
  });
});
