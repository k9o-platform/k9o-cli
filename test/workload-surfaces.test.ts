/** `k9o data`, `k9o function trigger`, `k9o schedule` and `k9o end-user` against a fake gateway. */

import { describe, expect, it } from "bun:test";
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
const queued = {
  id: "apr_5oLshD2MVT27", status: "pending_approval", collection: "conformance_kv", operation: "insert", makerId: "usr_1",
  proposedPayload: { id: "p-1", val: "x" }, targetRecordId: null,
};
const queuedMeta = { approval: { status: "pending_approval" } };

describe("k9o data", () => {
  it("insert --require-approval sends the flag and prints the queued change", async () => {
    const r = await signedIn(["data", "insert", "conformance_kv", "--data", '{"id":"p-1","val":"x"}', "--require-approval"], () => ({ status: 202, body: envelope(queued, queuedMeta) }), false);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/data/conformance_kv`, query: { requireApproval: "true" }, body: { id: "p-1", val: "x" } });
    expect(r.stdout).toContain("Queued for approval: apr_5oLshD2MVT27");
    expect(r.stdout).toContain("k9o approvals approve apr_5oLshD2MVT27");
  });

  it("insert without the flag sends no query; --output json is the wire envelope", async () => {
    const r = await signedIn(["data", "insert", "conformance_kv", "--data", '{"id":"p-1"}'], () => ({ status: 201, body: envelope({ id: "p-1" }) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.query).toEqual({});
    expect(JSON.parse(r.stdout)).toEqual({ data: { id: "p-1" }, meta: {} });
  });

  it("an auto-approved write prints the applied record, not a queue message", async () => {
    const r = await signedIn(["data", "insert", "conformance_kv", "--data", '{"id":"p-1"}', "--require-approval"], () => ({ status: 201, body: envelope({ id: "p-1" }) }), false);
    expect(r.stdout).toContain("Inserted p-1");
    expect(r.stdout).not.toContain("Queued");
  });

  it("update and delete send PATCH/DELETE on the id with the flag", async () => {
    const u = await signedIn(["data", "update", "conformance_kv", "p-1", "--data", '{"val":"y"}', "--require-approval"], () => ({ status: 202, body: envelope({ ...queued, operation: "update", targetRecordId: "p-1" }, queuedMeta) }), false);
    expect(u.calls[0]).toMatchObject({ method: "PATCH", path: `${BASE}/data/conformance_kv/p-1`, query: { requireApproval: "true" }, body: { val: "y" } });
    expect(u.stdout).toContain("update on conformance_kv, p-1");
    const d = await signedIn(["data", "delete", "conformance_kv", "p-1", "--require-approval"], () => ({ status: 202, body: envelope({ ...queued, operation: "delete", targetRecordId: "p-1", proposedPayload: {} }, queuedMeta) }));
    expect(d.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/data/conformance_kv/p-1`, query: { requireApproval: "true" } });
    const plain = await signedIn(["data", "delete", "conformance_kv", "p-1"], () => ({ body: envelope({ id: "p-1" }) }));
    expect(plain.calls[0]!.query).toEqual({});
  });

  it("--require-approval does not swallow the next argument", async () => {
    const r = await signedIn(["data", "delete", "--require-approval", "conformance_kv", "p-1"], () => ({ status: 202, body: envelope(queued, queuedMeta) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/data/conformance_kv/p-1`);
  });

  it("refuses bad input before any request", async () => {
    const cases = [
      ["data", "insert"],
      ["data", "insert", "c"],
      ["data", "insert", "c", "--data", "nope"],
      ["data", "insert", "c", "--data", "[1]"],
      ["data", "update", "c", "--data", "{}"],
      ["data", "update", "c", "p-1"],
      ["data", "delete", "c"],
      ["data", "delete", "c", "p-1", "--data", "{}"],
      ["data", "upsert", "c"],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a gateway refusal exits non-zero", async () => {
    const r = await signedIn(["data", "insert", "c", "--data", "{}", "--require-approval"], () => ({ status: 403, body: { code: "K9O_RBAC_DENY", message: "no", context: {}, recommendation: null } }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("K9O_RBAC_DENY");
  });
});

const TRG = "0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11";
const trigger = { id: TRG, functionName: "notify", collection: "orders", events: ["insert", "update"], filter: null, enabled: true, logOkInvocations: false, createdAt: "2026-10-26T17:59:56.815Z" };

describe("k9o function trigger", () => {
  it("list: GET and the empty message", async () => {
    const r = await signedIn(["function", "trigger", "list", "notify"], () => ({ body: envelope([]) }), false);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BASE}/functions/notify/triggers`]);
    expect(r.stdout).toContain("No triggers on notify.");
  });

  it("create: POST with collection, events, filter, disabled and logging", async () => {
    const r = await signedIn(
      ["function", "trigger", "create", "notify", "--collection", "orders", "--events", "insert,update", "--filter", '{"eq":["resource.status","paid"]}', "--disabled", "--log-ok-invocations"],
      () => ({ status: 201, body: envelope({ ...trigger, enabled: false }) }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/functions/notify/triggers`,
      body: { collection: "orders", events: ["insert", "update"], filter: { eq: ["resource.status", "paid"] }, enabled: false, logOkInvocations: true },
    });
  });

  it("create: refuses missing or invalid input before any request", async () => {
    const cases = [
      ["function", "trigger", "create"],
      ["function", "trigger", "create", "notify", "--events", "insert"],
      ["function", "trigger", "create", "notify", "--collection", "orders"],
      ["function", "trigger", "create", "notify", "--collection", "orders", "--events", "truncate"],
      ["function", "trigger", "create", "notify", "--collection", "orders", "--events", "insert,update,delete,upsert,insert"],
      ["function", "trigger", "create", "notify", "--collection", "orders", "--events", "insert", "--filter", "[1]"],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("update: PATCH with the given fields only; --clear-filter sends null", async () => {
    const r = await signedIn(["function", "trigger", "update", "notify", TRG, "--disable", "--clear-filter", "--no-log-ok-invocations"], () => ({ body: envelope(trigger) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "PATCH", path: `${BASE}/functions/notify/triggers/${TRG}`, body: { enabled: false, filter: null, logOkInvocations: false } });
    const e = await signedIn(["function", "trigger", "update", "notify", TRG, "--events", "delete", "--enable"], () => ({ body: envelope(trigger) }));
    expect(e.calls[0]!.body).toEqual({ events: ["delete"], enabled: true });
  });

  it("update: needs a field and refuses contradictory switches", async () => {
    for (const argv of [
      ["function", "trigger", "update", "notify", TRG],
      ["function", "trigger", "update", "notify"],
      ["function", "trigger", "update", "notify", TRG, "--enable", "--disable"],
      ["function", "trigger", "update", "notify", TRG, "--filter", "{}", "--clear-filter"],
    ]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("delete: DELETE, 204 with no body; json output has null data", async () => {
    const r = await signedIn(["function", "trigger", "delete", "notify", TRG], () => ({ status: 204 }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/functions/notify/triggers/${TRG}` });
    expect(JSON.parse(r.stdout)).toEqual({ data: null, meta: {} });
    const human = await signedIn(["function", "trigger", "delete", "notify", TRG], () => ({ status: 204 }), false);
    expect(human.stdout).toContain(`Deleted trigger ${TRG}`);
  });

  it("help and unknown subcommands", async () => {
    const h = await signedIn(["function", "trigger", "--help"], () => undefined, false);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("k9o function trigger");
    expect((await signedIn(["function", "trigger", "nope"], () => undefined)).code).toBe(2);
    expect((await signedIn(["function", "trigger"], () => undefined, false)).code).toBe(2);
  });
});

