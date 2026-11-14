/**
 * `k9o crypto encrypt|decrypt|rewrap|mode`, over `client.crypto`.
 *
 * Encryption with the project's key. The routing (platform or your own KMS or HSM) happens in `@k9o/core`; this command
 * only renders the result. `mode` prints the project's custody mode and epoch. `federated-token` writes a short-lived identity token to a file or an open file descriptor, never to stdout unless `--out -` is given. One item comes from `--in` (a file, or `-` for stdin); a batch of up to
 * 100 comes from `--items-file` (a JSON array). Ciphertext is base64 text. Plaintext is read and written as raw bytes, or
 * as base64 text with `--encoding base64`. Nothing is retried: a failure is printed with its code and the exit code
 * follows the CLI's error map.
 */

import { CRYPTO_MAX_ITEMS, KError, type CiphertextResult, type CryptoItemFailure, type PlaintextResult } from "@k9o/core";
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, usageError, valueFlag } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o crypto — encrypt and decrypt data with the project's key

USAGE
  k9o crypto <subcommand> --crypt <name> [flags...]
  k9o crypto mode [--crypt <name>]
  k9o crypto federated-token --crypt <name> --out <file> | --out-fd <n> [--op encrypt|decrypt|rewrap] [--force]

SUBCOMMANDS
  encrypt                       Encrypt plaintext; prints the ciphertext as base64 text
  decrypt                       Decrypt a ciphertext; writes the plaintext
  rewrap                        Open a ciphertext and seal it again under the project's current
                                key version, in one call; prints the new ciphertext
  mode                          Print the project's custody mode and epoch. Give --crypt to ask about that
                                crypt: a token or workload policy scoped to named crypts is refused without it
  federated-token              Write a short-lived identity token (at most 15 minutes) for your own
                                cloud's token exchange (BYOK, HYOK); see FEDERATED TOKEN below

ROUTING
  encrypt checks the project's custody mode on every call and never sends plaintext to the
  platform when the key is in your own KMS or HSM (BYOK, HYOK). That needs the Kibo client core;
  without it the call fails with K9O_ZK_CLIENT_CORE_UNAVAILABLE (exit 73) and sends nothing.
  decrypt and rewrap try the platform first and reroute client-side for ciphertext that belongs
  to your own key. An unknown or missing custody mode fails with K9O_CRYPTO_CUSTODY_UNKNOWN and
  sends nothing; a failed mode call shows its own error.

FEDERATED TOKEN
  The token is a credential, so it is never printed by default. Name where it goes:
    --out <file>     Create the file with mode 0600. An existing file is refused unless --force, which
                     replaces it. The file holds the token exactly, with no trailing newline: the form
                     AWS_WEB_IDENTITY_TOKEN_FILE and Google external-account credentials read.
    --out-fd <n>     Write to an open file descriptor n (3 or higher), for a pipe or process substitution.
    --out -          Write to stdout, with one trailing newline. Only if you ask for it.
  stdout otherwise carries only expiresAt, issuer, subject, audience and kid (no token). Delete the file
  when you are done: it is a credential until it expires. --op is encrypt (default), decrypt or rewrap.
  No token is issued when the platform holds the key or the install is self-hosted (route server),
  or has none for your key's provider (route client-idp): K9O_CUSTODY_SERVER_ROUTE.

FLAGS
  --crypt <name>              Required. 1 to 64 characters of a-z, 0-9 and "-", not "actions". Give the same
                                crypt on decrypt that you gave on encrypt.
  --context <text>              Binds the ciphertext to this value (at most 256 bytes). Give the
                                same value on decrypt and rewrap.
  --in <file|->                 The input: plaintext (encrypt) or the base64 ciphertext (decrypt,
                                rewrap). A file, or - for stdin (the default).
  --out <file|->                Where the result goes: a file, or - for stdout (the default).
  --encoding utf8|base64        How the plaintext is written: utf8 (default) is the raw bytes;
                                base64 is base64 text. It applies to the plaintext of encrypt
                                (input) and decrypt (output).
  --items-file <file>           A batch of 1 to ${CRYPTO_MAX_ITEMS} items, a JSON array, instead of --in:
                                encrypt  [{"plaintext":"...","context":"..."}]
                                decrypt, rewrap  [{"ciphertext":"...","context":"..."}]
                                The result is a JSON array in the same order, each entry
                                {"ok":true,...} or {"ok":false,"code":"...","message":"..."}.
                                --context is the default for entries that give none.

