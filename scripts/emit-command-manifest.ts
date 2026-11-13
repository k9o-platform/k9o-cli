#!/usr/bin/env bun
/**
 * Emits `command-manifest.json`: every `k9o` command, derived from the CLI's own sources.
 *
 * What is read, and from where:
 *   - the command tree and the SDK call each command makes: the TypeScript syntax tree of `src/index.ts` and
 *     `src/commands/*.ts`. A branch such as `if (sub === "read")` or `case "read":` opens a path token; a call
 *     `client.<ns>.<method>(...)` inside the branch (following local helper functions and nested dispatchers) is
 *     the command's SDK method, written the way the OpenAPI `x-sdk-method` sidecar writes it
 *     (`k9o.rollups.read()`, `k9o.from('<collection>').insert()`).
 *   - the usage line and description: the command's own `--help` text, captured by running `main([group, "--help"])`.
 *     A command with no line in its help (a helper reached only through a branch) is left out.
 *
 * Nothing here is typed by hand. `bun run manifest` rewrites the file; `test/command-manifest.test.ts` fails when
 * the committed file differs from what this script produces now.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const SRC = join(PKG, "src");
export const MANIFEST_PATH = join(PKG, "command-manifest.json");

/** Variables a command's dispatcher reads its next word into. `args.positional[N]` is read directly as well. */
const TOKEN_NAMES = new Set(["sub", "sub2", "verb", "group", "action"]);

// ---------------------------------------------------------------------------
// Source files
// ---------------------------------------------------------------------------

interface Src {
  file: string;
  sf: ts.SourceFile;
  fns: Map<string, ts.Node>;
  imports: Map<string, string>; // local name -> absolute file
}

const cache = new Map<string, Src>();

function loadSrc(file: string): Src {
  const hit = cache.get(file);
  if (hit) return hit;
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fns = new Map<string, ts.Node>();
  const imports = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) fns.set(d.name.text, d.initializer);
      }
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith(".")) {
      const target = resolve(dirname(file), st.moduleSpecifier.text);
      if (st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
        for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, target);
      }
    }
  }
  const out = { file, sf, fns, imports };
  cache.set(file, out);
  return out;
}

// ---------------------------------------------------------------------------
// Syntax-tree helpers
// ---------------------------------------------------------------------------

function strLit(n: ts.Node): string | null {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

/** The dispatch variable an expression names: `sub`, `verb`, `args.positional[2]`, or null. */
function tokenExpr(e: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(e)) return tokenExpr(e.expression);
  if (ts.isIdentifier(e) && TOKEN_NAMES.has(e.text)) return e.text;
  if (ts.isElementAccessExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "positional") {
    return `positional[${e.argumentExpression.getText()}]`;
  }
  return null;
}

/** `sub === "x"` (or `"x" === sub`): the variable and the literal, else null. */
function tokenCompare(e: ts.Expression): { key: string; lit: string } | null {
  if (ts.isParenthesizedExpression(e)) return tokenCompare(e.expression);
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
  const l = strLit(e.right);
  const lk = tokenExpr(e.left);
  if (l !== null && lk !== null) return { key: lk, lit: l };
  const r = strLit(e.left);
  const rk = tokenExpr(e.right);
  if (r !== null && rk !== null) return { key: rk, lit: r };
  return null;
}

/** Any `X === "lit"` where X is an identifier (not only a dispatch name): used to resolve a parameter bound to a literal. */
function identCompare(e: ts.Expression): { key: string; lit: string } | null {
  if (ts.isParenthesizedExpression(e)) return identCompare(e.expression);
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
  if (ts.isIdentifier(e.left) && strLit(e.right) !== null) return { key: e.left.text, lit: strLit(e.right)! };
  return null;
}

interface Dispatch {
  key: string;
  lits: string[];
}

/** The literals an `if` condition dispatches on: `sub === "a" || sub === "b"` gives {sub, ["a", "b"]}; a `&&` conjunct counts. */
function dispatchLiterals(cond: ts.Expression, any = false): Dispatch | null {
  if (ts.isParenthesizedExpression(cond)) return dispatchLiterals(cond.expression, any);
  if (ts.isBinaryExpression(cond)) {
    const k = cond.operatorToken.kind;
    if (k === ts.SyntaxKind.BarBarToken) {
      const a = dispatchLiterals(cond.left, any);
      const b = dispatchLiterals(cond.right, any);
      return a !== null && b !== null && a.key === b.key ? { key: a.key, lits: [...a.lits, ...b.lits] } : null;
    }
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return dispatchLiterals(cond.left, any) ?? dispatchLiterals(cond.right, any);
  }
  const one = any ? identCompare(cond) : tokenCompare(cond);
  return one === null ? null : { key: one.key, lits: [one.lit] };
}

