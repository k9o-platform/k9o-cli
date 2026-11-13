/** `k9o keys`, `k9o analytics` (datasets, rollups, schedules), `k9o rollups` and `k9o audit tail` against a fake gateway. */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { envelope, runCli, tempCredentials, tempPath, type Handler } from "./helpers.ts";

const BASE = "/@portal";

async function signedIn(argv: string[], handler: Handler, json = true) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path, ...(json ? ["--output", "json"] : [])], handler);
  } finally {
    c.cleanup();
  }
}

const challenge = { scopeSetRoot: "ssr-1", nonce: "n-1", methods: ["webauthn", "dpop"], maxAgeSec: 120 };
const key = { id: "vkey_1", version: 3, status: "active", custodyMode: "PLATFORM_MANAGED", createdAt: "2026-10-01T10:00:00.000Z" };

describe("k9o keys", () => {
  it("list sends status=all for --all and prints the keys", async () => {
    const r = await signedIn(["keys", "list", "--all"], () => ({ body: envelope({ items: [key], nextCursor: null }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}?${c.query["status"]}`)).toEqual([`GET ${BASE}/vault/keys?all`]);
    expect(r.stdout).toContain("vkey_1");
    expect(r.stdout).toContain("PLATFORM_MANAGED");
    const plain = await signedIn(["keys", "list"], () => ({ body: envelope({ items: [], nextCursor: null }) }), false);
    expect(plain.calls[0]!.query["status"]).toBeUndefined();
    expect(plain.stdout).toContain("No keys.");
    const noCursor = await signedIn(["keys", "list"], () => ({ body: envelope({ items: [key], nextCursor: "c2" }) }), false);
    expect(noCursor.stdout).not.toContain("More:");
    expect(noCursor.stdout).not.toContain("c2");
  });

  it("get prints one key and --output json prints the envelope", async () => {
    const r = await signedIn(["keys", "get", "vkey_1"], () => ({ body: envelope(key) }));
    expect(r.calls[0]!.path).toBe(`${BASE}/vault/keys/vkey_1`);
    expect(JSON.parse(r.stdout).data.id).toBe("vkey_1");
    const h = await signedIn(["keys", "get", "vkey_1"], () => ({ body: envelope(key) }), false);
    expect(h.stdout).toContain("version: 3  status: active");
  });

  it("get and rotate without an id exit 2 before any request", async () => {
    for (const sub of ["get", "rotate"]) {
      const r = await signedIn(["keys", sub], () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    expect((await signedIn(["keys", "nope"], () => undefined)).code).toBe(2);
  });

  it("rotate posts once and reports the versions", async () => {
    const r = await signedIn(["keys", "rotate", "vkey_1"], () => ({ body: envelope({ keyId: "vkey_1", previousVersion: 3, newVersion: 4, status: "rotated" }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${BASE}/vault/keys/vkey_1/rotate`]);
    expect(r.stdout).toContain("version 3 -> 4");
  });

  it("rotate states the step-up requirement, exits non-zero and does not retry", async () => {
    const stepUp = { status: 401, body: { code: "K9O_STEP_UP_REQUIRED", message: "Fresh MFA required", context: { stepUp: challenge } } };
    const r = await signedIn(["keys", "rotate", "vkey_1"], () => stepUp, false);
    expect(r.code).toBe(66);
    expect(r.calls).toHaveLength(1);
    expect(r.stderr).toContain("K9O_STEP_UP_REQUIRED");
    expect(r.stderr).toContain("needs a fresh MFA step-up");
    expect(r.stderr).toContain("k9o keys rotate vkey_1");
    expect(r.stderr).toContain('"nonce":"n-1"');
    expect(r.stdout).toBe("");
    const j = await signedIn(["keys", "rotate", "vkey_1"], () => stepUp);
    expect(j.code).toBe(66);
    const err = JSON.parse(j.stderr);
    expect(err.code).toBe("K9O_STEP_UP_REQUIRED");
    expect(err.context.stepUp.nonce).toBe("n-1");
  });

  describe("rotate --step-up-proof-cmd", () => {
    const rotated = { body: envelope({ keyId: "vkey_1", previousVersion: 3, newVersion: 4, status: "rotated" }) };
    const needStep = { status: 401, body: { code: "K9O_STEP_UP_REQUIRED", message: "Fresh MFA required", context: { stepUp: challenge } } };
    const header = (h: string) => JSON.parse(Buffer.from(h, "base64url").toString("utf8"));

    it("runs the command with the challenge on stdin and the call in env, then retries exactly once with the proof", async () => {
      const dump = tempPath("seen.json");
      const script = tempPath("proof.sh");
      writeFileSync(script.path, `#!/bin/sh\ncat > "$1.stdin"\nprintf '%s %s' "$K9O_STEPUP_METHOD" "$K9O_STEPUP_URL" > "$1.env"\nprintf '{"method":"webauthn","proof":"assertion-xyz"}'\n`);
      const cmd = `sh ${script.path} ${dump.path}`;
      let n = 0;
      const r = await signedIn(["keys", "rotate", "vkey_1", "--step-up-proof-cmd", cmd], () => (++n === 1 ? needStep : rotated), false);
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${BASE}/vault/keys/vkey_1/rotate`, `POST ${BASE}/vault/keys/vkey_1/rotate`]);
      expect(r.calls[0]!.headers["x-k9o-step-up-proof"]).toBeUndefined();
      expect(header(r.calls[1]!.headers["x-k9o-step-up-proof"]!)).toEqual({ scopeSetRoot: "ssr-1", nonce: "n-1", method: "webauthn", proof: "assertion-xyz" });
      expect(JSON.parse(readFileSync(`${dump.path}.stdin`, "utf8"))).toMatchObject({ scopeSetRoot: "ssr-1", nonce: "n-1", methods: ["webauthn", "dpop"], maxAgeSec: 120 });
      expect(readFileSync(`${dump.path}.env`, "utf8")).toBe(`POST http://localhost:9${BASE}/vault/keys/vkey_1/rotate`);
      expect(r.stdout).toContain("version 3 -> 4");
      expect(r.stdout + r.stderr).not.toContain("assertion-xyz");
      dump.cleanup();
      script.cleanup();
    });

    it("a second step-up 401 is printed as it is and not retried again; the proof is not logged", async () => {
      const r = await signedIn(["keys", "rotate", "vkey_1", "--step-up-proof-cmd", `printf '{"method":"dpop","proof":"secret-proof"}'`], () => needStep, false);
      expect(r.code).toBe(66);
      expect(r.calls).toHaveLength(2);
      expect(r.stderr).toContain("K9O_STEP_UP_REQUIRED");
      expect(r.stderr + r.stdout).not.toContain("secret-proof");
    });

    it("a failing or malformed command stops before the second request", async () => {
      for (const cmd of ["exit 3", "printf 'not json'", `printf '{"method":"sms","proof":"p"}'`, `printf '{"method":"dpop"}'`]) {
        const r = await signedIn(["keys", "rotate", "vkey_1", "--step-up-proof-cmd", cmd], () => needStep, false);
        expect(r.code, cmd).toBe(1);
        expect(r.calls, cmd).toHaveLength(1);
        expect(r.stderr, cmd).toContain("K9O_STEP_UP_PROOF_COMMAND_FAILED");
      }
    });

    it("is not run when the first request needs no step-up; a bare flag is a usage error", async () => {
      const r = await signedIn(["keys", "rotate", "vkey_1", "--step-up-proof-cmd", "exit 9"], () => rotated, false);
      expect(r.code).toBe(0);
      expect(r.calls).toHaveLength(1);
      const bad = await signedIn(["keys", "rotate", "vkey_1", "--step-up-proof-cmd"], () => undefined);
      expect(bad.code).toBe(2);
      expect(bad.calls).toHaveLength(0);
    });
  });

  it("rotate renders a 429 cap with its exit code", async () => {
    const r = await signedIn(["keys", "rotate", "vkey_1"], () => ({ status: 429, body: { code: "K9O_RATE_LIMITED", message: "cap", context: { reason: "rotation_rate_cap" } }, headers: { "retry-after": "60" } }), false);
    expect(r.code).toBe(72);
    expect(r.stderr).toContain("K9O_RATE_LIMITED");
  });
});

const ds = { slug: "orders", displayName: "Orders", schema: [{ name: "city", type: "string" }], partitionKeys: ["region"], residencyClass: "shared", storageTarget: { kind: "managed" }, createdAt: "2026-10-26T10:00:00.000Z" };

describe("k9o analytics datasets", () => {
  it("list and get", async () => {
    const l = await signedIn(["analytics", "list"], () => ({ body: envelope([ds]) }), false);
    expect(l.calls[0]!.path).toBe(`${BASE}/analytics`);
    expect(l.stdout).toContain("orders");
    const alias = await signedIn(["datasets", "get", "orders"], () => ({ body: envelope(ds) }), false);
    expect(alias.calls[0]!.path).toBe(`${BASE}/analytics/orders`);
    expect(alias.stdout).toContain("columns: city:string");
    expect((await signedIn(["dataset", "get"], () => undefined)).code).toBe(2);
  });

  it("create maps flags to the SDK body", async () => {
    const r = await signedIn(
      ["analytics", "create", "orders", "--name", "Orders", "--residency", "shared", "--columns", '[{"name":"city","type":"string"}]', "--partition-by", "city"],
      () => ({ status: 201, body: envelope(ds) }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders`, body: { displayName: "Orders", residencyClass: "shared", columns: [{ name: "city", type: "string" }], partitionBy: ["city"] } });
  });

  it("create refuses bad flags before any request", async () => {
    const base = ["analytics", "create", "orders"];
    for (const extra of [[], ["--name", "O"], ["--name", "O", "--residency", "everywhere", "--columns", "[]"], ["--name", "O", "--residency", "shared", "--columns", "{"], ["--name", "O", "--residency", "shared", "--columns", "{}"]]) {
      const r = await signedIn([...base, ...extra], () => undefined);
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("delete, get on a missing dataset exits 68", async () => {
    const d = await signedIn(["analytics", "delete", "orders"], () => ({ body: envelope({ slug: "orders", status: "retired" }) }), false);
    expect(d.calls[0]!.method).toBe("DELETE");
    expect(d.stdout).toContain('Dataset "orders" retired.');
    const m = await signedIn(["analytics", "get", "nope"], () => ({ status: 404, body: { code: "K9O_DATASET_NOT_FOUND", message: "no such dataset", context: {} } }), false);
    expect(m.code).toBe(68);
    expect(m.stderr).toContain("K9O_DATASET_NOT_FOUND");
  });

  it("query sends sql and datasets; --sql reads @file", async () => {
    const r = await signedIn(["analytics", "query", "--sql", "SELECT 1 FROM dataset.orders", "--datasets", "orders,returns"], () => ({ body: envelope({ rows: [[1]] }) }));
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/query`, body: { sql: "SELECT 1 FROM dataset.orders", datasets: ["orders", "returns"] } });
    const f = tempPath("q.sql");
    writeFileSync(f.path, "SELECT 2 FROM dataset.orders");
    try {
      const r2 = await signedIn(["analytics", "query", "--sql", `@${f.path}`, "--datasets", "orders"], () => ({ body: envelope({ rows: [] }) }));
      expect((r2.calls[0]!.body as { sql: string }).sql).toBe("SELECT 2 FROM dataset.orders");
    } finally {
      f.cleanup();
    }
    expect((await signedIn(["analytics", "query", "--sql", "SELECT 1"], () => undefined)).code).toBe(2);
  });

  it("read pages with filter, limit and cursor and prints the next cursor", async () => {
    const r = await signedIn(
      ["analytics", "read", "orders", "--partition-filter", '{"city":"Berlin"}', "--limit", "2", "--cursor", "c0"],
      () => ({ body: envelope([{ _k9o_row_id: "r1", city: "Berlin" }], { cursor: { next: "c1" } }) }),
      false,
    );
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders/read`, body: { partitionFilter: { city: "Berlin" }, limit: 2, cursor: "c0" } });
    expect(r.stdout).toContain('"city":"Berlin"');
    expect(r.stdout).toContain("More: --cursor c1");
    expect((await signedIn(["analytics", "read", "orders", "--limit", "0"], () => undefined)).code).toBe(2);
  });

  it("materialize needs exactly one source", async () => {
    const r = await signedIn(["analytics", "materialize", "orders", "--from-collection", "tickets"], () => ({ body: envelope({ rowsRead: 5, ingested: 4, rejected: 1 }) }), false);
    expect(r.calls[0]!.body).toEqual({ fromCollection: "tickets" });
    expect(r.stdout).toContain("read 5, ingested 4, rejected 1");
    for (const extra of [[], ["--from-collection", "a", "--from-query", "b"]]) {
      const bad = await signedIn(["analytics", "materialize", "orders", ...extra], () => undefined);
      expect(bad.code).toBe(2);
      expect(bad.calls).toHaveLength(0);
    }
  });

  it("write sends a JSON array, or NDJSON from a file, with --on-error", async () => {
    const a = await signedIn(["analytics", "write", "orders", "--rows", '[{"city":"Berlin"}]', "--on-error", "reject"], () => ({ body: envelope({ ingested: 1, skipped: 0 }) }), false);
    expect(a.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders/write`, body: [{ city: "Berlin" }], query: { onError: "reject" } });
    expect(a.stdout).toContain("ingested 1, skipped 0");
    const f = tempPath("rows.ndjson");
    writeFileSync(f.path, '{"city":"Berlin"}\n{"city":"San Francisco"}\n');
    try {
      const b = await signedIn(["analytics", "write", "orders", "--rows-file", f.path], () => ({ body: envelope({ ingested: 2 }) }));
      expect(b.calls[0]!.headers["content-type"]).toContain("application/x-ndjson");
      expect(new TextDecoder().decode(b.calls[0]!.rawBody!)).toBe('{"city":"Berlin"}\n{"city":"San Francisco"}\n');
    } finally {
      f.cleanup();
    }
    for (const extra of [[], ["--rows", "[]"], ["--rows", "{"], ["--rows", "[{}]", "--rows-file", "x"], ["--rows", "[{}]", "--on-error", "maybe"]]) {
      const bad = await signedIn(["analytics", "write", "orders", ...extra], () => undefined);
      expect(bad.code, extra.join(" ")).toBe(2);
      expect(bad.calls).toHaveLength(0);
    }
  });

  it("upload sends the file as multipart with the format from the extension", async () => {
    const f = tempPath("people.csv");
    writeFileSync(f.path, "name,city\nAlice,Berlin\n");
    try {
      const r = await signedIn(["analytics", "upload", "orders", f.path, "--dry-run", "--no-header", "--delimiter", ";"], () => ({ body: envelope({ columns: [], preview: [] }) }));
      expect(r.code).toBe(0);
      expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders/upload`, query: { format: "csv", dryRun: "true", hasHeader: "false", delimiter: ";" } });
      expect(new TextDecoder().decode(r.calls[0]!.rawBody!)).toContain("Alice,Berlin");
      const bad = await signedIn(["analytics", "upload", "orders", f.path, "--format", "xml"], () => undefined);
      expect(bad.code).toBe(2);
    } finally {
      f.cleanup();
    }
    const noExt = tempPath("data");
    writeFileSync(noExt.path, "x");
    try {
      expect((await signedIn(["analytics", "upload", "orders", noExt.path], () => undefined)).code).toBe(2);
    } finally {
      noExt.cleanup();
    }
    expect((await signedIn(["analytics", "upload", "orders", "/nonexistent/none.csv"], () => undefined)).code).toBe(2);
  });

  it("download-original writes the bytes to --out", async () => {
    const out = tempPath("original.csv");
    try {
      const c = tempCredentials();
      let r;
      try {
        r = await runCli(["analytics", "download-original", "orders", "--out", out.path, "--credentials-file", c.path], (call) => {
          expect(call.path).toBe(`${BASE}/analytics/orders/upload/original`);
          return { sse: "name,city\nAlice,Berlin\n", headers: {} };
        });
      } finally {
        c.cleanup();
      }
      expect(r.code).toBe(0);
      expect(readFileSync(out.path, "utf8")).toBe("name,city\nAlice,Berlin\n");
      expect(r.stdout).toContain("Saved 23 bytes");
    } finally {
      out.cleanup();
    }
    expect((await signedIn(["analytics", "download-original", "orders"], () => undefined)).code).toBe(2);
  });
});

describe("k9o analytics rollups and schedules", () => {
  const rollup = { id: "rol_1", slug: "hourly", attestationStatus: "active", expiresAt: "2027-01-24T00:00:00.000Z" };

  it("rollups create maps every flag", async () => {
    const r = await signedIn(
      ["analytics", "rollups", "create", "orders", "--slug", "hourly", "--source", "orders-stream", "--measures", '[{"name":"n","agg":"count"}]', "--window-seconds", "3600", "--dimensions", "city,channel", "--reattest-days", "30", "--non-personal"],
      () => ({ status: 201, body: envelope(rollup) }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/analytics/orders/rollups`,
      body: { slug: "hourly", source: "orders-stream", measures: [{ name: "n", agg: "count" }], windowSeconds: 3600, dimensions: ["city", "channel"], reattestIntervalDays: 30, nonPersonal: true },
    });
    const s = await signedIn(
      ["analytics", "rollups", "create", "orders", "--slug", "h", "--source", "s", "--measures", "[{}]", "--window-seconds", "60", "--subject-field", "userId"],
      () => ({ body: envelope(rollup) }),
    );
    expect((s.calls[0]!.body as Record<string, unknown>)["subjectField"]).toBe("userId");
  });

  it("rollups create refuses bad flags before any request", async () => {
    const base = ["analytics", "rollups", "create", "orders", "--slug", "h", "--source", "s", "--measures", "[{}]", "--window-seconds", "60"];
    for (const argv of [
      [...base],
      [...base, "--non-personal", "--subject-field", "u"],
      ["analytics", "rollups", "create", "orders", "--slug", "h", "--source", "s", "--measures", "[{}]", "--window-seconds", "30", "--non-personal"],
      [...base, "--non-personal", "--reattest-days", "5"],
      ["analytics", "rollups", "create"],
      ["analytics", "rollups", "nope", "orders"],
    ]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("rollups list, delete, reattest", async () => {
    const l = await signedIn(["analytics", "rollups", "list", "orders"], () => ({ body: envelope({ rollups: [rollup] }) }), false);
    expect(l.calls[0]!.path).toBe(`${BASE}/analytics/orders/rollups`);
    expect(l.stdout).toContain("hourly");
    const d = await signedIn(["analytics", "rollups", "delete", "orders", "rol_1"], () => ({ body: envelope({ id: "rol_1", deleted: true }) }), false);
    expect(d.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/analytics/orders/rollups/rol_1` });
    const a = await signedIn(["analytics", "rollups", "reattest", "orders", "rol_1", "--reattest-days", "90"], () => ({ body: envelope(rollup) }), false);
    expect(a.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders/rollups/rol_1/reattest`, body: { reattestIntervalDays: 90 } });
    expect((await signedIn(["analytics", "rollups", "delete", "orders"], () => undefined)).code).toBe(2);
  });

  it("reattest by a non-person token is refused with exit 67 and the reason", async () => {
    const r = await signedIn(["analytics", "rollups", "reattest", "orders", "rol_1"], () => ({ status: 403, body: { code: "K9O_RBAC_DENY", message: "human only", context: { reason: "human_only" } } }), false);
    expect(r.code).toBe(67);
    expect(r.stderr).toContain("K9O_RBAC_DENY");
  });

  it("schedules create, list, delete, reattest", async () => {
    const sched = { id: "dsch_1", nextRunAt: "2026-10-27T11:00:00.000Z", expiresAt: "2027-01-24T00:00:00.000Z", attestationStatus: "active" };
    const c = await signedIn(["analytics", "schedules", "create", "orders", "--from-collection", "tickets", "--interval-seconds", "3600", "--reattest-days", "7"], () => ({ status: 201, body: envelope(sched) }), false);
    expect(c.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/analytics/orders/schedules`, body: { fromCollection: "tickets", intervalSeconds: 3600, reattestIntervalDays: 7 } });
    expect(c.stdout).toContain("Created schedule dsch_1");
    const l = await signedIn(["analytics", "schedules", "list", "orders"], () => ({ body: envelope({ schedules: [sched] }) }), false);
    expect(l.stdout).toContain("dsch_1");
    const d = await signedIn(["analytics", "schedules", "delete", "orders", "dsch_1"], () => ({ body: envelope({ id: "dsch_1", deleted: true }) }), false);
    expect(d.calls[0]!.method).toBe("DELETE");
    const a = await signedIn(["analytics", "schedules", "reattest", "orders", "dsch_1"], () => ({ body: envelope(sched) }), false);
    expect(a.calls[0]).toMatchObject({ path: `${BASE}/analytics/orders/schedules/dsch_1/reattest`, body: {} });
    for (const argv of [["analytics", "schedules", "create", "orders"], ["analytics", "schedules", "create", "orders", "--from-collection", "t", "--interval-seconds", "30"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("--help says reattest is human-only", async () => {
    const r = await runCli(["analytics", "list", "--help"], () => undefined);
    expect(r.code).toBe(0);
    expect(r.stdout.match(/HUMAN ONLY/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("k9o rollups", () => {
  const cellFrame = (id: string, payload: unknown) => `id: ${id}\nevent: cell\ndata: ${JSON.stringify({ topic: "rollup.hourly", eventType: "cell", payload, occurredAt: "2026-10-27T10:00:00.000Z", eventId: id })}\n\n`;

  it("list and read map flags to the query", async () => {
    const l = await signedIn(["rollups", "list"], () => ({ body: envelope({ rollups: [{ id: "rol_1", slug: "hourly", attestationStatus: "active" }] }) }), false);
    expect(l.calls[0]!.path).toBe(`${BASE}/rollups`);
    expect(l.stdout).toContain("hourly");
    const r = await signedIn(
      ["rollups", "read", "hourly", "--from", "2026-10-26T00:00:00Z", "--to", "2026-10-27T00:00:00Z", "--dims", "city"],
      () => ({ body: envelope({ k: 5, cells: [{ n: 9 }, { status: "suppressed", reason: "cohort_below_k" }], coverage: { complete: true } }) }),
      false,
    );
    expect(r.calls[0]).toMatchObject({ path: `${BASE}/rollups/hourly/read`, query: { from: "2026-10-26T00:00:00Z", to: "2026-10-27T00:00:00Z", dims: "city" } });
    expect(r.stdout).toContain("2 cell(s), cohort threshold k=5");
    expect(r.stdout).toContain("suppressed (cohort_below_k)");
    for (const argv of [["rollups", "read"], ["rollups", "read", "hourly", "--from", "yesterday"], ["rollups", "nope"], ["rollups", "subscribe"]]) {
      const bad = await signedIn(argv, () => undefined);
      expect(bad.code, argv.join(" ")).toBe(2);
      expect(bad.calls).toHaveLength(0);
    }
  });

  it("subscribe prints one cell per line and stops at --count", async () => {
    const r = await signedIn(["rollups", "subscribe", "hourly", "--count", "2", "--from-sequence", "4"], () => ({ sse: `retry: 5\n:ok\n\n${cellFrame("1", { n: 1 })}${cellFrame("2", { n: 2 })}` }));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).n)).toEqual([1, 2]);
    expect(r.calls[0]).toMatchObject({ path: `${BASE}/rollups/hourly/subscribe`, query: { fromSequence: "4" } });
  });

  it("subscribe prints the payload cell, suppressed cells show status and reason, and a replayed cell prints once", async () => {
    const closed = { cellKey: "k1", bucket: "2026-10-27T09:00:00.000Z", dims: { city: "Berlin" }, measures: { orders: 12 }, final: true };
    const hidden = { cellKey: "k2", bucket: "2026-10-27T09:00:00.000Z", dims: {}, status: "suppressed", reason: "cohort_below_k" };
    const sse = `${cellFrame("e1", closed)}${cellFrame("e1", closed)}${cellFrame("e2", hidden)}`;
    const human = await signedIn(["rollups", "subscribe", "hourly", "--count", "2"], () => ({ sse }), false);
    expect(human.code).toBe(0);
    const lines = human.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(closed);
    expect(lines[1]).toContain("status=suppressed");
    expect(lines[1]).toContain("reason=cohort_below_k");
    const json = await signedIn(["rollups", "subscribe", "hourly", "--count", "2", "--output", "json"], () => ({ sse }), false);
    const parsed = json.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(parsed).toEqual([closed, hidden]);
  });

  it("subscribe surfaces a 429 and exits non-zero", async () => {
    const r = await signedIn(["rollups", "subscribe", "hourly"], () => ({ status: 429, body: { code: "K9O_SUBSCRIPTION_LIMIT_EXCEEDED", message: "too many", context: {} } }), false);
    expect(r.code).toBe(72);
    expect(r.stderr).toContain("K9O_SUBSCRIPTION_LIMIT_EXCEEDED");
  });
});

describe("k9o audit tail", () => {
  // The handler runs again on every reconnect (`retry: 5`). Scheduling the interrupt on each call would leave a dozen
  // SIGINT timers pending when the test ends, and they would abort whichever test is running 150 ms later (the stream
  // tail test, in the full suite). One timer per test, and the test clears it when done.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    timer ??= setTimeout(() => process.emit("SIGINT"), 150);
  };
  afterEach(() => {
    clearTimeout(timer);
    timer = undefined;
  });
  // The gateway's frame: the audit event sits under `payload`; `eventId` is the frame's own id.
  const frame = (id: string, type: string, frameId = `fr_${id}`) =>
    `id: ${frameId}\ndata: ${JSON.stringify({ topic: "audit.project.x", eventType: type, payload: { auditEventId: id, type, actorType: "user", occurredAt: "2026-10-27T10:00:00.000Z", outcome: "success" }, occurredAt: "2026-10-27T10:00:00.000Z", eventId: frameId })}\n\n`;

  it("streams one JSON line per event, filters by --type, and stops cleanly on SIGINT", async () => {
    const r = await signedIn(["audit", "tail", "--type", "data.write.access.insert", "--type", "auth.signin", "--json"], () => {
      interrupt();
      return { sse: `retry: 5\n:ok\n\n${frame("evt_1", "data.write.access.insert")}${frame("evt_2", "other.type")}${frame("evt_3", "auth.signin")}` };
    }, false);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.auditEventId)).toEqual(["evt_1", "evt_3"]);
    expect(lines[0]).toEqual({ auditEventId: "evt_1", type: "data.write.access.insert", actorType: "user", occurredAt: "2026-10-27T10:00:00.000Z", outcome: "success", eventId: "fr_evt_1" });
    expect(r.calls[0]!.path).toBe(`${BASE}/realtime/subscribe`);
    expect(r.calls[0]!.query["topic"]).toBe("audit.project.*");
  });

  it("prints a resent event once", async () => {
    const r = await signedIn(["audit", "tail", "--json"], () => {
      interrupt();
      return { sse: `${frame("evt_1", "a.b")}${frame("evt_1", "a.b", "fr_resent")}${frame("evt_2", "a.b")}` };
    }, false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).auditEventId)).toEqual(["evt_1", "evt_2"]);
  });

  it("a single --type is filtered by the server topic; human output is one line per event", async () => {
    const r = await signedIn(["audit", "tail", "--type", "auth.signin"], () => {
      interrupt();
      return { sse: frame("evt_9", "auth.signin") };
    }, false);
    expect(r.calls[0]!.query["topic"]).toBe("audit.project.auth.signin");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toContain("auth.signin");
    expect(r.stdout).toContain("evt_9");
    expect(r.stdout).toContain("frame=fr_evt_9");
  });

  describe("replay", () => {
    const page = { events: [{ auditEventId: "evt_5", type: "auth.signin", actorType: "user", occurredAt: "2026-10-27T10:00:00.000Z", outcome: "success", sequence: 7 }], nextCursor: 8, hasMore: true };

    it("--from-sequence and --limit go to the replay route and the typed page is printed", async () => {
      const r = await signedIn(["audit", "replay", "--from-sequence", "0", "--limit", "2"], () => ({ body: envelope(page) }));
      expect(r.code).toBe(0);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/realtime/replay`, body: { topic: "audit.project.*", fromSequence: "0", limit: 2 } });
      const out = JSON.parse(r.stdout);
      expect(out.data.hasMore).toBe(true);
      expect(out.data.nextCursor).toBe(8);
      expect(out.data.events[0]).toMatchObject({ auditEventId: "evt_5", sequence: "7", outcome: "success" });
      const h = await signedIn(["audit", "replay", "--from-sequence", "0"], () => ({ body: envelope(page) }), false);
      expect(h.stdout).toContain("1 event(s), hasMore=true, nextCursor=8");
      expect(h.stdout).toContain("evt_5");
    });

    it("--after-audit-event-id wins and is sent alone", async () => {
      const r = await signedIn(["audit", "replay", "--after-audit-event-id", "evt_4"], () => ({ body: envelope({ events: [], nextCursor: null, hasMore: false }) }), false);
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ topic: "audit.project.*", afterAuditEventId: "evt_4", limit: 1000 });
      expect(r.stdout).toContain("0 event(s), hasMore=false");
    });

    it("bad flags exit 2 before any request", async () => {
      const cases = [["audit", "replay"], ["audit", "replay", "--from-sequence", "x"], ["audit", "replay", "--from-sequence", "1", "--after-audit-event-id", "evt_1"], ["audit", "replay", "--from-sequence", "1", "--limit", "0"], ["audit", "replay", "--from-sequence", "1", "--limit", "10001"]];
      for (const argv of cases) {
        const r = await signedIn(argv, () => undefined);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.calls).toHaveLength(0);
      }
    });

    it("an unknown event id (400 K9O_INVALID_CURSOR) and a 403 map to their exit codes", async () => {
      const bad = await signedIn(["audit", "replay", "--after-audit-event-id", "evt_nope"], () => ({ status: 400, body: { code: "K9O_INVALID_CURSOR", message: "unknown event", context: {} } }), false);
      expect(bad.code).toBe(70);
      expect(bad.stderr).toContain("K9O_INVALID_CURSOR");
      const denied = await signedIn(["audit", "replay", "--from-sequence", "0"], () => ({ status: 403, body: { code: "K9O_RBAC_DENY", message: "no", context: {} } }), false);
      expect(denied.code).toBe(67);
    });

    it("a malformed event id exits 2 without a request", async () => {
      const r = await signedIn(["audit", "replay", "--after-audit-event-id", "not an id"], () => undefined, false);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    });
  });

  it("a 400 from the gateway exits non-zero and renders the error", async () => {
    const r = await signedIn(["audit", "tail"], () => ({ status: 400, body: { code: "K9O_INVALID_FIELD_VALUE", message: "unknown subscription topic", context: {} } }), false);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown subscription topic");
  });

  it("refuses wildcard types before any request", async () => {
    const r = await signedIn(["audit", "tail", "--type", "auth.*"], () => undefined);
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it("recent fetches once from the audit log", async () => {
    const r = await signedIn(["audit", "recent", "--since-minutes", "10", "--limit", "5"], () => ({ body: envelope([], { cursor: { next: null } }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/audit-log`);
    expect(r.calls[0]!.query["limit"]).toBe("5");
    expect(r.stdout).toContain("No audit events in the last 10 minute(s).");
  });
});

describe("completion lists the new groups", () => {
  it("bash completion mentions them", async () => {
    const r = await runCli(["completion", "bash"], () => undefined);
    for (const w of ["keys", "crypto", "encrypt", "rewrap", "analytics", "datasets", "rollups", "download-original", "subscribe", "recent", "replay"]) expect(r.stdout).toContain(w);
  });
});
