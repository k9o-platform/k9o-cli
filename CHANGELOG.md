# Changelog — @k9o/cli

## 1.5.0 (unreleased)

### Added

- `command-manifest.json`, shipped in the package and generated from the CLI's own source with `bun run manifest`: every command with its usage line, a runnable sample, its flags and the SDK methods it calls (written as the OpenAPI `x-sdk-method` field writes them). A command that calls a gateway route directly, such as `k9o ext-admin list`, lists that route in `restRoutes` and in `restRouteIndex`. A test fails when the file is stale or names an SDK method the client does not have.
- Short forms for the three flags every command shares: `-O` for `--org`, `-P` for `--project` and `-p` for `--profile`. The long forms stay canonical.
- Keyless CI sign-in works with the default (key-bound) workload: the CLI keeps the exchange key in memory and sends a fresh DPoP proof with every request (method, URL and a hash of the token), so commands after the exchange are admitted. A workload registered in bearer mode keeps sending the plain Bearer token.
- `k9o idp list|create|update|test` for the identity providers your project's end users sign in with (project admin). The client secret is read from `--client-secret-env` or `--client-secret-file`, never from a flag.
- `k9o me api-tokens create --tier readonly|readwrite|admin` replaces `--operations`: a token has one tier, sent as `scopeManifest.tier`, and `list` shows it. A readonly token can still decrypt (decrypt counts as a read). Needs the gateway release that carries the tiers; the older `operations` form stops working at that release.
- `k9o crypto mode --crypt NAME` asks about that crypt (`GET /crypto/mode?crypt=NAME`), so a personal access token or workload policy scoped to named crypts can read the mode. Without it the call is unchanged.
- `k9o crypto federated-token --crypt K [--op encrypt|decrypt|rewrap] --out FILE|--out-fd N|--out - [--force]` writes the short-lived identity token for your own cloud's token exchange to a file (mode 0600, an existing file refused unless `--force`), an open file descriptor (3 or higher) or, only when asked, stdout. Without a destination it is a usage error. stdout otherwise shows `expiresAt`, `issuer`, `subject`, `audience` and `kid`, never the token.
- `k9o keys list [--all]|get <key-id>|rotate <key-id>` for the project's encryption keys (metadata only). `list` is not paged. `rotate` needs a fresh MFA step-up: when it is missing the CLI prints the requirement and the challenge, exits 66 and does not retry.
  `rotate --step-up-proof-cmd '<command>'` answers the challenge with your command: the challenge is JSON on its stdin, the method and URL are in `K9O_STEPUP_METHOD` and `K9O_STEPUP_URL`, and it prints `{"method":"dpop|mtls|webauthn","proof":"..."}`. The rotation is sent once more with the proof; the proof is never printed.
- `k9o crypto encrypt|decrypt|rewrap --crypt K [--context C] [--in FILE|-] [--out FILE|-] [--encoding utf8|base64]` for server-side encryption with the project's platform-managed key (encrypt checks the project's custody mode on every call; a project whose key is held in your own KMS or HSM, BYOK or HYOK, gets `K9O_ZK_CLIENT_CORE_UNAVAILABLE`, exit 73, with nothing sent, and should use client-side `kibo.encrypt` and `kibo.decrypt`; an unknown or missing custody mode answer fails with `K9O_CRYPTO_CUSTODY_UNKNOWN` and a failed mode call shows its own error, neither sending anything), `k9o crypto mode` to print the custody mode and epoch,, and `--items-file FILE` for a batch of up to 100. Nothing is retried; errors print with their code (for example `K9O_ENVELOPE_INTEGRITY_FAILURE`, exit 70).
- `k9o audit replay [--after-audit-event-id ID | --from-sequence N] [--limit N]` prints one page of audit events in order (`events`, `nextCursor`, `hasMore`).
- `k9o analytics` (aliases `dataset`, `datasets`): `list|get|create|delete|query|read|materialize|write|upload|download-original`, plus `rollups create|list|delete|reattest <dataset>` and `schedules create|list|delete|reattest <dataset>`.
  `upload` takes a file path (format from the extension, `--dry-run` to preview); `download-original --out <file>` saves the original upload. `reattest` is human-only: a service, workload or extension token is refused (`K9O_RBAC_DENY`, exit 67).
