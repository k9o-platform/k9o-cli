/**
 * `command-manifest.json` is generated from the CLI's own sources (`scripts/emit-command-manifest.ts`).
 * These tests fail when the committed file is stale, when it names an SDK method the client does not have, or when
 * it lists a command the CLI's help does not show.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createClient } from "@k9o/core";
import { main } from "../src/index.ts";
import { buildManifest, render, MANIFEST_PATH, type Manifest } from "../scripts/emit-command-manifest.ts";

async function help(argv: string[]): Promise<string> {
  let buf = "";
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
    buf += String(s);
    return true;
  };
  try {
    await main(argv);
  } finally {
    (process.stdout as unknown as { write: typeof real }).write = real;
  }
  return buf;
}

const committed = (): Manifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

/** Walks `k9o.a.b.c()` / `k9o.from('<collection>').insert()` through a real client; true when the last member is a function. */
function resolves(client: Record<string, unknown>, sdkMethod: string): boolean {
  const chain = sdkMethod.replace(/^k9o\./, "").replace(/\(\)$/, "");
  const parts = chain.split(/\.(?![^(]*\))/); // split on dots that are not inside a `from('...')` call
  let cur: unknown = client;
  for (const part of parts) {
    const call = /^([A-Za-z0-9]+)\('<[a-z]+>'\)$/.exec(part);
    if (call) {
      const fn = (cur as Record<string, unknown>)[call[1]!];
      if (typeof fn !== "function") return false;
      try {
        cur = (fn as (x: string) => unknown).call(cur, "x");
      } catch {
        return false;
      }
    } else {
      if (cur === null || (typeof cur !== "object" && typeof cur !== "function")) return false;
      cur = (cur as Record<string, unknown>)[part];
      if (cur === undefined) return false;
    }
  }
  return typeof cur === "function";
}

describe("command-manifest.json", () => {
  it("is what the generator produces now (run `bun run manifest` and commit the result)", async () => {
    const fresh = render(await buildManifest());
    expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(fresh);
  });

  it("lists each command once, sorted, with a usage line that starts with `k9o <path>`", () => {
    const m = committed();
    const ids = m.commands.map((c) => c.path.join(" "));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    for (const c of m.commands) {
      expect(c.usage.startsWith(`k9o ${c.path.join(" ")}`)).toBe(true);
      expect(c.sample.startsWith(`k9o ${c.path.join(" ")}`)).toBe(true);
    }
  });

  it("names only SDK methods that exist on the @k9o/core client", () => {
    const client = createClient({ apiKey: "k9o_pat_x", orgSlug: "acme", projectSlug: "shop" } as never) as unknown as Record<string, unknown>;
    const missing: string[] = [];
    for (const c of committed().commands) {
      for (const m of c.sdkMethods) if (!resolves(client, m)) missing.push(`${c.path.join(" ")} -> ${m}`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps the method index in step with the commands", () => {
    const m = committed();
    const rebuilt: Record<string, string[]> = {};
    for (const c of m.commands) for (const s of c.sdkMethods) (rebuilt[s] ??= []).push(c.path.join(" "));
    expect(Object.keys(m.sdkMethodIndex)).toEqual(Object.keys(rebuilt).sort());
    for (const k of Object.keys(rebuilt)) expect([...m.sdkMethodIndex[k]!].sort()).toEqual(rebuilt[k]!.sort());
  });

  it("names only REST routes that exist in the gateway spec, for commands that exist", () => {
    const m = committed();
    const spec = JSON.parse(readFileSync(new URL("../../../services/gateway/openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const ids = new Set(m.commands.map((c) => c.path.join(" ")));
    const bad: string[] = [];
    for (const [route, cmds] of Object.entries(m.restRouteIndex)) {
      const [method, path] = [route.slice(0, route.indexOf(" ")), route.slice(route.indexOf(" ") + 1)];
      if (spec.paths[path]?.[method.toLowerCase()] === undefined) bad.push(`${route}: not in openapi.json`);
      for (const c of cmds) if (!ids.has(c)) bad.push(`${route}: no command "${c}"`);
    }
    // every REST route a command lists is indexed, and only a command without an SDK method lists one
    for (const c of m.commands) {
      if (c.sdkMethods.length > 0 && c.restRoutes.length > 0) bad.push(`${c.path.join(" ")}: has both`);
      for (const r of c.restRoutes) if (!m.restRouteIndex[r]?.includes(c.path.join(" "))) bad.push(`${c.path.join(" ")}: ${r} not indexed`);
    }
    expect(bad).toEqual([]);
  });

  it("lists only commands the CLI's own help shows", async () => {
    const top = await help(["--help"]);
    const shown = new Map<string, string>();
    const missing: string[] = [];
    for (const c of committed().commands) {
      const group = c.path[0]!;
      if (!shown.has(group)) shown.set(group, await help([group, "--help"]));
      const text = shown.get(group)!;
      if (c.path.length === 1) {
        if (!top.includes(`  ${group} `) && !text.includes(`k9o ${group}`)) missing.push(c.path.join(" "));
      } else if (!text.includes(c.path[1]!)) missing.push(c.path.join(" "));
    }
    expect(missing).toEqual([]);
  });
});
