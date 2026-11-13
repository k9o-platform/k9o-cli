/** `k9o crypto encrypt|decrypt|rewrap` against a fake gateway: flags -> request body -> output and exit codes. */

import { describe, expect, it } from "bun:test";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { envelope, runCli, tempCredentials, tempPath, type Handler } from "./helpers.ts";

const BASE = "/@portal";
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

/** The custody check (`GET /crypto/mode`) is answered here and left out of `calls`; `modes` counts it. */
let modeReply: { custodyMode: string; epoch: string } | { status: number } = { custodyMode: "PLATFORM_MANAGED", epoch: "e1" };
let modes = 0;
let lastModeQuery: Record<string, string> = {};

async function signedIn(argv: string[], handler: Handler) {
  const c = tempCredentials();
  try {
    const r = await runCli([...argv, "--credentials-file", c.path], (call) => {
      if (call.path === `${BASE}/crypto/mode`) {
        modes++;
        lastModeQuery = call.query;
        return "status" in modeReply ? { status: modeReply.status, body: { code: "K9O_NOT_FOUND", message: "no route", context: {} } } : { body: envelope(modeReply) };
      }
      return handler(call);
    });
    return { ...r, calls: r.calls.filter((x) => x.path !== `${BASE}/crypto/mode`) };
  } finally {
    c.cleanup();
  }
}

function files(content: string | Uint8Array, name = "in.txt") {
  const t = tempPath(name);
  writeFileSync(t.path, content);
  return t;
}