const SID = "5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01";
const schedule = {
  id: SID, functionName: "nightly", scheduleExpression: "0 0 * * *", scheduleTimezone: "UTC", catchupPolicy: "skip", collection: null,
  enabled: true, status: "active", logOkInvocations: false, createdAt: "2026-10-26T17:59:56.815Z", lastInvocationAt: null, nextInvocationAt: null,
};

describe("k9o schedule", () => {
  it("list sends function_name and paging, prints the next cursor", async () => {
    const r = await signedIn(["schedule", "list", "--status", "active", "--function", "nightly", "--limit", "2", "--cursor", "abc"], () => ({ body: envelope([schedule], { cursor: { next: "c2" } }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/forge/schedules`, query: { status: "active", function_name: "nightly", limit: "2", cursor: "abc" } });
    expect(r.stdout).toContain("--cursor c2");
    const empty = await signedIn(["schedule", "list", "--limit", "2"], () => ({ body: envelope([], { cursor: { next: null } }) }), false);
    expect(empty.stdout).toContain("No schedules.");
  });

  it("list refuses bad flags", async () => {
    for (const argv of [["schedule", "list", "--status", "x"], ["schedule", "list", "--limit", "0"], ["schedule", "list", "--limit", "201"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("get", async () => {
    const r = await signedIn(["schedule", "get", SID], () => ({ body: envelope(schedule) }), false);
    expect(r.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/forge/schedules/${SID}` });
    expect(r.stdout).toContain("0 0 * * * UTC");
  });

  it("create: POST camelCase body", async () => {
    const r = await signedIn(
      ["schedule", "create", "--function", "nightly", "--cron", "@daily", "--timezone", "Europe/Berlin", "--catchup", "run_once", "--collection", "orders", "--disabled", "--log-ok-invocations"],
      () => ({ status: 201, body: envelope(schedule) }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/forge/schedules`,
      body: { functionName: "nightly", scheduleExpression: "@daily", scheduleTimezone: "Europe/Berlin", catchupPolicy: "run_once", collection: "orders", enabled: false, logOkInvocations: true },
    });
  });

  it("create: refuses missing input; a tier gate is reported with its code", async () => {
    for (const argv of [["schedule", "create"], ["schedule", "create", "--function", "f"], ["schedule", "create", "--cron", "@daily"], ["schedule", "create", "--function", "f", "--cron", "@daily", "--catchup", "all"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    const gated = await signedIn(["schedule", "create", "--function", "f", "--cron", "* * * * *"], () => ({ status: 403, body: { code: "K9O_TIER_FEATURE_GATED", message: "gated", context: {}, recommendation: null } }));
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain("K9O_TIER_FEATURE_GATED");
  });

  it("update: PATCH with status/cron; needs a field", async () => {
    const r = await signedIn(["schedule", "update", SID, "--status", "paused", "--cron", "0 3 * * *", "--no-log-ok-invocations"], () => ({ body: envelope({ ...schedule, status: "paused" }) }));
    expect(r.calls[0]).toMatchObject({ method: "PATCH", path: `${BASE}/forge/schedules/${SID}`, body: { status: "paused", scheduleExpression: "0 3 * * *", logOkInvocations: false } });
    for (const argv of [["schedule", "update", SID], ["schedule", "update", SID, "--status", "gone"], ["schedule", "update"]]) {
      const bad = await signedIn(argv, () => undefined);
      expect(bad.code).toBe(2);
      expect(bad.calls).toHaveLength(0);
    }
  });

  it("delete: 204", async () => {
    const r = await signedIn(["schedule", "delete", SID], () => ({ status: 204 }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/forge/schedules/${SID}` });
    expect(JSON.parse(r.stdout).data).toBeNull();
  });

  it("runs and run-now", async () => {
    const runs = await signedIn(["schedule", "runs", SID, "--limit", "5", "--cursor", "c1"], () => ({ body: envelope([], { cursor: { next: null } }) }), false);
    expect(runs.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/forge/schedules/${SID}/runs`, query: { limit: "5", cursor: "c1" } });
    expect(runs.stdout).toContain("No runs.");
    const now = await signedIn(["schedule", "run-now", SID], () => ({ status: 202, body: envelope({ accepted: true }) }));
    expect(now.code).toBe(0);
    expect(now.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/forge/schedules/${SID}/run-now` });
    expect(JSON.parse(now.stdout).data).toEqual({ accepted: true });
  });
});

const grant = { id: "eurg_AbCdEf123456", endUserId: "eu_YmGE3Z6nkv5i", role: "billing-manager", grantedAt: "2026-10-26T17:59:56.815Z", grantedBy: "usr_1" };

describe("k9o end-user", () => {
  it("role-grant list unwraps the grants array and filters by --end-user", async () => {
    const empty = await signedIn(["end-user", "role-grant", "list"], () => ({ body: envelope({ grants: [] }) }), false);
    expect(empty.code).toBe(0);
    expect(empty.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/end-user-role-grants`, query: {} });
    expect(empty.stdout).toContain("No role grants.");
    const one = await signedIn(["end-user", "role-grant", "list", "--end-user", "eu_YmGE3Z6nkv5i"], () => ({ body: envelope({ grants: [grant] }) }));
    expect(one.calls[0]!.query).toEqual({ endUserId: "eu_YmGE3Z6nkv5i" });
    expect(JSON.parse(one.stdout).data).toEqual([grant]);
  });

  it("role-grant grant posts the pair", async () => {
    const r = await signedIn(["end-user", "role-grant", "grant", "--end-user", "eu_YmGE3Z6nkv5i", "--role", "billing-manager"], () => ({ body: envelope({ grant }) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/end-user-role-grants`, body: { endUserId: "eu_YmGE3Z6nkv5i", role: "billing-manager" } });
    expect(r.stdout).toContain("eurg_AbCdEf123456");
  });

  it("role-grant grant refuses missing flags", async () => {
    for (const argv of [["end-user", "role-grant", "grant"], ["end-user", "role-grant", "grant", "--role", "r"], ["end-user", "role-grant", "grant", "--end-user", "eu_1"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("role-grant revoke prints revoked and revoked: false", async () => {
    const ok = await signedIn(["end-user", "role-grant", "revoke", "eurg_AbCdEf123456"], () => ({ body: envelope({ revoked: true, revokedAt: "2026-10-26T18:00:00.000Z" }) }), false);
    expect(ok.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/end-user-role-grants/eurg_AbCdEf123456` });
    expect(ok.stdout).toContain("Revoked eurg_AbCdEf123456");
    const none = await signedIn(["end-user", "role-grant", "revoke", "eurg_nope"], () => ({ body: envelope({ revoked: false, revokedAt: null }) }), false);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("revoked: false");
    expect((await signedIn(["end-user", "role-grant", "revoke"], () => undefined)).code).toBe(2);
  });

  it("list and get", async () => {
    const user = { id: "eu_1", email: "a@b.test", emailVerifiedAt: null, status: "active", createdAt: "2026-10-09T12:15:13.430Z", lastSigninAt: null, signInMethods: ["password"], region: null };
    const l = await signedIn(["end-user", "list", "--status", "all", "--q", "a", "--limit", "5"], () => ({ body: envelope([user], { cursor: { next: "n" } }) }), false);
    expect(l.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/end-users`, query: { status: "all", q: "a", limit: "5" } });
    expect(l.stdout).toContain("--cursor n");
    const g = await signedIn(["end-user", "get", "eu_1"], () => ({ body: envelope(user) }), false);
    expect(g.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/end-users/eu_1` });
    expect((await signedIn(["end-user", "list", "--status", "x"], () => undefined)).code).toBe(2);
  });

  it("unknown subcommands", async () => {
    expect((await signedIn(["end-user", "nope"], () => undefined)).code).toBe(2);
    expect((await signedIn(["end-user", "role-grant", "nope"], () => undefined)).code).toBe(2);
    expect((await signedIn(["end-user", "role-grant"], () => undefined)).code).toBe(2);
  });
});