- `k9o rollups list|read|subscribe`; `subscribe` follows a rollup live, one cell (the payload) per line, until interrupted or `--count`. A suppressed cell shows its status and reason; a cell the stream re-sends prints once.
- `k9o audit tail [--type T ...] [--json]` now follows the audit log live, one event per line, until interrupted (Ctrl-C exits 0). `--type` may be repeated. `--json` is the same as `--output json`. Each event has `auditEventId`, `type`, `actorType`, `occurredAt`, `outcome` and `eventId` (the stream message's id), and prints once.
- `k9o audit recent [--since-minutes N] [--limit N]` is the previous one-off fetch of recent events (it was `audit tail`).
- `k9o metadata filter|set|search|nearest|index get|index declare` for declared metadata columns. `filter --surface <s> [--where <json>] [--limit N] [--cursor c]` prints `More: --cursor <c>` when another page exists;
  `set <collection> <id> --set <json>`; `search --surface S --field F --q Q`; `nearest --surface S --column C --embedding <json>|--embedding-file <path|-> [--k N] [--metric M]`;
  `index declare <collection> --columns <json>` replaces the declaration. Column names get the `metadata.` prefix when omitted.
- `k9o approvals list` takes `--cursor` and prints `More: --cursor <c>` when another page exists. `k9o approvals bulk` prints the rows that failed (`id  code  reason`) after the decided ids; the call itself still succeeds.
- `k9o approvals comment <id> --body <text> --visibility everyone|approvers_only` posts a comment on a pending change (`--visibility` is required, there is no default) and `k9o approvals comments <id> [--limit N] [--cursor c]` lists the comments you may see, oldest first, with `More: --cursor <c>` when another page exists.
- `k9o custody status` shows the project's key custody: mode, whether an external source is attached, provider, last job and, for an HSM, vendor, cluster and region (`--output json` prints the gateway answer). Read-only; needs the project-admin or project-auditor role.
- `k9o data insert|update|delete` write one record; `--require-approval` queues the write and prints the change id to decide with `k9o approvals`.
  `--data` takes JSON inline, `@file`, or `-` for stdin.
- `k9o function trigger list|create|update|delete` for a function's event triggers. `create` takes `--collection`, `--events insert,update`, `--filter`, `--disabled` and `--log-ok-invocations`;
  `update` also takes `--clear-filter`, `--enable` and `--disable`.
- `k9o schedule list|get|create|update|delete|runs|run-now` for scheduled triggers. `create` takes `--function`, `--cron`, `--timezone`, `--catchup`, `--collection`, `--disabled` and `--log-ok-invocations`.
  An interval under 5 minutes, or `--catchup run_all`, can be refused.
- `k9o end-user list|get` and `k9o end-user role-grant list|grant|revoke`. A role is any string; revoking an unknown grant prints `revoked: false`.
- `k9o vectors nearest <collection> --vector <json>|--vector-file <path|-> [--top-k N] [--min-score X] [--metric cosine|euclidean|dot] [--filters <json>]` finds the nearest stored embeddings, closest first.
- `k9o vectors upsert <collection> --rows <json>|--rows-file <path|->` stores 1 to 1000 rows. The collection name starts with `_`.
- README sections for the new commands.
- README: what an event-trigger function receives (the JSON payload, redaction, `triggeredAt`, and deduping on `eventId`).

### Fixed

- Every secret prompt (`k9o login`, `byos cred`, `vault secret create|update`) is read without echo on a terminal. `k9o login` no longer takes `--password`, since a password on the command line shows in shell history and the process list: type it at the prompt or set `K9O_PASSWORD` in a script. Passing the flag is a usage error and sends nothing.
- `k9o login` waited for the email and then exited without asking for the password, because the second prompt read from a stream the first had paused. The email, password and MFA prompts now share one reader, so lines typed or piped together are each used in turn, and the password is no longer echoed. `k9o init` uses the same reader.
- A gateway error whose `recommendation` is an object printed `[object Object]`, and during a workload token exchange it crashed with `acc.split is not a function`, hiding the real code and exit status. The action text is printed, and the exchange keeps the gateway's code, message and status.
  `--output json` errors add `retryAfterSec` when the gateway asks you to wait.

## 1.4.0 — 2026-10-26

### Added

- `k9o ai generate <prompt|-> [--model <id>] [--max-tokens N] [--temperature T]` prints generated text; usage goes to stderr.
- `k9o stream create|list|get|delete|publish|tail|replay` for a project's data streams.
- `k9o stream publish <slug> --data <json|@file|->` (stdin with `-`) and `--subject`.
- `k9o stream tail <slug> [--from <sequence>] [--count <n>]` follows a stream live, one event per line (JSON lines with `--output json`).
  It reopens the connection from the last sequence and runs until interrupted.
- `k9o stream replay <slug> [--from N] [--until N] [--limit N]` reads a bounded range.
- A lone `-` is accepted as a flag value, so `--data -` reads stdin.
- `k9o approvals list|get|approve|reject|bulk` for the pending-change queue. `approve` reports when more approvers are needed.
  `bulk --action approve|reject --criteria '<json>' [--reason <text>]` prints the ids it decided; rows that fail are skipped without a report.
- `k9o approval-policy list|create|delete`; `create` takes `--collection`, `--operation`, `--action` and `--predicate '<json>'`.
- `k9o schema collections [--limit N] [--cursor c]` lists the project's collections and prints the cursor of the next page.
- README sections for `k9o query`, `k9o search` and the new commands.
- Keyless sign-in from CI. `--workload-id swi_...` (or `K9O_WORKLOAD_ID`) exchanges an external OIDC token for a short-lived platform token, held in memory for the run.
- The OIDC token comes from `--oidc-token-file`, `K9O_OIDC_TOKEN`, or the GitHub Actions token endpoint (`--oidc-audience` / `K9O_OIDC_AUDIENCE`; the job needs `permissions: id-token: write`).
- `k9o whoami` reports `federated-workload` mode with the workload, org, project and token lifetime.
- Known limit: the exchanged token has no project grants yet, so commands after the exchange are refused. Use `K9O_SERVICE_TOKEN` to run commands in CI until then.

### Changed

- Function deploy examples use the sandbox tier.

## 1.3.0 — 2026-10-26

The CLI now matches the gateway routes exactly.

### Changed

- `k9o login` signs in as the operator. MFA comes from `--mfa-code`, `K9O_MFA_CODE` or a prompt. `--project` is optional.
- Password sign-in is the interim method until browser-based device authorization lands.
- `K9O_SERVICE_TOKEN` signs in CI runs with no login. `K9O_ORG` and `K9O_PROJECT` apply to every command.
- `k9o project create` takes `--region` and the custody modes `PLATFORM_MANAGED`, `SKR`, `BYOK` and `HYOK`.
- `k9o function deploy` uploads the artifact: `--artifact <file>`, or `--artifact-key` with `--version`. `--tier` is `gateway` or `sandbox`.
- `k9o audit tail` is a one-off fetch, not a stream.
- Signed URLs from `k9o storage objects sign` last at most 900 seconds, whatever `--expires-in` asks for.
- `k9o ext <slug> <verb>` works for a signed-in operator only.
- `stack`, `showroom`, `up` and `doctor` need a `k9o-core` checkout. `ledger verify` needs the `kibo-ledger-verify` binary.
- README: command reference, flags and examples rewritten from the source.

### Removed

- `project delete`, `function logs`, `ext-admin available`.
- `me notifications`, `me audit-log`, `me data-export`.
- `org groups create` and `delete`, `org members get`, `org smtp get`, `org audit tail`.
- `storage buckets` flags `--public`, `--versioning` and `--delete-after-days`.
- `audit` flags `--target-kind` and `--target-id`.
- `policy apply --name`.

### Added

- Nothing.

## 1.2.0 — 2026-10-25

- The README now introduces the Kilimanjaro building blocks (Keep, Pulse, Gate, Kibo). No change to the public API.

## 1.1.1 — 2026-10-25

- Documentation links corrected: the documentation hub is https://docs.kilimanjaro.dev, with the website, platform API and console listed in a Links section. Package metadata points at the same places.

## 1.1.0 — 2026-10-25

- Documentation rewritten with runnable examples and expected output; internal cross-references removed from the published sources. No change to the public API.


## 1.0.0 — 2026-10-23

First public release. See the README for the full API overview.