describe("k9o crypto encrypt", () => {
  it("checks the custody mode first and sends the epoch with the platform call", async () => {
    modes = 0;
    const f = files("x");
    const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "CT" }] }) }));
    expect(modes).toBe(1);
    expect((r.calls[0]!.body as any).custodyEpoch).toBe("e1");
    f.cleanup();
  });

  it("a BYOK project with no client core prints the requirement, exits 73 and sends no plaintext", async () => {
    modes = 0;
    modeReply = { custodyMode: "BYOK", epoch: "e1" };
    const f = files("secret");
    try {
      const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "CT" }] }) }));
      expect(r.code).toBe(73);
      expect(r.calls).toHaveLength(0);
      expect(r.stderr).toContain("[K9O_ZK_CLIENT_CORE_UNAVAILABLE]");
      expect(r.stderr).toContain("Kibo client core");
      expect(r.stdout).toBe("");
    } finally {
      modeReply = { custodyMode: "PLATFORM_MANAGED", epoch: "e1" };
      f.cleanup();
    }
  });

  it("a failed custody call shows the original error, not the custody code, and sends no plaintext", async () => {
    modeReply = { status: 404 };
    const f = files("secret");
    try {
      const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "CT" }] }) }));
      expect(r.code).not.toBe(0);
      expect(r.stderr).not.toContain("K9O_CRYPTO_CUSTODY_UNKNOWN");
      expect(r.calls).toHaveLength(0);
    } finally {
      modeReply = { custodyMode: "PLATFORM_MANAGED", epoch: "e1" };
      f.cleanup();
    }
  });

  it("an unknown custody mode answer fails with K9O_CRYPTO_CUSTODY_UNKNOWN and sends no plaintext", async () => {
    modeReply = { custodyMode: "QUANTUM", epoch: "e1" };
    const f = files("secret");
    try {
      const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "CT" }] }) }));
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("K9O_CRYPTO_CUSTODY_UNKNOWN");
      expect(r.calls).toHaveLength(0);
    } finally {
      modeReply = { custodyMode: "PLATFORM_MANAGED", epoch: "e1" };
      f.cleanup();
    }
  });

  it("sends the file's bytes as base64 with crypt and context, and prints the ciphertext", async () => {
    const f = files("call back on Tuesday");
    const r = await signedIn(["crypto", "encrypt", "--crypt", "customer-notes", "--context", "customer:1042", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "Q1QxCg==" }] }) }));
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      method: "POST",
      path: `${BASE}/crypto/encrypt`,
      body: { crypt: "customer-notes", items: [{ plaintext: b64("call back on Tuesday"), context: "customer:1042" }], custodyEpoch: "e1" },
    });
    expect(r.stdout).toBe("Q1QxCg==\n");
    f.cleanup();
  });

  it("sends binary input unchanged and omits context when none is given", async () => {
    const f = files(new Uint8Array([0, 255, 1, 2]));
    const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "AAAA" }] }) }));
    expect(r.calls[0]!.body).toEqual({ crypt: "k", items: [{ plaintext: b64(new Uint8Array([0, 255, 1, 2])) }], custodyEpoch: "e1" });
    f.cleanup();
  });

  it("--encoding base64 decodes the input first; --out writes the ciphertext to a file", async () => {
    const f = files(`${b64("hello")}\n`);
    const out = tempPath("out.enc");
    const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path, "--out", out.path, "--encoding", "base64"], () => ({ body: envelope({ items: [{ ciphertext: "CT" }] }) }));
    expect(r.code).toBe(0);
    expect((r.calls[0]!.body as any).items[0].plaintext).toBe(b64("hello"));
    expect(readFileSync(out.path, "utf8")).toBe("CT\n");
    expect(r.stdout).toBe("");
    f.cleanup();
    out.cleanup();
  });

  it("a failed item prints its code plainly and exits through the error map, with no retry", async () => {
    const f = files("x");
    const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ code: "K9O_KEY_SERVICE_UNAVAILABLE", message: "busy" }] }) }));
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.stderr).toContain("[K9O_KEY_SERVICE_UNAVAILABLE] busy");
    expect(r.stdout).toBe("");
    f.cleanup();
  });

  it("a whole-call 404 (and 503, 429) is printed with its code and exit code; none is retried", async () => {
    const f = files("x");
    const cases: Array<[number, string, number]> = [[404, "K9O_NOT_FOUND", 68], [503, "K9O_KEY_SERVICE_UNAVAILABLE", 73], [429, "K9O_RATE_LIMITED", 72]];
    for (const [status, code, exit] of cases) {
      const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", f.path], () => ({ status, body: { code, message: "no", context: {} } }));
      expect(r.code, code).toBe(exit);
      expect(r.calls, code).toHaveLength(1);
      expect(r.stderr, code).toContain(code);
    }
    f.cleanup();
  });

  it("flag errors exit 2 before any request; the SDK's own checks exit 70", async () => {
    const f = files("x");
    const usage = [
      ["crypto", "encrypt", "--in", f.path],
      ["crypto", "encrypt", "--crypt", "k", "--in", f.path, "--encoding", "hex"],
      ["crypto", "encrypt", "--crypt", "k", "--in", f.path, "--items-file", f.path],
      ["crypto", "encrypt", "--crypt", "k", "--in", f.path, "--context"],
      ["crypto", "nope", "--crypt", "k"],
    ];
    for (const argv of usage) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    const bad = await signedIn(["crypto", "encrypt", "--crypt", "Bad_Name", "--in", f.path], () => undefined);
    expect(bad.code).toBe(70);
    expect(bad.stderr).toContain("K9O_INVALID_FIELD_VALUE");
    expect(bad.calls).toHaveLength(0);
    const big = files(new Uint8Array(64 * 1024 + 1));
    const tooBig = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", big.path], () => undefined);
    expect(tooBig.stderr).toContain("K9O_PAYLOAD_TOO_LARGE");
    expect(tooBig.calls).toHaveLength(0);
    const missing = await signedIn(["crypto", "encrypt", "--crypt", "k", "--in", "/nonexistent/file"], () => undefined);
    expect(missing.code).toBe(70);
    f.cleanup();
    big.cleanup();
  });

  it("no subcommand prints help and exits 2; help does not mention the gateway's state", async () => {
    const none = await runCli(["crypto"], () => undefined);
    expect(none.code).toBe(2);
    const h = await runCli(["crypto", "encrypt", "--help"], () => undefined);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("--crypt");
    expect(h.stdout).toContain("per-subject erasure");
    expect(h.stdout).not.toMatch(/not live|404|yet/i);
  });
});

describe("k9o crypto mode", () => {
  it("prints the custody mode and epoch, and as JSON with --output json", async () => {
    modeReply = { custodyMode: "HYOK", epoch: "ep-3" };
    try {
      const r = await signedIn(["crypto", "mode"], () => undefined);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("custodyMode=HYOK  epoch=ep-3\n");
      const j = await signedIn(["crypto", "mode", "--output", "json"], () => undefined);
      expect(JSON.parse(j.stdout)).toEqual({ custodyMode: "HYOK", epoch: "ep-3" });
    } finally {
      modeReply = { custodyMode: "PLATFORM_MANAGED", epoch: "e1" };
    }
  });
});