Limits: 64 KiB of plaintext per item and 1 MiB per call. The ciphertext is one opaque base64
container: store it and hand it back unchanged. Nothing is retried; if a call fails, run it again
yourself. Extensions, end users and mobile cannot call it. The ciphertext is covered by the
project KEK's lifecycle only, not by per-subject erasure.

EXAMPLES
  echo -n "call back on Tuesday" | k9o crypto encrypt --crypt customer-notes --context customer:1042
  k9o crypto decrypt --crypt customer-notes --context customer:1042 --in note.enc --out note.txt
  k9o crypto rewrap --crypt customer-notes --context customer:1042 --in note.enc --out note.enc2
  k9o crypto encrypt --crypt customer-notes --items-file items.json --out sealed.json
  k9o crypto federated-token --crypt customer-notes --out /run/user/1000/k9o-token
  AWS_WEB_IDENTITY_TOKEN_FILE=/run/user/1000/k9o-token aws sts get-caller-identity
`.trim() + "\n");
}

type Op = "encrypt" | "decrypt" | "rewrap";
type Encoding = "utf8" | "base64";
type Failure = CryptoItemFailure;

export async function dispatchCrypto(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  if (sub !== "encrypt" && sub !== "decrypt" && sub !== "rewrap" && sub !== "mode" && sub !== "federated-token") {
    return usageError(format, `unknown crypto subcommand "${sub}"`, "Valid: encrypt | decrypt | rewrap | mode | federated-token");
  }
  try {
    if (sub === "mode") return await runMode(args, format);
    if (sub === "federated-token") return await runFederatedToken(args, format);
    return await run(args, sub, format);
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function runMode(args: ParsedArgs, format: OutputFormat): Promise<number> {
  const crypt = valueFlag(args, "crypt");
  if (typeof crypt === "object") return usageError(format, crypt.error);
  const { client } = clientFromProfile(args, { requireProject: true });
  const { data } = await client.crypto.mode(crypt);
  if (format === "json") process.stdout.write(JSON.stringify({ custodyMode: data.custodyMode, epoch: data.epoch }, null, 2) + "\n");
  else process.stdout.write(`custodyMode=${data.custodyMode}  epoch=${data.epoch}\n`);
  return EXIT_SUCCESS;
}

const FED_OPS = ["encrypt", "decrypt", "rewrap"] as const;

/** Create `path` with mode 0600 and write `token` to it. `force` replaces an existing file (written beside it, then renamed). */
function writeTokenFile(path: string, token: string, force: boolean): void {
  const fail = (e: unknown): never => {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      context: {},
    });
  };
  if (!force) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `${path} exists; pass --force to replace it`, context: {} });
      }
      return fail(e);
    }
    try {
      writeFileSync(fd, token);
    } catch (e) {
      closeSync(fd);
      try { unlinkSync(path); } catch { /* the partial file is empty or unreadable; nothing more to do */ }
      return fail(e);
    }
    closeSync(fd);
    return;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, token);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* it may not exist */ }
    return fail(e);
  }
}

async function runFederatedToken(args: ParsedArgs, format: OutputFormat): Promise<number> {
  const crypt = valueFlag(args, "crypt");
  if (typeof crypt === "object") return usageError(format, crypt.error);
  if (crypt === undefined) return usageError(format, "k9o crypto federated-token requires --crypt", "k9o crypto federated-token --crypt customer-notes --out ./token");
  const opRaw = valueFlag(args, "op") ?? "encrypt";
  if (typeof opRaw === "object") return usageError(format, opRaw.error);
  if (!(FED_OPS as readonly string[]).includes(opRaw)) return usageError(format, '--op must be "encrypt", "decrypt" or "rewrap"');
  const op = opRaw as (typeof FED_OPS)[number];
  const out = valueFlag(args, "out");
  if (typeof out === "object") return usageError(format, out.error);
  const fdRaw = intFlag(args, "out-fd", 3, 1 << 20);
  if (typeof fdRaw === "string") return usageError(format, fdRaw);
  if (out !== undefined && fdRaw !== undefined) return usageError(format, "use only one of --out and --out-fd");
  if (out === undefined && fdRaw === undefined) {
    return usageError(
      format,
      "k9o crypto federated-token needs somewhere to put the token: --out <file>, --out-fd <n> or --out -",
      "k9o crypto federated-token --crypt customer-notes --out ./token",
    );
  }
  if (args.flags["force"] !== undefined && out === undefined) return usageError(format, "--force applies to --out <file> only");
  const force = args.flags["force"] === "true";
  if (out !== undefined && out !== "-" && !force && existsSync(out)) {
    return usageError(format, `${out} exists; pass --force to replace it`, "k9o crypto federated-token --crypt customer-notes --out ./token --force");
  }
  if (fdRaw !== undefined) {
    try {
      fstatSync(fdRaw);
    } catch {
      return usageError(format, `--out-fd ${fdRaw} is not an open file descriptor`);
    }
  }

  const { client } = clientFromProfile(args, { requireProject: true });
  const { data } = await client.crypto.federatedToken({ crypt, op });

  let where: string;
  if (out === "-") {
    process.stdout.write(`${data.token}\n`);
    return EXIT_SUCCESS;
  } else if (out !== undefined) {
    writeTokenFile(out, data.token, force);
    where = out;
  } else {
    try {
      writeSync(fdRaw as number, data.token);
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to write to descriptor ${fdRaw}: ${e instanceof Error ? e.message : String(e)}`,
        context: {},
      });
    }
    where = `fd ${fdRaw}`;
  }
  const meta = { written: where, expiresAt: data.expiresAt, issuer: data.issuer, subject: data.subject, audience: data.audience, kid: data.kid };
  if (format === "json") process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
  else process.stdout.write(`written=${where}  expiresAt=${data.expiresAt}  issuer=${data.issuer}  audience=${data.audience}  subject=${data.subject}  kid=${data.kid}\n`);
  return EXIT_SUCCESS;
}