/** The member chain of an expression rooted at `client` (or an alias bound to a client chain): ["analytics", "rollups"]. */
function chainParts(e: ts.Expression, alias: Map<string, string[]>): string[] | null {
  const parts: string[] = [];
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      const inner = cur.expression;
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === "from") {
        // `client.from(c)` is a collection; `client.storage.from(b)` is a bucket
        const recv = inner.expression;
        parts.unshift(ts.isPropertyAccessExpression(recv) && recv.name.text === "storage" ? "from('<bucket>')" : "from('<collection>')");
        cur = inner.expression;
      } else return null;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  if (!ts.isIdentifier(cur)) return null;
  if (cur.text === "client") return parts;
  const a = alias.get(cur.text);
  return a ? [...a, ...parts] : null;
}

/** `client.a.b.c(...)` or `client.from(x).insert(...)` -> "k9o.a.b.c()" / "k9o.from('<collection>').insert()". */
function sdkChain(call: ts.CallExpression, alias: Map<string, string[]>): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const parts = chainParts(call.expression, alias);
  if (parts === null || parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  if (last.startsWith("from(") || last === "from") return null; // the builder, not a method
  return `k9o.${parts.join(".")}()`;
}

// ---------------------------------------------------------------------------
// Command paths
// ---------------------------------------------------------------------------

interface Hit {
  path: string[];
  sdk: string[];
  /** Gateway routes the command calls over REST, as `METHOD /path/{template}`. */
  rest: Set<string>;
  /** Flags the code refuses to run without (`--crypt is required`), read from its error messages. */
  required: Set<string>;
}

const HTTP = /^(GET|POST|PUT|PATCH|DELETE)$/;

/** A path written as a string or template: `/@${project}/x/${encodeURIComponent(slug)}` -> `/@{projectSlug}/x/{slug}`. */
function routeTemplate(e: ts.Expression): string | null {
  const unwrap = (x: ts.Expression): ts.Expression => {
    if (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isNonNullExpression(x)) return unwrap(x.expression);
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "encodeURIComponent" && x.arguments[0]) return unwrap(x.arguments[0]);
    return x;
  };
  const name = (x: ts.Expression): string => {
    const u = unwrap(x);
    const t = ts.isIdentifier(u) ? u.text : ts.isPropertyAccessExpression(u) ? u.name.text : "param";
    return t === "project" ? "projectSlug" : t === "org" ? "orgSlug" : t;
  };
  let out: string | null = null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out = e.text;
  else if (ts.isTemplateExpression(e)) out = e.head.text + e.templateSpans.map((sp) => `{${name(sp.expression)}}` + sp.literal.text).join("");
  return out !== null && out.startsWith("/") ? out : null;
}

/** `rawRequest(args, "GET", path)` or `request(config, { method: "GET", path })`: the route a call sends. */
function restRoute(call: ts.CallExpression): string | null {
  const a = call.arguments;
  for (let i = 0; i + 1 < a.length; i++) {
    const m = strLit(a[i]!);
    if (m !== null && HTTP.test(m)) {
      const path = routeTemplate(a[i + 1]!);
      if (path !== null) return `${m} ${path}`;
    }
  }
  for (const x of a) {
    if (!ts.isObjectLiteralExpression(x)) continue;
    let method: string | null = null;
    let path: string | null = null;
    for (const pr of x.properties) {
      if (!ts.isPropertyAssignment(pr) || !ts.isIdentifier(pr.name)) continue;
      if (pr.name.text === "method") method = strLit(pr.initializer);
      if (pr.name.text === "path") path = routeTemplate(pr.initializer);
    }
    if (method !== null && HTTP.test(method) && path !== null) return `${method} ${path}`;
  }
  return null;
}

interface Ctx {
  path: string[];
  /** A variable whose value is known here: a dispatch word already chosen, or a parameter bound to a literal. */
  known: Map<string, string>;
  /** Variables that hold a client chain: `const table = client.from(c)`. */
  alias: Map<string, string[]>;
}

const fork = (c: Ctx, path = c.path): Ctx => ({ path, known: new Map(c.known), alias: new Map(c.alias) });

class Walker {
  hits = new Map<string, Hit>();
  /** The nested dispatcher function a path hands over to (`dispatchFunctionTrigger` at "function trigger"). */
  dispatchers = new Map<string, { file: string; name: string }>();
  private seen = new Set<string>();

  private hit(path: string[]): Hit {
    const key = path.join(" ");
    let h = this.hits.get(key);
    if (!h) this.hits.set(key, (h = { path: [...path], sdk: [], rest: new Set(), required: new Set() }));
    return h;
  }

