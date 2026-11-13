/** `k9o approvals`, `k9o approval-policy` and `k9o schema collections` against a fake gateway. */

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

const pending = {
  id: "apr_1", status: "pending_approval", collection: "orders", operation: "update", makerId: "usr_1",
  proposedPayload: { amount: 5 }, targetRecordId: "rec_1", approverId: null, decidedAt: null, decisionReason: null,
  createdAt: "2026-10-26T10:00:00.000Z", expiresAt: null,
};
const BASE = "/@portal";

describe("k9o approvals", () => {
  it("list sends status and limit", async () => {
    const r = await signedIn(["approvals", "list", "--status", "approved", "--limit", "5"], () => ({ body: envelope([pending]) }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BASE}/pending-approvals`]);
    expect(r.calls[0]!.query).toEqual({ status: "approved", limit: "5" });
  });

  it("list sends the cursor and prints the next one; the last page prints none", async () => {
    const next = "eyJ2IjoxLCJwIjoicHJval8xIn0";
    const first = await signedIn(["approvals", "list", "--limit", "1"], () => ({ body: envelope([pending], { cursor: { next } }) }), false);
    expect(first.code).toBe(0);
    expect(first.calls[0]!.query).toEqual({ limit: "1" });
    expect(first.stdout).toContain(`More: --cursor ${next}`);
    const last = await signedIn(["approvals", "list", "--limit", "1", "--cursor", next], () => ({ body: envelope([pending], { cursor: { next: null } }) }), false);
    expect(last.calls[0]!.query).toEqual({ limit: "1", cursor: next });
    expect(last.stdout).not.toContain("More:");
  });

  it("list shows an invalid cursor as K9O_INVALID_CURSOR and refuses a bare --cursor", async () => {
    const body = { code: "K9O_INVALID_CURSOR", message: "Cursor is malformed; omit it to start from the newest pending change", context: {}, recommendation: null };
    const bad = await signedIn(["approvals", "list", "--cursor", "abc!"], () => ({ status: 400, body }), false);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("K9O_INVALID_CURSOR");
    const bare = await signedIn(["approvals", "list", "--cursor"], () => undefined);
    expect(bare.code).toBe(2);
    expect(bare.calls).toHaveLength(0);
  });

  it("list refuses a bad status or limit before any request", async () => {
    for (const argv of [["approvals", "list", "--status", "queued"], ["approvals", "list", "--limit", "0"], ["approvals", "list", "--limit", "201"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("get reads one change; human output names the status", async () => {
    const r = await signedIn(["approvals", "get", "apr_1"], () => ({ body: envelope(pending) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/pending-approvals/apr_1`);
    expect(r.stdout).toContain("pending_approval");
  });

  it("approve posts the reason and says when more approvers are needed", async () => {
    const r = await signedIn(["approvals", "approve", "apr_1", "--reason", "ok"], () => ({ body: envelope(pending) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/apr_1/approve`, body: { reason: "ok" } });
    expect(r.stdout).toContain("more approvers are needed");
    const done = await signedIn(["approvals", "approve", "apr_1"], () => ({ body: envelope({ ...pending, status: "redeemed" }) }), false);
    expect(done.stdout).toContain("Approved.");
    expect(done.calls[0]!.body).toEqual({});
  });

  it("reject needs a reason", async () => {
    const none = await signedIn(["approvals", "reject", "apr_1"], () => undefined);
    expect(none.code).toBe(2);
    expect(none.calls).toHaveLength(0);
    const r = await signedIn(["approvals", "reject", "apr_1", "--reason", "duplicate"], () => ({ body: envelope({ ...pending, status: "rejected" }) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/apr_1/reject`, body: { reason: "duplicate" } });
  });

  it("bulk sends the criteria and prints the affected ids", async () => {
    const result = { attestationId: "apr_b", action: "reject", affectedCount: 1, affectedIds: ["apr_1"], reason: "stale" };
    const r = await signedIn(["approvals", "bulk", "--action", "reject", "--reason", "stale", "--criteria", '{"eq":["change.table","orders"]}'], () => ({ body: envelope(result) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/bulk`, body: { action: "reject", reason: "stale", criteria: { eq: ["change.table", "orders"] } } });
    expect(r.stdout).toContain("apr_1");
    expect(r.stdout).not.toContain("failed");
  });

  it("bulk prints the failed rows (HTTP 200) and stays quiet when failed is empty", async () => {
    const argv = ["approvals", "bulk", "--action", "approve", "--criteria", '{"eq":["change.table","orders"]}'];
    const withFailure = { attestationId: "apr_b", action: "approve", affectedCount: 1, affectedIds: ["apr_A"], failed: [{ id: "apr_B", code: "K9O_STATE_CONFLICT", reason: "Pending change 'apr_B' was decided concurrently" }], reason: null };
    const r = await signedIn(argv, () => ({ body: envelope(withFailure) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/bulk`, body: { action: "approve", criteria: { eq: ["change.table", "orders"] } } });
    expect(r.stdout).toContain("1 change failed and was not decided:");
    expect(r.stdout).toContain("apr_B  K9O_STATE_CONFLICT  Pending change 'apr_B' was decided concurrently");
    const json = await signedIn(argv, () => ({ body: envelope(withFailure) }));
    expect(JSON.parse(json.stdout).data.failed).toHaveLength(1);
    const none = await signedIn(argv, () => ({ body: envelope({ ...withFailure, affectedCount: 0, affectedIds: [], failed: [] }) }), false);
    expect(none.stdout).not.toContain("failed and");
  });

  it("bulk refuses bad input before any request", async () => {
    const crit = '{"eq":["change.table","orders"]}';
    const cases = [
      ["approvals", "bulk", "--criteria", crit],
      ["approvals", "bulk", "--action", "delete", "--criteria", crit],
      ["approvals", "bulk", "--action", "approve"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "nope"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "[1]"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "null"],
      ["approvals", "bulk", "--action", "reject", "--criteria", crit],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  const comment = { id: "acm_1", caseId: "apr_1", authorId: "usr_2", visibility: "approvers_only", body: "Does this match the invoice?", createdAt: "2026-11-13T10:00:00.000Z" };

  it("comment posts body and visibility to the comments route and prints the comment", async () => {
    const argv = ["approvals", "comment", "apr_1", "--body", comment.body, "--visibility", "approvers_only"];
    const r = await signedIn(argv, () => ({ status: 201, body: envelope(comment) }), false);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/apr_1/comments`, body: { body: comment.body, visibility: "approvers_only" } });
    expect(r.stdout).toContain("Comment posted on apr_1.");
    expect(r.stdout).toContain("acm_1");
    expect(r.stdout).toContain("approvers_only");
    expect(r.stdout).toContain("Does this match the invoice?");
    const json = await signedIn(argv, () => ({ status: 201, body: envelope(comment) }));
    expect(JSON.parse(json.stdout).data).toEqual(comment);
  });

  it("comment refuses bad input before any request: no silent visibility default", async () => {
    const cases = [
      ["approvals", "comment", "--body", "hi", "--visibility", "everyone"],
      ["approvals", "comment", "apr_1", "--visibility", "everyone"],
      ["approvals", "comment", "apr_1", "--body", "--visibility", "everyone"],
      ["approvals", "comment", "apr_1", "--body", "", "--visibility", "everyone"],
      ["approvals", "comment", "apr_1", "--body", "x".repeat(4001), "--visibility", "everyone"],
      ["approvals", "comment", "apr_1", "--body", "hi"],
      ["approvals", "comment", "apr_1", "--body", "hi", "--visibility"],
      ["approvals", "comment", "apr_1", "--body", "hi", "--visibility", "private"],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("comment accepts 4000 characters and maps the API errors to their codes", async () => {
    const ok = await signedIn(["approvals", "comment", "apr_1", "--body", "x".repeat(4000), "--visibility", "everyone"], () => ({ status: 201, body: envelope(comment) }));
    expect(ok.code).toBe(0);
    for (const [status, code] of [[403, "K9O_APPROVAL_COMMENT_NOT_ELIGIBLE"], [409, "K9O_APPROVAL_COMMENT_CLOSED"], [403, "K9O_RBAC_DENY"], [404, "K9O_NOT_FOUND"]] as const) {
      const r = await signedIn(["approvals", "comment", "apr_1", "--body", "hi", "--visibility", "everyone"], () => ({ status, body: { code, message: "refused", context: {}, recommendation: null } }), false);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(code);
    }
  });

  it("comments lists oldest first with limit and cursor, and prints the next cursor", async () => {
    const second = { ...comment, id: "acm_2", visibility: "everyone", body: "line one\nline two" };
    const page = { data: [comment, second], nextCursor: "Y3Vyc29y", meta: {} };
    const first = await signedIn(["approvals", "comments", "apr_1", "--limit", "2"], () => ({ body: page }), false);
    expect(first.code).toBe(0);
    expect(first.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/pending-approvals/apr_1/comments` });
    expect(first.calls[0]!.query).toEqual({ limit: "2" });
    expect(first.stdout).toContain("acm_1");
    expect(first.stdout.indexOf("acm_1")).toBeLessThan(first.stdout.indexOf("acm_2"));
    expect(first.stdout).toContain("    line two");
    expect(first.stdout).toContain("More: --cursor Y3Vyc29y");
    const last = await signedIn(["approvals", "comments", "apr_1", "--cursor", "Y3Vyc29y"], () => ({ body: { data: [second], nextCursor: null, meta: {} } }), false);
    expect(last.calls[0]!.query).toEqual({ cursor: "Y3Vyc29y" });
    expect(last.stdout).not.toContain("More:");
    const json = await signedIn(["approvals", "comments", "apr_1"], () => ({ body: page }));
    expect(JSON.parse(json.stdout)).toMatchObject({ data: [{ id: "acm_1" }, { id: "acm_2" }], nextCursor: "Y3Vyc29y" });
  });

  it("comments says so when there are none and strips terminal control characters from a body", async () => {
    const empty = await signedIn(["approvals", "comments", "apr_1"], () => ({ body: { data: [], nextCursor: null, meta: {} } }), false);
    expect(empty.stdout).toContain("No comments.");
    const esc = await signedIn(["approvals", "comments", "apr_1"], () => ({ body: { data: [{ ...comment, body: "a\u001b[31mred" }], nextCursor: null, meta: {} } }), false);
    expect(esc.stdout).not.toContain("\u001b");
    expect(esc.stdout).toContain("a[31mred");
  });

  it("comments refuses a missing id, a bad limit and a bare --cursor before any request", async () => {
    for (const argv of [["approvals", "comments"], ["approvals", "comments", "apr_1", "--limit", "0"], ["approvals", "comments", "apr_1", "--limit", "201"], ["approvals", "comments", "apr_1", "--cursor"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("an unknown subcommand is a usage error", async () => {
    const r = await signedIn(["approvals", "nope"], () => undefined);
    expect(r.code).toBe(2);
  });
});

describe("k9o approval-policy", () => {
  const policy = { id: "apo_1", collection: "orders", operation: "update", predicate: { gt: ["change.row.amount", 1000] }, action: "queue", authoredBy: "usr_1", createdAt: "2026-10-26T10:00:00.000Z" };

  it("list, create and delete use the policy routes", async () => {
    const list = await signedIn(["approval-policy", "list"], () => ({ body: envelope([policy]) }));
    expect(list.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/approval-policies` });
    const create = await signedIn(
      ["approval-policy", "create", "--collection", "orders", "--operation", "update", "--action", "queue", "--predicate", JSON.stringify(policy.predicate)],
      () => ({ status: 201, body: envelope(policy) }),
    );
    expect(create.code).toBe(0);
    expect(create.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/approval-policies`, body: { collection: "orders", operation: "update", action: "queue", predicate: policy.predicate } });
    const del = await signedIn(["approval-policy", "delete", "apo_1"], () => ({ body: envelope({ id: "apo_1" }) }), false);
    expect(del.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/approval-policies/apo_1` });
    expect(del.stdout).toContain("apo_1");
  });

  it("create refuses bad flags before any request", async () => {
    const ok = ["--collection", "orders", "--operation", "update", "--action", "queue", "--predicate", "{}"];
    const swap = (flag: string, value: string) => {
      const a = [...ok];
      a[a.indexOf(flag) + 1] = value;
      return ["approval-policy", "create", ...a];
    };
    const cases = [
      swap("--collection", "1bad"),
      swap("--operation", "upsert"),
      swap("--action", "block"),
      swap("--predicate", "[]"),
      swap("--predicate", "oops"),
      ["approval-policy", "create", "--collection", "orders", "--operation", "update", "--action", "queue"],
      ["approval-policy", "delete"],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });
});

describe("k9o schema collections", () => {
  const row = { name: "orders", rowCount: 120, rowCountIsExact: true, columnCount: 8, indexCount: 3, lastMigrationSlug: "add_orders", lastMigrationAppliedAt: null };

  it("sends limit and cursor and prints the next cursor", async () => {
    const meta = { cursor: { next: "b3JkZXJz", totalCount: null, countMethod: "none" } };
    const r = await signedIn(["schema", "collections", "--limit", "1", "--cursor", "abc"], () => ({ body: envelope([row], meta) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/schema/collections`);
    expect(r.calls[0]!.query).toEqual({ limit: "1", cursor: "abc" });
    expect(r.stdout).toContain("orders");
    expect(r.stdout).toContain("--cursor b3JkZXJz");
  });

  it("refuses a bad --limit and an unknown subcommand", async () => {
    const bad = await signedIn(["schema", "collections", "--limit", "0"], () => undefined);
    expect(bad.code).toBe(2);
    expect(bad.calls).toHaveLength(0);
    expect((await signedIn(["schema", "nope"], () => undefined)).code).toBe(2);
  });
});
