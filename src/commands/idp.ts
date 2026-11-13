/**
 * `k9o idp` subcommands: list / create / update / test the identity providers your project's end users sign in with
 * (Google, GitHub, Microsoft, Apple, Facebook, X, OIDC, SAML, SCIM, LDAP, Active Directory), over `client.gate.identityProviders`.
 *
 * Needs a project admin. The client secret is write-only: it is read from an environment variable or a file, never
 * from a flag, so it stays out of shell history and process listings.
 */

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { jsonObjectFlag, textFlag, usageError } from "./json-flag.ts";

const PROVIDERS = ["google", "github", "microsoft", "apple", "facebook", "twitter", "oidc", "saml", "scim", "ldap", "active_directory"];
const FREE_TIER = ["google", "github", "microsoft", "apple", "facebook", "twitter"];

function printHelp(): void {
  process.stdout.write(`
k9o idp — the identity providers your project's end users sign in with

USAGE
  k9o idp <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List the project's providers (secrets are never shown)
  create --provider <kind> --display-name <name> --client-id <id>
         (--client-secret-env <VAR> | --client-secret-file <path>)
         [--redirect-origin <origin>[,<origin>...]] [--metadata-url <url>] [--attribute-map <json>] [--enable]
                                Register a provider (project admin). It is created disabled unless
                                you pass --enable. --redirect-origin is an origin of your web app
                                that may receive the sign-in result; separate several with commas.
  update <id> [--display-name <name>] [--client-id <id>] [--client-secret-env <VAR> | --client-secret-file <path>]
         [--redirect-origin <origin>[,<origin>...]] [--metadata-url <url>] [--attribute-map <json>] [--enable | --disable]
                                Change a provider (project admin). --redirect-origin replaces the
                                whole list.
  test <id>                     Check that the provider's endpoints are reachable and a secret is stored

PROVIDERS
  ${PROVIDERS.join(", ")}

EXAMPLES
  k9o idp create --provider google --display-name Google --client-id 1234.apps.googleusercontent.com \\
    --client-secret-env GOOGLE_CLIENT_SECRET --redirect-origin https://app.example.com --enable
  k9o idp test epc_8d21f4
`.trim() + "\n");
}

export async function dispatchIdp(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "create") return await cmdCreate(args);
    if (sub === "update") return await cmdUpdate(args);
    if (sub === "test") return await cmdTest(args);
    return usageError(format, `unknown idp subcommand "${sub}"`, "Valid: list | create | update | test");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/** The secret from `--client-secret-env` or `--client-secret-file`: undefined when neither is given, or an error. */
