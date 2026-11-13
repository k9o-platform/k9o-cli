/** `k9o custody status` against a fake gateway. */

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

const platform = { mode: "PLATFORM_MANAGED", attached: false, provider: null, lastJob: null };
const hyok = {
  mode: "HYOK", attached: true, provider: "hsm", lastJob: null,
  hsm: { vendor: "aws-cloudhsm", clusterId: "cluster-1234567890abcdef", region: "de01", attestation: { status: null, verifiedAt: null }, keys: null },
};

describe("k9o custody status", () => {
  it("prints the platform answer", async () => {
    const r = await signedIn(["custody", "status"], () => ({ body: envelope(platform) }), false);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /@portal/custody/status"]);
    expect(r.stdout).toContain("Custody mode: PLATFORM_MANAGED");
    expect(r.stdout).toContain("Attached: no");
    expect(r.stdout).not.toContain("HSM");
  });

  it("prints the HSM vendor, cluster and region", async () => {
    const r = await signedIn(["custody", "status"], () => ({ body: envelope(hyok) }), false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HSM vendor: aws-cloudhsm");
    expect(r.stdout).toContain("HSM cluster: cluster-1234567890abcdef");
    expect(r.stdout).toContain("HSM region: de01");
  });

  it("--output json prints the data", async () => {
    const r = await signedIn(["custody", "status"], () => ({ body: envelope(platform) }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data.mode).toBe("PLATFORM_MANAGED");
  });

  it("reports a 403 and rejects an unknown subcommand", async () => {
    const body = { code: "K9O_RBAC_DENY", message: "no", context: {}, recommendation: null };
    const denied = await signedIn(["custody", "status"], () => ({ status: 403, body }), false);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("K9O_RBAC_DENY");
    const bad = await signedIn(["custody", "nope"], () => ({ body: envelope(platform) }), false);
    expect(bad.code).not.toBe(0);
    expect(bad.calls.length).toBe(0);
  });
});