describe("k9o crypto decrypt", () => {
  it("a 409 for the client route without a client core prints the requirement and exits 73", async () => {
    const f = files("CT1");
    const r = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path], () => ({ status: 409, body: { code: "K9O_ZK_STORE_FLOW_REQUIRED", message: "x", context: { custodyMode: "BYOK", route: "client", epoch: "e2" } } }));
    expect(r.code).toBe(73);
    expect(r.stderr).toContain("K9O_ZK_CLIENT_CORE_UNAVAILABLE");
    expect(r.calls).toHaveLength(1);
    f.cleanup();
  });

  it("sends the ciphertext text and writes the raw plaintext bytes", async () => {
    const f = files("  CT1\n");
    const r = await signedIn(["crypto", "decrypt", "--crypt", "k", "--context", "c", "--in", f.path], () => ({ body: envelope({ items: [{ plaintext: b64("call back on Tuesday") }] }) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ path: `${BASE}/crypto/decrypt`, body: { crypt: "k", items: [{ ciphertext: "CT1", context: "c" }] } });
    expect(r.stdout).toBe("call back on Tuesday");
    f.cleanup();
  });

  it("--out writes the exact bytes to a file; --encoding base64 writes base64 text", async () => {
    const f = files("CT1");
    const bytes = new Uint8Array([0, 200, 255]);
    const reply = () => ({ body: envelope({ items: [{ plaintext: b64(bytes) }] }) });
    const out = tempPath("plain.bin");
    await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path, "--out", out.path], reply);
    expect([...readFileSync(out.path)]).toEqual([0, 200, 255]);
    const r = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path, "--encoding", "base64"], reply);
    expect(r.stdout).toBe(`${b64(bytes)}\n`);
    f.cleanup();
    out.cleanup();
  });

  it("an integrity failure (400, whole call) prints the code and exits 70; an item failure prints it and exits non-zero", async () => {
    const f = files("CT1");
    const whole = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path], () => ({ status: 400, body: { code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open", context: {} } }));
    expect(whole.code).toBe(70);
    expect(whole.stderr).toContain("K9O_ENVELOPE_INTEGRITY_FAILURE");
    expect(whole.stdout).toBe("");
    const item = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path], () => ({ body: envelope({ items: [{ code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open" }] }) }));
    expect(item.code).not.toBe(0);
    expect(item.stderr).toContain("[K9O_ENVELOPE_INTEGRITY_FAILURE]");
    const retired = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path], () => ({ status: 409, body: { code: "K9O_SEALED_UNDER_RETIRED_KEY", message: "retired", context: { resealableUntil: "2026-11-01T00:00:00Z" } } }));
    expect(retired.code).toBe(69);
    expect(retired.calls).toHaveLength(1);
    f.cleanup();
  });

  it("an empty ciphertext input is a usage error", async () => {
    const f = files("\n");
    const r = await signedIn(["crypto", "decrypt", "--crypt", "k", "--in", f.path], () => undefined);
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    f.cleanup();
  });
});

describe("k9o crypto rewrap", () => {
  it("posts to rewrap and prints the new ciphertext", async () => {
    const f = files("OLD");
    const r = await signedIn(["crypto", "rewrap", "--crypt", "k", "--context", "c", "--in", f.path], () => ({ body: envelope({ items: [{ ciphertext: "NEW" }] }) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ path: `${BASE}/crypto/rewrap`, body: { crypt: "k", items: [{ ciphertext: "OLD", context: "c" }] } });
    expect(r.stdout).toBe("NEW\n");
    f.cleanup();
  });
});

describe("k9o crypto --items-file", () => {
  it("encrypts a batch in order, with --context as the default", async () => {
    const f = files(JSON.stringify([{ plaintext: "a", context: "x" }, { plaintext: "b" }]), "items.json");
    const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--context", "dflt", "--items-file", f.path], () => ({ body: envelope({ items: [{ ciphertext: "C1" }, { ciphertext: "C2" }] }) }));
    expect(r.code).toBe(0);
    expect((r.calls[0]!.body as any).items).toEqual([{ plaintext: b64("a"), context: "x" }, { plaintext: b64("b"), context: "dflt" }]);
    expect(JSON.parse(r.stdout)).toEqual([{ ok: true, ciphertext: "C1" }, { ok: true, ciphertext: "C2" }]);
    f.cleanup();
  });

  it("decrypts a batch: the good entries are written, the failed one is reported and the exit is non-zero", async () => {
    const f = files(JSON.stringify([{ ciphertext: "C1" }, { ciphertext: "C2" }]), "items.json");
    const r = await signedIn(["crypto", "decrypt", "--crypt", "k", "--items-file", f.path], () => ({ body: envelope({ items: [{ plaintext: b64("one") }, { code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open" }] }) }));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual([{ ok: true, plaintext: "one" }, { ok: false, code: "K9O_ENVELOPE_INTEGRITY_FAILURE", message: "cannot open" }]);
    expect(r.stderr).toContain("[K9O_ENVELOPE_INTEGRITY_FAILURE] item 1: cannot open");
    const b = await signedIn(["crypto", "decrypt", "--crypt", "k", "--encoding", "base64", "--items-file", f.path], () => ({ body: envelope({ items: [{ plaintext: b64("one") }, { plaintext: b64(new Uint8Array([255])) }] }) }));
    expect(b.code).toBe(0);
    expect(JSON.parse(b.stdout)).toEqual([{ ok: true, plaintext: b64("one") }, { ok: true, plaintext: b64(new Uint8Array([255])) }]);
    f.cleanup();
  });

  it("rewraps a batch to --out", async () => {
    const f = files(JSON.stringify([{ ciphertext: "C1" }]), "items.json");
    const out = tempPath("sealed.json");
    const r = await signedIn(["crypto", "rewrap", "--crypt", "k", "--items-file", f.path, "--out", out.path], () => ({ body: envelope({ items: [{ ciphertext: "C9" }] }) }));
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(out.path, "utf8"))).toEqual([{ ok: true, ciphertext: "C9" }]);
    f.cleanup();
    out.cleanup();
  });

  it("refuses an empty array, more than 100 items, or a bad entry before any request", async () => {
    const cases = [[], Array.from({ length: 101 }, () => ({ plaintext: "a" })), [{ nope: 1 }], "text"];
    for (const c of cases) {
      const f = files(JSON.stringify(c), "items.json");
      const r = await signedIn(["crypto", "encrypt", "--crypt", "k", "--items-file", f.path], () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
      f.cleanup();
    }
    const notJson = files("{", "items.json");
    expect((await signedIn(["crypto", "encrypt", "--crypt", "k", "--items-file", notJson.path], () => undefined)).code).toBe(2);
    notJson.cleanup();
  });
});

describe("k9o crypto over stdin", () => {
  it("reads one item from stdin when --in is absent", async () => {
    let seen: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith("/crypto/mode")) return Response.json({ data: { custodyMode: "PLATFORM_MANAGED", epoch: "e1" }, meta: {} });
        seen = { path: new URL(req.url).pathname, body: await req.json() };
        return Response.json({ data: { items: [{ ciphertext: "FROM_STDIN" }] }, meta: {} });
      },
    });
    try {
      const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/index.ts`, "crypto", "encrypt", "--crypt", "k", "--base-url", `http://localhost:${server.port}`], {
        stdin: new Blob(["piped text"]),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", K9O_SERVICE_TOKEN: "k9o_test_token", K9O_ORG: "acme", K9O_PROJECT: "portal" },
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited, err).toBe(0);
      expect(out).toBe("FROM_STDIN\n");
      expect(seen).toEqual({ path: "/@portal/crypto/encrypt", body: { crypt: "k", items: [{ plaintext: b64("piped text") }], custodyEpoch: "e1" } });
    } finally {
      server.stop(true);
    }
  });
});

describe("k9o crypto federated-token", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.payload.SECRETSIG";
  const reply = () => ({
    body: envelope({ token: TOKEN, expiresAt: "2026-11-03T12:15:00Z", issuer: "https://iss.example", subject: "proj_1:crypt:k:op:encrypt", audience: "api://aud", kid: "kid-1" }),
  });
  const PATH = `${BASE}/crypto/federated-token`;

  it("--out writes the token exactly, mode 0600, and stdout carries the metadata but not the token", async () => {
    const t = tempPath("token");
    try {
      const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", t.path], reply);
      expect(r.code).toBe(0);
      expect(readFileSync(t.path, "utf8")).toBe(TOKEN);
      expect(statSync(t.path).mode & 0o777).toBe(0o600);
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stderr).not.toContain(TOKEN);
      expect(r.stdout).toContain("expiresAt=2026-11-03T12:15:00Z");
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.path).toBe(PATH);
      expect(r.calls[0]!.body).toEqual({ crypt: "k", op: "encrypt" });
    } finally {
      t.cleanup();
    }
  });

  it("--json prints the metadata as JSON and still no token", async () => {
    const t = tempPath("token");
    try {
      const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", t.path, "--output", "json"], reply);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.written).toBe(t.path);
      expect(j.audience).toBe("api://aud");
      expect("token" in j).toBe(false);
      expect(r.stdout).not.toContain(TOKEN);
    } finally {
      t.cleanup();
    }
  });

  it("an existing file is refused before any call, and left unchanged", async () => {
    const f = files("old", "token");
    const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", f.path], reply);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pass --force");
    expect(r.calls).toHaveLength(0);
    expect(readFileSync(f.path, "utf8")).toBe("old");
    f.cleanup();
  });

  it("--force replaces the file and sets mode 0600 on a file that was looser", async () => {
    const f = files("old", "token");
    chmodSync(f.path, 0o644);
    const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", f.path, "--force"], reply);
    expect(r.code).toBe(0);
    expect(readFileSync(f.path, "utf8")).toBe(TOKEN);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    f.cleanup();
  });

  it("--out-fd writes the token to the open descriptor and stdout has no token", async () => {
    const t = tempPath("fd-target");
    const fd = openSync(t.path, "w", 0o600);
    try {
      const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--op", "decrypt", "--out-fd", String(fd)], reply);
      expect(r.code).toBe(0);
      expect(readFileSync(t.path, "utf8")).toBe(TOKEN);
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stdout).toContain(`written=fd ${fd}`);
      expect((r.calls[0]!.body as any).op).toBe("decrypt");
    } finally {
      closeSync(fd);
      t.cleanup();
    }
  });

  it("with no destination it is a usage error, calls nothing and prints no token", async () => {
    const r = await signedIn(["crypto", "federated-token", "--crypt", "k"], reply);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--out");
    expect(r.calls).toHaveLength(0);
    expect(r.stdout).toBe("");
  });

  it("--out - prints only the token and a newline to stdout", async () => {
    const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", "-"], reply);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${TOKEN}\n`);
  });

  it("--out with --out-fd, a descriptor that is not open, a bad --op and --force without --out are usage errors that call nothing", async () => {
    const t = tempPath("token");
    for (const argv of [
      ["--out", t.path, "--out-fd", "3"],
      ["--out-fd", "987"],
      ["--op", "sign", "--out", t.path],
      ["--out-fd", "3", "--force"],
    ]) {
      const r = await signedIn(["crypto", "federated-token", "--crypt", "k", ...argv], reply);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    t.cleanup();
  });

  it("a platform-managed project (409) writes nothing and shows the code", async () => {
    const t = tempPath("token");
    try {
      const r = await signedIn(["crypto", "federated-token", "--crypt", "k", "--out", t.path], () => ({
        status: 409,
        body: { code: "K9O_CUSTODY_SERVER_ROUTE", message: "server route", context: {} },
      }));
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("K9O_CUSTODY_SERVER_ROUTE");
      expect(existsSync(t.path)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe("k9o crypto mode --crypt", () => {
  it("sends the crypt as a query when given, and none when not", async () => {
    let r = await signedIn(["crypto", "mode", "--crypt", "customer-notes"], () => undefined);
    expect(r.code).toBe(0);
    expect(lastModeQuery["crypt"]).toBe("customer-notes");
    r = await signedIn(["crypto", "mode"], () => undefined);
    expect(r.code).toBe(0);
    expect(lastModeQuery["crypt"]).toBeUndefined();
  });

  it("refuses a crypt that is not a valid name, and a bare --crypt, before any request", async () => {
    modes = 0;
    for (const argv of [["--crypt", "Bad_Name"], ["--crypt"]]) {
      const r = await signedIn(["crypto", "mode", ...argv], () => undefined);
      expect(r.code).not.toBe(0);
    }
    expect(modes).toBe(0);
  });
});
