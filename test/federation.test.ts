/**
 * Keyless workload federation: the DPoP proof verifies with the gateway's own verifier, the exchange request has
 * the right shape, the OIDC token sources resolve in order, the mode is selected by id prefix, no token leaks into
 * output, and `k9o whoami` reports the federated identity.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { KError } from "@k9o/core";
import { verifyExchangeDpopProof } from "../../../services/gateway/src/auth/workload-federation.ts";
import { verifyResourceDpopProof } from "../../../services/gateway/src/auth/dpop-resource.ts";
import { buildDpopProof, createDpopKey, dpopFetch, exchangeWorkloadToken, resolveOidcToken, oidcSourceFromEnv } from "../src/federation.ts";
import { prepareFederation, resolveWorkloadId } from "../src/commands/auth.ts";
import { envelope, fakeFetch, runCli, tempPath, type Handler } from "./helpers.ts";

const BASE = "http://localhost:9";
const SWI = "swi_abc123";
const OIDC = "eyJ.oidc-secret-value.sig";
const PLATFORM = "platform-access-token-secret";
const TOKEN_PATH = `/@portal/workloads/${SWI}/token`;
const URL_NO_QUERY = `${BASE}${TOKEN_PATH}`;
const NOW = Math.floor(Date.now() / 1000);

const exchangeOk: Handler = (c) =>
  c.method === "POST" && c.path === TOKEN_PATH
    ? { body: envelope({ access_token: PLATFORM, token_type: "DPoP", expires_in: 900, cnf: { jkt: "x" } }) }
    : undefined;

const fedEnv = { K9O_WORKLOAD_ID: SWI, K9O_ORG: "acme", K9O_PROJECT: "portal", K9O_OIDC_TOKEN: OIDC };

function tamper(jws: string): string {
  const [h, c, s] = jws.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  claims.jti = "other";
  return `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
}

describe("DPoP proof against the gateway's verifier", () => {
  const verify = (jws: string, over: Partial<Parameters<typeof verifyExchangeDpopProof>[0]> = {}) =>
    verifyExchangeDpopProof({ jws, htm: "POST", htu: URL_NO_QUERY, nowSec: NOW, workloadId: SWI, ...over });

  it("verifies and returns the key thumbprint and jti", () => {
    const jws = buildDpopProof({ url: `${URL_NO_QUERY}?a=1#f`, nowSec: NOW, jti: "jti-1" });
    const r = verify(jws);
    expect(r.jti).toBe("jti-1");
    expect(r.jkt.length).toBeGreaterThan(20);
  });

  it("each proof uses a fresh key and a fresh jti", () => {
    const a = verify(buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW }));
    const b = verify(buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW }));
    expect(a.jkt).not.toBe(b.jkt);
    expect(a.jti).not.toBe(b.jti);
  });

  it("is refused when tampered, for another URL, for another method, or stale", () => {
    const jws = buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW });
    expect(() => verify(tamper(jws))).toThrow(/invalid_signature|DPoP proof invalid/);
    expect(() => verify(jws, { htu: `${BASE}/@portal/workloads/swi_other/token` })).toThrow(/htm_htu_mismatch/);
    expect(() => verify(jws, { htm: "GET" })).toThrow(/htm_htu_mismatch/);
    const stale = buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW - 3600 });
    expect(() => verify(stale)).toThrow(/stale_iat/);
  });
});

describe("the exchange request", () => {
  it("POSTs { oidcToken, tag } to the project route with a DPoP header and no Authorization", async () => {
    const { fetch, calls } = fakeFetch(exchangeOk);
    const r = await exchangeWorkloadToken({
      baseUrl: BASE, projectSlug: "portal", workloadId: SWI, oidcToken: OIDC, tag: "ci", orgSlug: "acme", fetch,
    });
    expect(r.accessToken).toBe(PLATFORM);
    expect(r.expiresIn).toBe(900);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(TOKEN_PATH);
    expect(calls[0]!.body).toEqual({ oidcToken: OIDC, tag: "ci" });
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    const proof = calls[0]!.headers["dpop"]!;
    expect(verifyExchangeDpopProof({ jws: proof, htm: "POST", htu: URL_NO_QUERY, nowSec: NOW, workloadId: SWI }).jti.length).toBeGreaterThan(0);
  });

  it("omits the tag when none is given", async () => {
    const { fetch, calls } = fakeFetch(exchangeOk);
    await exchangeWorkloadToken({ baseUrl: BASE, projectSlug: "portal", workloadId: SWI, oidcToken: OIDC, fetch });
    expect(calls[0]!.body).toEqual({ oidcToken: OIDC });
  });

  it("later commands send the key-bound platform token with a DPoP proof, after exactly one exchange", async () => {
    const r = await runCli(
      ["audit", "query", "--base-url", BASE, "--workload-tag", "ci", "--output", "json"],
      (c) => exchangeOk(c) ?? (c.path === "/@portal/audit-log" ? { body: envelope([], { cursor: { next: null } }) } : undefined),
      fedEnv,
    );
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.path)).toEqual([TOKEN_PATH, "/@portal/audit-log"]);
    expect(r.calls[0]!.body).toEqual({ oidcToken: OIDC, tag: "ci" });
    expect(r.calls[1]!.headers["authorization"]).toBe(`DPoP ${PLATFORM}`);
    expect((r.calls[1]!.headers["dpop"] ?? "").split(".")).toHaveLength(3);
    expect(r.calls[1]!.headers["x-k9o-org-slug"]).toBe("acme");
  });

  it("a bearer-mode workload (no cnf) keeps the plain Bearer and sends no proof after the exchange", async () => {
    const bearerExchange: Handler = (c) =>
      c.method === "POST" && c.path === TOKEN_PATH ? { body: envelope({ access_token: PLATFORM, token_type: "Bearer", expires_in: 300 }) } : undefined;
    const r = await runCli(
      ["audit", "query", "--base-url", BASE, "--output", "json"],
      (c) => bearerExchange(c) ?? (c.path === "/@portal/audit-log" ? { body: envelope([], { cursor: { next: null } }) } : undefined),
      fedEnv,
    );
    expect(r.code).toBe(0);
    expect(r.calls[1]!.headers["authorization"]).toBe(`Bearer ${PLATFORM}`);
    expect(r.calls[1]!.headers["dpop"]).toBeUndefined();
  });

  it("writes nothing to the credentials file", async () => {
    const t = tempPath();
    try {
      await runCli(["audit", "query", "--base-url", BASE, "--credentials-file", t.path], (c) => exchangeOk(c) ?? { body: envelope([], { cursor: { next: null } }) }, fedEnv);
      expect(await Bun.file(t.path).exists()).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe("OIDC token source precedence", () => {
  it("the file wins over the environment, and is trimmed", async () => {
    const t = tempPath("tok");
    try {
      writeFileSync(t.path, "  from-file\n");
      expect(await resolveOidcToken({ oidcTokenFile: t.path, oidcToken: "from-env" })).toBe("from-file");
    } finally {
      t.cleanup();
    }
  });

  it("the environment wins over GitHub Actions", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: "gh" } }));
    const tok = await resolveOidcToken(
      { oidcToken: "from-env", requestUrl: "http://gh.test/token?x=1", requestToken: "rq", oidcAudience: "aud" },
      { fetch },
    );
    expect(tok).toBe("from-env");
    expect(calls).toHaveLength(0);
  });

  it("GitHub Actions: GET with the audience and the request token as Bearer", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: "gh-jwt" } }));
    const tok = await resolveOidcToken(
      { requestUrl: "http://gh.test/token?api=1", requestToken: "rq-secret", oidcAudience: "https://acme.example" },
      { fetch },
    );
    expect(tok).toBe("gh-jwt");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.query).toEqual({ api: "1", audience: "https://acme.example" });
    expect(calls[0]!.headers["authorization"]).toBe("Bearer rq-secret");
  });

  it("GitHub Actions without a query on the URL appends the audience", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { value: "gh-jwt" } }));
    await resolveOidcToken({ requestUrl: "http://gh.test/token", requestToken: "rq", oidcAudience: "aud" }, { fetch });
    expect(calls[0]!.query).toEqual({ audience: "aud" });
  });

  it("GitHub Actions without an audience is an error", async () => {
    await expect(resolveOidcToken({ requestUrl: "http://gh.test/t", requestToken: "rq" })).rejects.toMatchObject({
      code: "K9O_MISSING_OIDC_AUDIENCE",
    });
  });

  it("no source at all is an error that names the options", async () => {
    const e = await resolveOidcToken({}).catch((x) => x);
    expect(e).toBeInstanceOf(KError);
    expect(e.recommendation).toContain("--oidc-token-file");
    expect(e.recommendation).toContain("id-token: write");
  });

  it("reads flags and environment", () => {
    const s = oidcSourceFromEnv(
      { "oidc-token-file": "/x", "oidc-audience": "a" },
      { K9O_OIDC_TOKEN: "t", K9O_OIDC_AUDIENCE: "b", ACTIONS_ID_TOKEN_REQUEST_URL: "u", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r" },
    );
    expect(s).toEqual({ oidcTokenFile: "/x", oidcToken: "t", oidcAudience: "a", requestUrl: "u", requestToken: "r" });
  });

  it("end to end: the file flag is used by the CLI", async () => {
    const t = tempPath("tok");
    try {
      writeFileSync(t.path, "file-token\n");
      const r = await runCli(
        ["whoami", "--base-url", BASE, "--oidc-token-file", t.path, "--output", "json"],
        exchangeOk,
        { K9O_WORKLOAD_ID: SWI, K9O_ORG: "acme", K9O_PROJECT: "portal" },
      );
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ oidcToken: "file-token" });
    } finally {
      t.cleanup();
    }
  });
});

describe("mode selection", () => {
  it("swi_ selects federation; wl_ keeps the not-operable error; other prefixes name both", async () => {
    expect(resolveWorkloadId({ "workload-id": SWI })).toBe(SWI);
    const wl = await runCli(["project", "list", "--base-url", BASE], () => undefined, { K9O_WORKLOAD_ID: "wl_abc", K9O_ORG: "acme" });
    expect(wl.code).not.toBe(0);
    expect(wl.stderr).toContain("not yet operable");
    const bad = await runCli(["project", "list", "--base-url", BASE], () => undefined, { K9O_WORKLOAD_ID: "zzz_1", K9O_ORG: "acme" });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("swi_");
    expect(bad.stderr).toContain("wl_");
    expect(bad.calls).toHaveLength(0);
  });

  it("the project is required", async () => {
    const r = await runCli(["whoami", "--output", "json"], exchangeOk, { K9O_WORKLOAD_ID: SWI, K9O_ORG: "acme", K9O_OIDC_TOKEN: OIDC });
    expect(r.code).toBe(65);
    expect(JSON.parse(r.stderr).code).toBe("K9O_MISSING_PROJECT_CONTEXT");
    expect(r.calls).toHaveLength(0);
  });

  it("an org or a base URL is required", async () => {
    const e = await prepareFederation({ positional: [], flags: { "workload-id": SWI, project: "portal" } }).catch((x) => x);
    expect(e.code).toBe("K9O_MISSING_ORG_CONTEXT");
  });

  it("an invalid tag is refused before any request", async () => {
    const r = await runCli(["whoami", "--base-url", BASE, "--workload-tag", "Bad Tag"], exchangeOk, fedEnv);
    expect(r.code).not.toBe(0);
    expect(r.calls).toHaveLength(0);
  });
});

describe("errors and secrecy", () => {
  it("maps a gateway refusal to the auth exit code, with the registration hint", async () => {
    const r = await runCli(
      ["whoami", "--base-url", BASE, "--output", "json"],
      () => ({ status: 401, body: { code: "K9O_WORKLOAD_FEDERATION_TOKEN_INVALID", message: `token ${OIDC} rejected`, context: { echo: OIDC } } }),
      fedEnv,
    );
    expect(r.code).toBe(66);
    const err = JSON.parse(r.stderr);
    expect(err.code).toBe("K9O_WORKLOAD_FEDERATION_TOKEN_INVALID");
    expect(err.recommendation).toContain("trust config");
    expect(r.stderr).not.toContain(OIDC);
  });

  it("reports an unavailable exchange and a missing workload plainly", async () => {
    const un = await runCli(
      ["whoami", "--base-url", BASE],
      () => ({ status: 503, body: { code: "K9O_WORKLOAD_FEDERATION_UNAVAILABLE", message: "unavailable" } }),
      fedEnv,
    );
    expect(un.code).toBe(73);
    expect(un.stderr).toContain("K9O_WORKLOAD_FEDERATION_UNAVAILABLE");
    const nf = await runCli(["whoami", "--base-url", BASE], () => ({ status: 404, body: { code: "K9O_WORKLOAD_NOT_FOUND", message: "no such workload" } }), fedEnv);
    expect(nf.code).toBe(68);
  });

  it("no token value appears in output, in json or human form", async () => {
    for (const out of ["json", "human"]) {
      const ok = await runCli(["whoami", "--base-url", BASE, "--output", out], exchangeOk, fedEnv);
      expect(ok.code).toBe(0);
      const bad = await runCli(["whoami", "--base-url", BASE, "--output", out], () => ({ status: 500, body: { code: "K9O_INTERNAL_ERROR", message: "boom" } }), fedEnv);
      for (const text of [ok.stdout, ok.stderr, bad.stdout, bad.stderr]) {
        expect(text).not.toContain(OIDC);
        expect(text).not.toContain(PLATFORM);
      }
    }
  });
});

describe("whoami in federation mode", () => {
  it("reports the federated workload without printing tokens, with one gateway call", async () => {
    const r = await runCli(["whoami", "--base-url", BASE, "--output", "json"], exchangeOk, fedEnv);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data).toEqual({
      mode: "federated-workload", workloadId: SWI, orgSlug: "acme", activeProjectSlug: "portal", expiresIn: 900,
    });
    expect(r.calls).toHaveLength(1);
    const human = await runCli(["whoami", "--base-url", BASE], exchangeOk, fedEnv);
    expect(human.stdout).toContain(`federated workload ${SWI}`);
    expect(human.stdout).toContain("900s");
  });

  it("help documents the flags, the env and the grants caveat", async () => {
    for (const argv of [["--help"], ["login", "--help"]]) {
      const r = await runCli(argv, () => undefined);
      for (const w of ["--workload-id", "K9O_WORKLOAD_ID", "K9O_OIDC_TOKEN", "K9O_OIDC_AUDIENCE", "id-token: write", "no project grants"]) {
        expect(r.stdout).toContain(w);
      }
    }
    const login = await runCli(["login", "--help"], () => undefined);
    for (const w of ["--workload-tag", "--oidc-token-file", "--oidc-audience"]) expect(login.stdout).toContain(w);
  });
});

const CASES: Array<{ name: string; rec: unknown; status: number; expectRec: string | null; expectRetry: number | null }> = [
  { name: "object with action", rec: { action: "Open Billing and settle the outstanding wallet balance to lift the suspension." }, status: 403, expectRec: "Open Billing and settle the outstanding wallet balance to lift the suspension.", expectRetry: null },
  { name: "object with retryAfterSec and note", rec: { retryAfterSec: 30, note: "retry" }, status: 429, expectRec: "retry", expectRetry: 30 },
  { name: "null", rec: null, status: 403, expectRec: null, expectRetry: null },
  { name: "string", rec: "Do the thing.", status: 403, expectRec: "Do the thing.", expectRetry: null },
  { name: "number", rec: 42, status: 403, expectRec: null, expectRetry: null },
  { name: "array", rec: ["a", "b"], status: 403, expectRec: null, expectRetry: null },
  { name: "negative retryAfterSec", rec: { retryAfterSec: -1 }, status: 429, expectRec: null, expectRetry: null },
];
const body = (rec: unknown) => ({ code: "K9O_READ_ONLY_SUSPENDED", message: "Project is suspended.", context: { x: 1 }, recommendation: rec });

describe("exchange refusal with a recommendation of any JSON type", () => {
  for (const c of CASES) {
    it(`keeps the KError when recommendation is ${c.name}`, async () => {
      const { fetch } = fakeFetch(() => ({ status: c.status, body: body(c.rec) }));
      const err = (await exchangeWorkloadToken({ baseUrl: BASE, projectSlug: "portal", workloadId: SWI, oidcToken: OIDC, fetch }).catch((e: unknown) => e)) as KError;
      expect(err).toBeInstanceOf(KError);
      expect(err.code).toBe("K9O_READ_ONLY_SUSPENDED");
      expect(err.message).toBe("Project is suspended.");
      expect(err.status).toBe(c.status);
      expect(err.context).toEqual({ x: 1 });
      expect(err.recommendation?.startsWith(c.expectRec ?? "The workload must be registered")).toBe(true);
      expect(err.retryAfterSec).toBe(c.expectRetry);
    });
  }

  it("prints the action text in human output and keeps the exit code", async () => {
    const r = await runCli(["whoami", "--base-url", BASE, "--output", "human"], () => ({ status: 403, body: body(CASES[0]!.rec) }), fedEnv);
    expect(r.stderr).not.toContain("[object Object]");
    expect(r.stderr).toContain("K9O_READ_ONLY_SUSPENDED");
    expect(r.stderr).toContain("settle the outstanding wallet balance");
    expect(r.code).toBe(67);
  });

  it("prints retryAfterSec in JSON output", async () => {
    const r = await runCli(["whoami", "--base-url", BASE, "--output", "json"], () => ({ status: 429, body: body(CASES[1]!.rec) }), fedEnv);
    const out = JSON.parse(r.stderr) as { code: string; recommendation: string; retryAfterSec: number };
    expect(out.code).toBe("K9O_READ_ONLY_SUSPENDED");
    expect(out.retryAfterSec).toBe(30);
    expect(r.code).toBe(72);
  });
});

describe("per-request DPoP proofs for a key-bound token", () => {
  const API = `${BASE}/@portal/functions`;

  it("the exchange hands back its key only when the token is bound (cnf)", async () => {
    const bound = await exchangeWorkloadToken({ baseUrl: BASE, projectSlug: "portal", workloadId: SWI, oidcToken: OIDC, fetch: fakeFetch(exchangeOk).fetch });
    expect(bound.dpopKey).not.toBeNull();
    const bearer = await exchangeWorkloadToken({
      baseUrl: BASE, projectSlug: "portal", workloadId: SWI, oidcToken: OIDC,
      fetch: fakeFetch((c) => (c.path === TOKEN_PATH ? { body: envelope({ access_token: PLATFORM, token_type: "Bearer", expires_in: 300 }) } : undefined)).fetch,
    });
    expect(bearer.dpopKey).toBeNull();
  });

  it("dpopFetch sends a proof the gateway's verifier accepts: the key, method, URL without query, and the token", async () => {
    const key = createDpopKey();
    const expectedJkt = verifyExchangeDpopProof({ jws: buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW, key }), htm: "POST", htu: URL_NO_QUERY, nowSec: NOW, workloadId: SWI }).jkt;
    const { fetch, calls } = fakeFetch(() => ({ body: envelope({}) }));
    await dpopFetch(fetch, PLATFORM, key)(`${API}?x=1`, { method: "get", headers: { accept: "application/json" } });
    const sent = calls[0]!;
    expect(sent.headers["authorization"]).toBe(`DPoP ${PLATFORM}`);
    expect(sent.headers["accept"]).toBe("application/json");
    const verified = verifyResourceDpopProof({ jws: sent.headers["dpop"]!, htm: "GET", htu: API, nowSec: Math.floor(Date.now() / 1000), expectedJkt, accessToken: PLATFORM });
    expect(verified.jti.length).toBeGreaterThan(0);
  });

  it("every request gets a new jti, and a proof for one token is refused for another or for another URL", async () => {
    const key = createDpopKey();
    const expectedJkt = verifyExchangeDpopProof({ jws: buildDpopProof({ url: URL_NO_QUERY, nowSec: NOW, key }), htm: "POST", htu: URL_NO_QUERY, nowSec: NOW, workloadId: SWI }).jkt;
    const { fetch, calls } = fakeFetch(() => ({ body: envelope({}) }));
    const f = dpopFetch(fetch, PLATFORM, key);
    await f(API, { method: "POST", body: "{}" });
    await f(API, { method: "POST", body: "{}" });
    const [a, b] = [calls[0]!.headers["dpop"]!, calls[1]!.headers["dpop"]!];
    const now = Math.floor(Date.now() / 1000);
    const check = (jws: string, over: object = {}) => verifyResourceDpopProof({ jws, htm: "POST", htu: API, nowSec: now, expectedJkt, accessToken: PLATFORM, ...over });
    expect(check(a).jti).not.toBe(check(b).jti);
    expect(() => check(a, { accessToken: "another-token" })).toThrow(/ath_mismatch/);
    expect(() => check(a, { htu: `${BASE}/@portal/other` })).toThrow(/htu_mismatch/);
    expect(() => check(a, { expectedJkt: "x" })).toThrow(/jkt_mismatch/);
  });
});