  fn(file: string, name: string, path: string[], bound: Map<string, string> = new Map()): void {
    const key = `${file}#${name}#${path.join(" ")}#${[...bound].map(([k, v]) => `${k}=${v}`).sort().join(",")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const src = loadSrc(file);
    const node = src.fns.get(name);
    if (!node) return;
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) this.node(body, { path, known: new Map(bound), alias: new Map() }, src);
  }

  private bindArgs(call: ts.CallExpression, fnNode: ts.Node, ctx: Ctx): Map<string, string> {
    const bound = new Map<string, string>();
    const params = (fnNode as ts.FunctionLikeDeclaration).parameters ?? [];
    call.arguments.forEach((a, i) => {
      const p = params[i];
      if (!p || !ts.isIdentifier(p.name)) return;
      const lit = strLit(a);
      if (lit !== null) bound.set(p.name.text, lit);
      else if (ts.isIdentifier(a) && ctx.known.has(a.text)) bound.set(p.name.text, ctx.known.get(a.text)!);
    });
    return bound;
  }

  node(n: ts.Node, ctx: Ctx, src: Src): void {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      let here = ctx;
      for (const st of n.statements) {
        // `if (group !== "locations") { ...; return; }`: everything after it is the "locations" branch
        if (ts.isIfStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && terminates(st.thenStatement)) {
          const l = strLit(st.expression.right);
          const key = tokenExpr(st.expression.left);
          if (l !== null && key !== null && !here.known.has(key)) {
            this.node(st, here, src);
            const next = fork(here, [...here.path, l]);
            next.known.set(key, l);
            this.hit(next.path);
            here = next;
            continue;
          }
        }
        ctx = here;
        this.node(st, ctx, src);
        // `if (verb === "insert") { ...; return x; }` with verb known to be "insert": nothing after it runs
        if (ts.isIfStatement(st)) {
          const d = dispatchLiterals(st.expression, true);
          const known = d ? ctx.known.get(d.key) : undefined;
          if (d && known !== undefined && d.lits.includes(known) && terminates(st.thenStatement)) break;
        }
      }
      return;
    }
    if (ts.isIfStatement(n)) {
      const d = dispatchLiterals(n.expression, true);
      if (d !== null) {
        const known = ctx.known.get(d.key);
        if (known !== undefined) {
          // the value is already chosen: only one side can run
          if (d.lits.includes(known)) this.node(n.thenStatement, ctx, src);
          else if (n.elseStatement) this.node(n.elseStatement, ctx, src);
          return;
        }
        if (tokenCompareAny(n.expression)) {
          for (const lit of d.lits) {
            const c = fork(ctx, [...ctx.path, lit]);
            c.known.set(d.key, lit);
            this.hit(c.path);
            this.node(n.thenStatement, c, src);
          }
          if (n.elseStatement) this.node(n.elseStatement, ctx, src);
          return;
        }
      }
    }
    if (ts.isSwitchStatement(n)) {
      const key = tokenExpr(n.expression) ?? (ts.isIdentifier(n.expression) ? n.expression.text : null);
      if (key !== null) {
        const known = ctx.known.get(key);
        for (const cl of n.caseBlock.clauses) {
          const lit = ts.isCaseClause(cl) ? strLit(cl.expression) : null;
          if (known !== undefined) {
            if (lit === known || (lit === null && ts.isDefaultClause(cl))) for (const st of cl.statements) this.node(st, ctx, src);
            continue;
          }
          if (lit !== null && tokenExpr(n.expression) !== null) {
            const c = fork(ctx, [...ctx.path, lit]);
            c.known.set(key, lit);
            this.hit(c.path);
            for (const st of cl.statements) this.node(st, c, src);
          } else for (const st of cl.statements) this.node(st, ctx, src);
        }
        return;
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const parts = chainParts(n.initializer, ctx.alias);
      if (parts !== null && parts.length > 0) ctx.alias.set(n.name.text, parts);
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && ctx.path.length > 0) {
      for (const m of n.text.matchAll(/requires? --([a-z][a-z0-9-]*)|--([a-z][a-z0-9-]*) is required/g)) this.hit(ctx.path).required.add(m[1] ?? m[2]!);
    }
    if (ts.isCallExpression(n) && ctx.path.length > 0) {
      const route = restRoute(n);
      if (route !== null) this.hit(ctx.path).rest.add(route);
    }
    if (ts.isCallExpression(n)) {
      const sdk = sdkChain(n, ctx.alias);
      if (sdk !== null && ctx.path.length > 0) {
        const h = this.hit(ctx.path);
        if (!h.sdk.includes(sdk)) h.sdk.push(sdk);
      }
      if (ts.isIdentifier(n.expression)) {
        const callee = n.expression.text;
        if (src.fns.has(callee)) this.fn(src.file, callee, ctx.path, this.bindArgs(n, src.fns.get(callee)!, ctx));
        else {
          const target = src.imports.get(callee);
          if (target && existsSync(target) && (callee.startsWith("dispatch") || callee.startsWith("cmd"))) {
            if (callee.startsWith("dispatch")) this.dispatchers.set(ctx.path.join(" "), { file: target, name: callee });
            this.fn(target, callee, ctx.path);
          }
        }
      }
    }
    ts.forEachChild(n, (c) => this.node(c, ctx, src));
  }
}

function terminates(st: ts.Statement): boolean {
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
  if (ts.isBlock(st)) {
    const last = st.statements[st.statements.length - 1];
    return last !== undefined && terminates(last);
  }
  return false;
}

/** True when the condition's comparisons are on a dispatch word (`sub`, `args.positional[2]`), not an arbitrary variable. */
function tokenCompareAny(e: ts.Expression): boolean {
  return dispatchLiterals(e, false) !== null;
}

interface Group {
  name: string;
  aliases: string[];
  file: string;
  fn: string;
}

/** The command groups `main()` dispatches to: `if (cmd === "x" || cmd === "y") return await dispatchZ(args)`. */
function readGroups(): Group[] {
  const index = loadSrc(join(SRC, "index.ts"));
  const main = index.fns.get("main");
  const groups: Group[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      const lits = ts.isBinaryExpression(n.expression) || ts.isParenthesizedExpression(n.expression) ? cmdLiterals(n.expression) : cmdLiteral(n.expression);
      if (lits.length > 0) {
        let callee: string | null = null;
        const find = (c: ts.Node): void => {
          if (callee === null && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && (c.expression.text.startsWith("dispatch") || c.expression.text.startsWith("cmd")) && c.arguments[0] !== undefined && ts.isIdentifier(c.arguments[0]) && c.arguments[0].text === "args") callee = c.expression.text;
          if (callee === null) ts.forEachChild(c, find);
        };
        find(n.thenStatement);
        if (callee !== null && !groups.some((g) => g.name === lits[0])) {
          const target = index.imports.get(callee);
          if (target) groups.push({ name: lits[0]!, aliases: lits.slice(1), file: target, fn: callee });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  if (main && (main as ts.FunctionDeclaration).body) visit((main as ts.FunctionDeclaration).body!);
  return groups;
}

function cmdLiteral(e: ts.Expression): string[] {
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isIdentifier(e.left) && e.left.text === "cmd") {
    const l = strLit(e.right);
    return l === null ? [] : [l];
  }
  return [];
}

function cmdLiterals(e: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(e)) return cmdLiterals(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...cmdLiterals(e.left), ...cmdLiterals(e.right)];
  return cmdLiteral(e);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

async function captureHelp(argv: string[]): Promise<string> {
  const { main } = await import(join(SRC, "index.ts"));
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

interface HelpEntry {
  path: string[]; // words after the group
  usage: string; // the signature after the path, whitespace collapsed
  description: string;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/**
 * Entries of a group's help block. Two layouts are in use:
 *   `  read <slug> [--from <t>]      Description`            (SUBCOMMANDS)
 *   `  members  list|invite|remove   list: --status ...`      (GROUPS: `<group> <verb>|<verb>`, flags on `verb:` lines)
 */
function helpEntries(help: string): HelpEntry[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => /^(SUBCOMMANDS|GROUPS|VERBS|USE)\s*$/.test(l));
  if (start < 0) return [];
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" && block.length > 0 && (lines[i + 1] === undefined || lines[i + 1]!.trim() === "" || indentOf(lines[i + 1]!) === 0)) break;
    if (l.trim() !== "" && indentOf(l) === 0) break;
    block.push(l);
  }
  const out: HelpEntry[] = [];
  const GROUP_LINE = /^ {2}([a-z][a-z0-9-]*)\s{2,}([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+)(?:\s{2,}(.*))?$/;
  let cur: { sig: string; desc: string[] } | null = null;
  let group: { name: string; verbs: string[]; verbDesc: Map<string, string>; verbSig: Map<string, string>; desc: string } | null = null;
  const flushCur = (): void => {
    if (cur) {
      const sig = cur.sig.replace(/\s+/g, " ").trim();
      const words = sig.split(" ");
      const path: string[] = [];
      for (const w of words) {
        if (/^[a-z][a-z0-9-]*$/.test(w)) path.push(w);
        else break;
      }
      out.push({ path, usage: sig.slice(path.join(" ").length).trim(), description: cur.desc.join(" ").replace(/\s+/g, " ").trim() });
    }
    cur = null;
  };
  const flushGroup = (): void => {
    if (group) {
      for (const v of group.verbs) {
        out.push({ path: [group.name, v], usage: group.verbSig.get(v) ?? "", description: group.verbDesc.get(v) ?? group.desc });
      }
    }
    group = null;
  };
  for (const raw of block) {
    if (raw.trim() === "") continue;
    const ind = indentOf(raw);
    const gm = GROUP_LINE.exec(raw);
    if (ind === 2 && gm) {
      flushCur();
      flushGroup();
      const verbs = gm[2]!.split("|");
      group = { name: gm[1]!, verbs, verbDesc: new Map(), verbSig: new Map(), desc: (gm[3] ?? "").trim() };
      const inline = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(gm[3] ?? "");
      if (inline) group.verbSig.set(inline[1]!, inline[2]!.trim());
      continue;
    }
    if (group && ind > 2) {
      const vm = /^\s+([a-z][a-z0-9-]*):\s*(.*)$/.exec(raw);
      if (vm && group.verbs.includes(vm[1]!)) {
        group.verbSig.set(vm[1]!, (group.verbSig.get(vm[1]!) ?? "") + (group.verbSig.has(vm[1]!) ? " " : "") + vm[2]!.trim());
        (group as { last?: string }).last = vm[1]!;
      } else {
        const last = (group as { last?: string }).last;
        if (last) group.verbSig.set(last, `${group.verbSig.get(last) ?? ""} ${raw.trim()}`.trim());
      }
      continue;
    }
    if (ind === 2) {
      flushGroup();
      flushCur();
      // `name  description` (two spaces or more), or one long signature line with single spaces
      const body = raw.slice(2);
      const split = /\s{2,}/.exec(body);
      if (split && split.index > 0) {
        cur = { sig: body.slice(0, split.index), desc: [body.slice(split.index).trim()] };
      } else cur = { sig: body, desc: [] };
      continue;
    }
    // indented continuation: signature continuation (left of the description column) or description text
    if (cur) {
      if (ind < 30) {
        const split = /\s{2,}/.exec(raw.trim());
        if (split && split.index > 0 && ind + split.index < 30 + 20) {
          cur.sig += " " + raw.trim().slice(0, split.index);
          cur.desc.push(raw.trim().slice(split.index).trim());
        } else cur.sig += " " + raw.trim();
      } else cur.desc.push(raw.trim());
    }
  }
  flushCur();
  flushGroup();
  return out;
}

// ---------------------------------------------------------------------------
// Usage strings -> positionals, flags, and the minimal runnable sample
// ---------------------------------------------------------------------------

interface Positional {
  name: string;
  optional: boolean;
}
interface Flag {
  name: string;
  value: string | null;
  optional: boolean;
}

interface Parsed {
  positionals: Positional[];
  flags: Flag[];
  sample: string[]; // words of the shortest call that satisfies the usage line
  usage: string; // the usage line with a placeholder after every flag that takes a value
}

/** Words of a usage line, with brackets and parentheses split off. `[--a <x>]` -> "[", "--a", "<x>", "]". */
function usageWords(usage: string): string[] {
  const words: string[] = [];
  let cur = "";
  let angle = 0;
  for (const ch of usage) {
    if (ch === "<") angle++;
    if (ch === ">") angle = Math.max(0, angle - 1);
    if (angle === 0 && (ch === "[" || ch === "]" || ch === "(" || ch === ")")) {
      if (cur) words.push(cur);
      words.push(ch);
      cur = "";
    } else if (angle === 0 && /\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

const isBracket = (w: string): boolean => w === "[" || w === "]" || w === "(" || w === ")" || w === "|";

function joinWords(words: string[]): string {
  let out = "";
  let prev = "";
  for (const w of words) {
    if (out === "") out = w;
    else if (prev === "[" || prev === "(" || w === "]" || w === ")") out += w;
    else out += " " + w;
    prev = w;
  }
  return out;
}

/**
 * Reads a usage line. A flag takes the next word as its value unless the code reads it as a switch (`booleans`); a flag
 * with no value word gets `<name>`, so every sample shows what goes where. A word outside `[ ]` is required; inside
 * `( a | b )` only the first alternative is kept in the sample.
 */
function parseUsage(usage: string, booleans: Set<string>): Parsed {
  const words = usageWords(usage);
  const positionals: Positional[] = [];
  const flags: Flag[] = [];
  const sample: string[] = [];
  const norm: string[] = [];
  let optDepth = 0;
  let parenDepth = 0;
  let altSkip = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "[") { optDepth++; norm.push(w); continue; }
    if (w === "]") { optDepth = Math.max(0, optDepth - 1); norm.push(w); continue; }
    if (w === "(") { parenDepth++; norm.push(w); continue; }
    if (w === ")") { parenDepth = Math.max(0, parenDepth - 1); if (parenDepth === 0) altSkip = false; norm.push(w); continue; }
    if (w === "|") { if (parenDepth > 0) altSkip = true; norm.push(w); continue; }
    const optional = optDepth > 0 || altSkip;
    if (w.startsWith("--")) {
      const name = w.slice(2);
      let value: string | null = null;
      const next = words[i + 1];
      if (!booleans.has(name)) {
        if (next !== undefined && !isBracket(next) && !next.startsWith("--") && next !== "...") {
          value = next;
          i++;
        } else value = `<${name}>`;
      }
      flags.push({ name, value, optional });
      norm.push(w, ...(value !== null ? [value] : []));
      if (!optional) sample.push(w, ...(value !== null ? [value] : []));
    } else if (w.startsWith("<")) {
      positionals.push({ name: /^<([^>]*)>/.exec(w)?.[1] ?? w, optional });
      norm.push(w);
      if (!optional) sample.push(w);
    } else {
      norm.push(w);
      if (w !== "..." && !optional && !w.startsWith("-")) sample.push(w); // a literal word, e.g. `insert|update|delete`
    }
  }
  return { positionals, flags, sample, usage: joinWords(norm) };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestCommand {
  /** The words after `k9o`: ["analytics", "rollups", "create"]. */
  path: string[];
  /** Other first words that run the same command. */
  aliases: string[];
  /** The signature as the command's help prints it, with `k9o <path>` in front. */
  usage: string;
  /** The shortest call that satisfies the usage line: required positionals and required flags with placeholders. */
  sample: string;
  description: string;
  positionals: Positional[];
  flags: Flag[];
  /** The SDK methods the command calls, as `x-sdk-method` writes them. Empty when the command makes no API call. */
  sdkMethods: string[];
  /** Gateway routes the command calls over REST (`METHOD /path/{template}`), as `openapi.json` writes them. Set only
   *  when the command has no SDK method: it reaches the gateway without one. */
  restRoutes: string[];
}

export interface Manifest {
  schema: 1;
  commands: ManifestCommand[];
  /** `x-sdk-method` -> the commands that call it (paths joined by a space). The first is the one to show. */
  sdkMethodIndex: Record<string, string[]>;
  /** `METHOD /path/{template}` -> the commands that call it over REST. The first is the one to show. */
  restRouteIndex: Record<string, string[]>;
}

/** A nested dispatcher's help: `k9o function trigger --help`, or the dispatcher called with no subcommand. */
async function nestedHelp(w: Walker, path: string[]): Promise<string> {
  const viaMain = await captureHelp([...path, "--help"]);
  const d = w.dispatchers.get(path.join(" "));
  if (!d) return viaMain;
  const groupHelp = await captureHelp([path[0]!, "--help"]);
  if (viaMain !== groupHelp) return viaMain;
  const mod = (await import(d.file)) as Record<string, (a: { positional: string[]; flags: Record<string, string> }) => Promise<number>>;
  let buf = "";
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (x: unknown) => {
    buf += String(x);
    return true;
  };
  try {
    await mod[d.name]!({ positional: [...path], flags: {} });
  } finally {
    (process.stdout as unknown as { write: typeof real }).write = real;
  }
  return buf;
}

/** Flags a command file reads as switches: `args.flags["dry-run"] === "true"`, `switchPair(args, "x", ...)`. */
function booleanFlags(file: string): Set<string> {
  const text = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/flags\[\s*"([a-z][a-z0-9-]*)"\s*\]\s*(?:===|!==)\s*"true"/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(?:boolFlag|switchPair|hasFlag)\(\s*args\s*,\s*"([a-z][a-z0-9-]*)"/g)) out.add(m[1]!);
  for (const m of text.matchAll(/flags\[\s*"([a-z][a-z0-9-]*)"\s*\]\s*===\s*undefined/g)) void m;
  return out;
}

function addRequiredFlag(c: ManifestCommand, name: string): void {
  c.flags.push({ name, value: `<${name}>`, optional: false });
  c.usage = `${c.usage} --${name} <${name}>`;
  c.sample = `${c.sample} --${name} <${name}>`;
}

const camelOf = (w: string): string => w.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const methodName = (sdk: string): string => /\.([A-Za-z0-9]+)\(\)$/.exec(sdk)?.[1] ?? "";

/** `k9o <group> [words] <usage>` lines of a help text's USAGE block, for a command that has no subcommand list. */
function usageEntries(help: string, prefix: string[]): HelpEntry[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => /^USAGE\s*$/.test(l));
  if (start < 0) return [];
  const out: HelpEntry[] = [];
  const GENERIC = /^<(subcommand|group|verb|command|slug)>/;
  let cur: string | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const words = cur.replace(/\s+/g, " ").trim().split(" ");
    const lead = words.slice(1, 1 + prefix.length).join(" ");
    cur = null;
    if (lead !== prefix.join(" ")) return;
    const rest = words.slice(1 + prefix.length);
    const path: string[] = [];
    for (const w of rest) {
      if (/^[a-z][a-z0-9-]*$/.test(w) && !GENERIC.test(w)) path.push(w);
      else break;
    }
    const usage = rest.slice(path.length).join(" ");
    if (GENERIC.test(usage) || /\[args\.\.\.\]/.test(usage)) return;
    if (out.some((o) => o.path.join(" ") === path.join(" "))) return;
    out.push({ path, usage, description: "" });
  };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && indentOf(l) === 0) break;
    if (/^ {2}k9o /.test(l)) {
      flush();
      cur = l.trim();
    } else if (cur !== null && l.trim() !== "" && indentOf(l) >= 6 && /^[[(-]/.test(l.trim())) cur += " " + l.trim();
    else flush();
  }
  flush();
  return out;
}

/** First sentence of the top-level help line for a command group: its description. */
function topLevelDescriptions(help: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of help.split("\n")) {
    const mm = /^ {2}([a-z][a-z0-9-]*)\s{2,}(\S.*)$/.exec(l);
    if (mm) m.set(mm[1]!, mm[2]!.trim());
  }
  return m;
}

export async function buildManifest(): Promise<Manifest> {
  const groups = readGroups();
  const top = topLevelDescriptions(await captureHelp(["--help"]));
  const commands: ManifestCommand[] = [];

  const add = (g: Group, path: string[], e: HelpEntry, sdk: string[], required: Set<string> = new Set(), file = g.file, rest: Set<string> = new Set()): void => {
    const booleans = booleanFlags(file);
    let usage = e.usage;
    // a flag the usage line does not show but the code requires
    for (const r of required) {
      if (!new RegExp(`--${r}(?![a-z0-9-])`).test(usage)) usage = `${usage} --${r}`.trim();
    }
    const parsed = parseUsage(usage, booleans);
    usage = parsed.usage;
    commands.push({
      path,
      aliases: g.aliases,
      usage: `k9o ${path.join(" ")}${usage ? " " + usage : ""}`,
      sample: ["k9o", ...path, ...parsed.sample].join(" "),
      description: e.description || (path.length === 1 ? top.get(path[0]!) ?? "" : ""),
      positionals: parsed.positionals,
      flags: parsed.flags,
      sdkMethods: sdk,
      restRoutes: sdk.length === 0 ? [...rest].sort() : [],
    });
  };

  for (const g of groups) {
    const w = new Walker();
    w.fn(g.file, g.fn, [g.name]);
    const paths = [...w.hits.values()];
    const hitAt = (p: string[]): Hit | undefined => w.hits.get(p.join(" "));
    const own: ManifestCommand[] = [];
    const before = commands.length;

    const help = await captureHelp([g.name, "--help"]);
    let entries = helpEntries(help);
    if (entries.length === 0) entries = usageEntries(help, [g.name]);

    // `audit  query  Org-plane audit...`: one verb written as the first word of the description
    entries = entries.map((e) => {
      const full = [g.name, ...e.path];
      const word = e.description.split(" ")[0] ?? "";
      if (e.path.length > 0 && !hitAt(full)?.sdk.length && hitAt([...full, word])) return { ...e, path: [...e.path, word], description: e.description.slice(word.length).trim() };
      return e;
    });

    for (const e of entries) {
      let full = [g.name, ...e.path];
      let hit = hitAt(full);
      if ((!hit || hit.sdk.length === 0) && e.path.length > 0) {
        // `storage create` in the help is `storage locations create` in the dispatcher: a unique deeper path ending the same way
        const deeper = paths.filter((h) => h.path.length > full.length && h.path[0] === g.name && h.path.slice(-e.path.length).join(" ") === e.path.join(" "));
        if (deeper.length === 1) {
          hit = deeper[0];
          full = hit!.path;
        }
      }
      if (!hit && e.path.length === 0 && !paths.some((h) => h.path.length === 1)) {
        // a leaf command with no branch of its own: its calls were recorded at the group
        hit = hitAt([g.name]);
      }
      add(g, full, e, hit ? hit.sdk : [], hit ? hit.required : new Set(), g.file, hit ? hit.rest : new Set());
    }
    own.push(...commands.slice(before));

    // Subcommands the group's help only points at (`k9o function trigger --help`, `k9o storage buckets`): read their own help.
    const nested = paths.filter(
      (h) => h.path.length >= 2 && paths.some((c) => c.path.length > h.path.length && c.path.slice(0, h.path.length).join(" ") === h.path.join(" ")),
    );
    for (const n of nested) {
      const at = own.find((c) => c.path.join(" ") === n.path.join(" "));
      const pointer = at !== undefined && /^k9o \S+(?: \S+)* <[a-z-]+(\|[a-z-]+)+>/.test(at.usage);
      if (at !== undefined && !pointer) continue;
      if (own.some((c) => c.path.length > n.path.length && c.path.slice(0, n.path.length).join(" ") === n.path.join(" "))) continue;
      const nh = await nestedHelp(w, n.path);
      const d = w.dispatchers.get(n.path.join(" "));
      let ne = helpEntries(nh).map((e) => ({ ...e, path: [...n.path.slice(1), ...e.path] }));
      if (ne.length === 0) ne = usageEntries(nh, n.path).map((e) => ({ ...e, path: [...n.path.slice(1), ...e.path] }));
      for (const e of ne) {
        const full = [g.name, ...e.path];
        const exact = hitAt(full);
        if (exact === undefined && e.path.length === n.path.length - 1) continue; // the group's own line
        add(g, full, e, exact ? exact.sdk : [], exact ? exact.required : new Set(), d?.file ?? g.file, exact ? exact.rest : new Set());
      }
    }
    // drop a command that is only the heading of nested ones (`function trigger` once `function trigger list` exists)
    for (let i = commands.length - 1; i >= before; i--) {
      const c = commands[i]!;
      if (commands.some((o, j) => j !== i && o.path.length > c.path.length && o.path.slice(0, c.path.length).join(" ") === c.path.join(" "))) commands.splice(i, 1);
    }

    // A branch that ends the dispatch chain without a test (`// create` after the `if (verb === "list")` blocks, or
    // `run(args, sub)` for encrypt|decrypt|rewrap) runs as the parent's own code. Its calls are the ones the command
    // is named for; failing that, exactly one sibling without a call of its own takes them all.
    const mine = commands.slice(before);
    const byParent = new Map<string, ManifestCommand[]>();
    for (const c of mine.filter((x) => x.path.length >= 2)) {
      const k = c.path.slice(0, -1).join(" ");
      byParent.set(k, [...(byParent.get(k) ?? []), c]);
    }
    for (const [parentKey, kids] of byParent) {
      const parent = w.hits.get(parentKey);
      if (!parent || parent.sdk.length === 0) continue;
      const bare = kids.filter((k) => k.sdkMethods.length === 0);
      for (const k of bare) {
        const named = parent.sdk.filter((m) => methodName(m) === camelOf(k.path[k.path.length - 1]!));
        if (named.length === 1) {
          k.sdkMethods = named;
          for (const r of parent.required) if (!k.flags.some((f) => f.name === r)) addRequiredFlag(k, r);
        }
      }
      const still = kids.filter((k) => k.sdkMethods.length === 0);
      const unclaimed = parent.sdk.filter((m) => !kids.some((k) => k.sdkMethods.includes(m)));
      if (still.length === 1 && unclaimed.length > 0) still[0]!.sdkMethods = unclaimed;
    }
  }