function secretFlag(args: ParsedArgs): string | undefined | { error: string } {
  const env = args.flags["client-secret-env"];
  const file = args.flags["client-secret-file"];
  if (env !== undefined && file !== undefined) return { error: "pass only one of --client-secret-env and --client-secret-file" };
  if (env !== undefined) {
    const v = process.env[env];
    if (env === "true" || v === undefined || v === "") return { error: `--client-secret-env needs the name of a set environment variable` };
    return v;
  }
  if (file !== undefined) {
    if (file === "true") return { error: "--client-secret-file needs a path" };
    try {
      return readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch {
      return { error: `cannot read --client-secret-file ${file}` };
    }
  }
  return undefined;
}

/** `--redirect-origin` may repeat; the parser keeps the last value, so a comma-separated list is accepted too. */
function originsFlag(args: ParsedArgs): string[] | undefined {
  const raw = args.flags["redirect-origin"];
  if (raw === undefined || raw === "true") return undefined;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function describe(p: { id: string; idpProvider: string; enabled: boolean; displayName: string }): string {
  return `${p.id.padEnd(14)}  ${p.idpProvider.padEnd(17)}  ${p.enabled ? "enabled " : "disabled"}  ${p.displayName}`;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.gate.identityProviders.list(), (rows) =>
    rows.length === 0 ? "No identity providers." : ["Identity providers:", ...rows.map((p) => `  ${describe(p)}`)].join("\n"));
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o idp create --provider google --display-name Google --client-id <id> --client-secret-env GOOGLE_CLIENT_SECRET --enable";
  const provider = textFlag(args, "provider");
  const displayName = textFlag(args, "display-name");
  const clientId = textFlag(args, "client-id");
  if (provider === undefined || displayName === undefined || clientId === undefined) {
    return usageError(format, "k9o idp create requires --provider, --display-name and --client-id", example);
  }
  if (!PROVIDERS.includes(provider)) return usageError(format, `invalid --provider "${provider}"`, `Use one of: ${PROVIDERS.join(", ")}`);
  const secret = secretFlag(args);
  if (typeof secret === "object") return usageError(format, secret.error, example);
  if (secret === undefined) return usageError(format, "k9o idp create requires --client-secret-env <VAR> or --client-secret-file <path>", example);
  const attributeMap = jsonObjectFlag(args, "attribute-map");
  if (typeof attributeMap === "string") return usageError(format, attributeMap);
  const origins = originsFlag(args);
  const metadataUrl = textFlag(args, "metadata-url");
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.gate.identityProviders.create({
    idpProvider: provider as never,
    displayName,
    clientId,
    clientSecretRef: secret,
    tierGating: FREE_TIER.includes(provider) ? "free_tier_ok" : "ridge_plus",
    enabled: args.flags["enable"] === "true",
    ...(origins !== undefined ? { allowedRedirectUris: origins } : {}),
    ...(metadataUrl !== undefined ? { metadataUrl } : {}),
    ...(attributeMap !== undefined ? { attributeMap: attributeMap as Record<string, string> } : {}),
  });
  emitSuccess(format, envelope, (p) => `Created ${describe(p)}\n  callback URL to add at the provider: ${p.redirectUri}`);
  return EXIT_SUCCESS;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = args.positional[2];
  if (id === undefined || id.length === 0) return usageError(format, "k9o idp update requires <id> (positional)", "k9o idp update epc_8d21f4 --disable");
  const secret = secretFlag(args);
  if (typeof secret === "object") return usageError(format, secret.error);
  const attributeMap = jsonObjectFlag(args, "attribute-map");
  if (typeof attributeMap === "string") return usageError(format, attributeMap);
  if (args.flags["enable"] === "true" && args.flags["disable"] === "true") return usageError(format, "pass only one of --enable and --disable");
  const origins = originsFlag(args);
  const displayName = textFlag(args, "display-name");
  const clientId = textFlag(args, "client-id");
  const metadataUrl = textFlag(args, "metadata-url");
  const patch = {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(secret !== undefined ? { clientSecretRef: secret } : {}),
    ...(origins !== undefined ? { allowedRedirectUris: origins } : {}),
    ...(metadataUrl !== undefined ? { metadataUrl } : {}),
    ...(attributeMap !== undefined ? { attributeMap: attributeMap as Record<string, string> } : {}),
    ...(args.flags["enable"] === "true" ? { enabled: true } : {}),
    ...(args.flags["disable"] === "true" ? { enabled: false } : {}),
  };
  if (Object.keys(patch).length === 0) return usageError(format, "k9o idp update needs at least one field to change", "k9o idp update epc_8d21f4 --disable");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.gate.identityProviders.update(id, patch), (p) => `Updated ${describe(p)}`);
  return EXIT_SUCCESS;
}

async function cmdTest(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = args.positional[2];
  if (id === undefined || id.length === 0) return usageError(format, "k9o idp test requires <id> (positional)", "k9o idp test epc_8d21f4");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.gate.identityProviders.testProvider(id), (r) =>
    r.ok ? "Reachable, and a secret is stored." : `Not ready: ${r.reason ?? "unknown"}.`);
  return EXIT_SUCCESS;
}