function failureError(f: Failure): KError {
  return new KError({ code: f.code, message: f.message ?? f.code, context: {} });
}

function readInput(path: string): Buffer {
  try {
    return readFileSync(path === "-" ? 0 : path);
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to read ${path === "-" ? "stdin" : path}: ${e instanceof Error ? e.message : String(e)}`,
      context: {},
    });
  }
}

function writeOutput(path: string, data: string | Uint8Array, secret: boolean): void {
  if (path === "-") {
    process.stdout.write(data);
    return;
  }
  writeFileSync(path, data, secret ? { mode: 0o600 } : undefined);
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromBase64(text: string, what: string): Uint8Array {
  const t = text.replace(/\s+/g, "");
  if (!B64.test(t)) throw new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `${what} is not valid base64`, context: {} });
  return new Uint8Array(Buffer.from(t, "base64"));
}

async function run(args: ParsedArgs, op: Op, format: OutputFormat): Promise<number> {
  const crypt = valueFlag(args, "crypt");
  if (typeof crypt === "object") return usageError(format, crypt.error);
  if (crypt === undefined) return usageError(format, `k9o crypto ${op} requires --crypt`, `k9o crypto ${op} --crypt customer-notes`);
  const context = valueFlag(args, "context");
  if (typeof context === "object") return usageError(format, context.error);
  const inPath = valueFlag(args, "in");
  if (typeof inPath === "object") return usageError(format, inPath.error);
  const outPath = valueFlag(args, "out") ?? "-";
  if (typeof outPath === "object") return usageError(format, outPath.error);
  const itemsFile = valueFlag(args, "items-file");
  if (typeof itemsFile === "object") return usageError(format, itemsFile.error);
  const enc = valueFlag(args, "encoding") ?? "utf8";
  if (typeof enc === "object") return usageError(format, enc.error);
  if (enc !== "utf8" && enc !== "base64") return usageError(format, '--encoding must be "utf8" or "base64"');
  const encoding: Encoding = enc;
  if (itemsFile !== undefined && inPath !== undefined) return usageError(format, "use only one of --in and --items-file");

  const { client } = clientFromProfile(args, { requireProject: true });

  if (itemsFile !== undefined) return runBatch(client, op, crypt, context, encoding, itemsFile, outPath, format);

  const input = readInput(inPath ?? "-");
  if (op === "encrypt") {
    const plaintext = encoding === "base64" ? fromBase64(input.toString("utf8"), "the input") : new Uint8Array(input);
    const res = await client.crypto.encrypt({ crypt, items: [{ plaintext, ...(context !== undefined ? { context } : {}) }] });
    const item = res.data.items[0]!;
    if (!item.ok) throw failureError(item);
    writeOutput(outPath, `${(item as CiphertextResult).ciphertext}\n`, false);
    return EXIT_SUCCESS;
  }
  const ciphertext = input.toString("utf8").trim();
  if (ciphertext.length === 0) return usageError(format, "the ciphertext input is empty");
  const items = [{ ciphertext, ...(context !== undefined ? { context } : {}) }];
  if (op === "rewrap") {
    const item = (await client.crypto.rewrap({ crypt, items })).data.items[0]!;
    if (!item.ok) throw failureError(item);
    writeOutput(outPath, `${(item as CiphertextResult).ciphertext}\n`, false);
    return EXIT_SUCCESS;
  }
  const item = (await client.crypto.decrypt({ crypt, items })).data.items[0]!;
  if (!item.ok) throw failureError(item);
  const bytes = (item as PlaintextResult).plaintext;
  writeOutput(outPath, encoding === "base64" ? `${Buffer.from(bytes).toString("base64")}\n` : bytes, true);
  return EXIT_SUCCESS;
}

async function runBatch(
  client: ReturnType<typeof clientFromProfile>["client"],
  op: Op,
  crypt: string,
  context: string | undefined,
  encoding: Encoding,
  itemsFile: string,
  outPath: string,
  format: OutputFormat,
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readInput(itemsFile).toString("utf8"));
  } catch (e) {
    if (e instanceof KError) throw e;
    return usageError(format, "--items-file must hold a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > CRYPTO_MAX_ITEMS) {
    return usageError(format, `--items-file must hold a JSON array of 1 to ${CRYPTO_MAX_ITEMS} items`);
  }
  const field = op === "encrypt" ? "plaintext" : "ciphertext";
  const raw: Array<{ value: string; context?: string }> = [];
  for (const [i, entry] of parsed.entries()) {
    const o = entry as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null || Array.isArray(o) || typeof o[field] !== "string") {
      return usageError(format, `--items-file entry ${i} needs a string "${field}"`);
    }
    const c = o["context"] ?? context;
    if (c !== undefined && typeof c !== "string") return usageError(format, `--items-file entry ${i}: "context" must be a string`);
    raw.push({ value: o[field] as string, ...(c !== undefined ? { context: c } : {}) });
  }

  let results: Array<Record<string, unknown>>;
  if (op === "encrypt") {
    const items = raw.map((r, i) => ({
      plaintext: encoding === "base64" ? fromBase64(r.value, `entry ${i} plaintext`) : r.value,
      ...(r.context !== undefined ? { context: r.context } : {}),
    }));
    results = (await client.crypto.encrypt({ crypt, items })).data.items.map(ciphertextEntry);
  } else {
    const items = raw.map((r) => ({ ciphertext: r.value.trim(), ...(r.context !== undefined ? { context: r.context } : {}) }));
    if (op === "rewrap") results = (await client.crypto.rewrap({ crypt, items })).data.items.map(ciphertextEntry);
    else results = (await client.crypto.decrypt({ crypt, items })).data.items.map((it) => plaintextEntry(it, encoding));
  }

  writeOutput(outPath, JSON.stringify(results, null, 2) + "\n", op === "decrypt");
  let code = EXIT_SUCCESS;
  for (const [i, r] of results.entries()) {
    if (r["ok"] === true) continue;
    const e = new KError({ code: String(r["code"]), message: `item ${i}: ${String(r["message"] ?? r["code"])}`, context: {} });
    emitError(format, e);
    if (code === EXIT_SUCCESS) code = exitCodeForError(e);
  }
  return code;
}

function ciphertextEntry(it: CiphertextResult | Failure): Record<string, unknown> {
  return it.ok ? { ok: true, ciphertext: it.ciphertext } : { ok: false, code: it.code, message: it.message };
}

function plaintextEntry(it: PlaintextResult | Failure, encoding: Encoding): Record<string, unknown> {
  if (!it.ok) return { ok: false, code: it.code, message: it.message };
  if (encoding === "base64") return { ok: true, plaintext: Buffer.from(it.plaintext).toString("base64") };
  if (it.text === undefined) return { ok: false, code: "K9O_INVALID_FIELD_VALUE", message: "the plaintext is not valid UTF-8; use --encoding base64" };
  return { ok: true, plaintext: it.text };
}