  commands.sort((a, b) => a.path.join(" ").localeCompare(b.path.join(" ")));
  // Several commands can call one method (`vault-secret create` and `byos-cred create`). The first one listed is the
  // command to show: the one whose words appear in the method's own namespace (vault + secret in kibo.vault.secrets).
  const stem = (w: string): string => w.toLowerCase().replace(/s$/, "");
  const words = (s: string): string[] => s.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map(stem);
  const score = (cmd: ManifestCommand, method: string): number => {
    const ns = new Set(words(method.replace(/^k9o\./, "")));
    return words(cmd.path[0]!).filter((w) => ns.has(w)).length;
  };
  const sdkMethodIndex: Record<string, ManifestCommand[]> = {};
  for (const c of commands) {
    for (const m of c.sdkMethods) (sdkMethodIndex[m] ??= []).push(c);
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(sdkMethodIndex).sort()) {
    sorted[k] = sdkMethodIndex[k]!
      .sort((a, b) => score(b, k) - score(a, k) || a.path.join(" ").localeCompare(b.path.join(" ")))
      .map((c) => c.path.join(" "));
  }
  const restIdx: Record<string, string[]> = {};
  for (const c of commands) for (const r of c.restRoutes) (restIdx[r] ??= []).push(c.path.join(" "));
  const restSorted: Record<string, string[]> = {};
  for (const k of Object.keys(restIdx).sort()) restSorted[k] = restIdx[k]!.sort();
  return { schema: 1, commands, sdkMethodIndex: sorted, restRouteIndex: restSorted };
}

export function render(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

if (import.meta.main) {
  const m = await buildManifest();
  writeFileSync(MANIFEST_PATH, render(m));
  const withSdk = m.commands.filter((c) => c.sdkMethods.length > 0).length;
  const withRest = m.commands.filter((c) => c.restRoutes.length > 0).length;
  console.log(`command-manifest.json: ${m.commands.length} commands, ${withSdk} call the API, ${Object.keys(m.sdkMethodIndex).length} distinct SDK methods, ${withRest} call the gateway over REST (${Object.keys(m.restRouteIndex).length} routes)`);
}
