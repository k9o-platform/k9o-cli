/**
 * `k9o end-user` subcommands: list / get, and `role-grant list|grant|revoke`, over `client.endUsers`.
 *
 * A role is any string (1 to 128 characters): there is no fixed list. Revoking an unknown or already revoked grant
 * is not an error: the answer says `revoked: false`.
 */

import type { EndUser, EndUserRoleGrant, EndUserStatus } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, textFlag, usageError } from "./json-flag.ts";

const STATUSES = ["active", "locked", "deleted", "all"];

function printHelp(): void {
  process.stdout.write(`
k9o end-user — the people who sign in to your project's apps, and their roles

USAGE
  k9o end-user <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--status active|locked|deleted|all] [--q <email prefix>] [--limit <1-200>] [--cursor <c>]
                                List end users, newest first (project admin). Default: active and
                                locked. Pass the printed cursor to --cursor for the next page.
  get <id>                      Show one end user (project admin)
  role-grant list [--end-user <id>]
                                List active role grants, oldest first. Not paginated.
  role-grant grant --end-user <id> --role <role>
                                Give an end user a role (project admin). The role is any string of
                                1 to 128 characters. Granting a role the user already holds is an
                                error.
  role-grant revoke <grant-id>  Revoke a grant (project admin). An unknown or already revoked id is
                                not an error: it prints revoked: false.

EXAMPLES
  k9o end-user list --q ada
  k9o end-user role-grant grant --end-user eu_YmGE3Z6nkv5i --role billing-manager
  k9o end-user role-grant revoke eurg_AbCdEf123456
`.trim() + "\n");
}

export async function dispatchEndUser(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "role-grant") {
      const action = args.positional[2];
      if (action === "list") return await cmdGrantList(args);
      if (action === "grant") return await cmdGrant(args);
      if (action === "revoke") return await cmdRevoke(args);
      return usageError(format, action === undefined ? "k9o end-user role-grant needs a subcommand" : `unknown end-user role-grant subcommand "${action}"`, "Valid: list | grant | revoke");
    }
    return usageError(format, `unknown end-user subcommand "${sub}"`, "Valid: list | get | role-grant");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function value(args: ParsedArgs, name: string): string | undefined | { error: string } {
  if (args.flags[name] === "true") return { error: `--${name} needs a value` };
  return textFlag(args, name);
}

function describeUser(u: EndUser): string {
  return `${u.id}  ${u.status.padEnd(7)}  ${u.email}  last sign-in ${u.lastSigninAt ?? "-"}`;
}

function describeGrant(g: EndUserRoleGrant): string {
  return `${g.id}  ${g.endUserId}  ${g.role}  granted ${g.grantedAt} by ${g.grantedBy}`;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const status = args.flags["status"];
  if (status !== undefined && !STATUSES.includes(status)) return usageError(format, `invalid --status "${status}"`, `Use one of: ${STATUSES.join(", ")}`);
  const q = value(args, "q");
  if (typeof q === "object") return usageError(format, q.error);
  const cursor = value(args, "cursor");
  if (typeof cursor === "object") return usageError(format, cursor.error);
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return usageError(format, limit);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.endUsers.list({
    ...(status !== undefined ? { status: status as EndUserStatus | "all" } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) =>
    rows.length === 0 ? "No end users." : ["End users:", ...rows.map((u) => `  ${describeUser(u)}`), ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n"));
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = args.positional[2];
  if (id === undefined || id.length === 0) return usageError(format, "k9o end-user get requires <id> (positional)", "k9o end-user get eu_YmGE3Z6nkv5i");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.endUsers.get(id), (u) => `End user ${describeUser(u)}\n  sign-in methods: ${u.signInMethods.join(", ") || "-"}\n  created: ${u.createdAt}`);
  return EXIT_SUCCESS;
}

async function cmdGrantList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const endUser = value(args, "end-user");
  if (typeof endUser === "object") return usageError(format, endUser.error);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.endUsers.roleGrants.list(endUser !== undefined ? { endUserId: endUser } : {});
  emitSuccess(format, envelope, (rows) => (rows.length === 0 ? "No role grants." : ["Role grants:", ...rows.map((g) => `  ${describeGrant(g)}`)].join("\n")));
  return EXIT_SUCCESS;
}

async function cmdGrant(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o end-user role-grant grant --end-user eu_YmGE3Z6nkv5i --role billing-manager";
  const endUser = value(args, "end-user");
  if (typeof endUser === "object") return usageError(format, endUser.error, example);
  const role = value(args, "role");
  if (typeof role === "object") return usageError(format, role.error, example);
  if (endUser === undefined) return usageError(format, "k9o end-user role-grant grant requires --end-user <id>", example);
  if (role === undefined) return usageError(format, "k9o end-user role-grant grant requires --role <role>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.endUsers.roleGrants.grant({ endUserId: endUser, role }), (g) => `Granted. ${describeGrant(g)}`);
  return EXIT_SUCCESS;
}

async function cmdRevoke(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = args.positional[3];
  if (id === undefined || id.length === 0) return usageError(format, "k9o end-user role-grant revoke requires <grant-id> (positional)", "k9o end-user role-grant revoke eurg_AbCdEf123456");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.endUsers.roleGrants.revoke(id), (r) =>
    r.revoked ? `Revoked ${id} at ${r.revokedAt}.` : `revoked: false. No active grant ${id} (unknown or already revoked).`);
  return EXIT_SUCCESS;
}
