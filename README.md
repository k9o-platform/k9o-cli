# @k9o/cli

The official command line for [Kilimanjaro](#106-about-kilimanjaro).
The `k9o` command line: sign in, manage projects, apply migrations, deploy functions, read and follow the audit log, work with datasets, and publish to and tail streams.

## Contents

**A. Get started**

1. [Links](#1-links)
2. [Install](#2-install)
3. [Choose the right package](#3-choose-the-right-package)
4. [Quick start](#4-quick-start)

**B. Sign in and choose a project**

5. [Sign in](#5-sign-in)
6. [Keyless sign-in from CI](#6-keyless-sign-in-from-ci)
7. [Choose a project](#7-choose-a-project)

**C. Use the CLI**

8. [Run a command](#8-run-a-command)
9. [Read output and exit codes](#9-read-output-and-exit-codes)

**D. Reference**

10. [Appendix](#10-appendix)
    - 10.1 [Command reference](#101-command-reference)
    - 10.2 [Global flags](#102-global-flags)
    - 10.3 [Environment variables](#103-environment-variables)
    - 10.4 [Exit codes](#104-exit-codes)
    - 10.5 [Command manifest](#105-command-manifest)
    - 10.6 [About Kilimanjaro](#106-about-kilimanjaro)
11. [License](#11-license)

## A. Get started

### 1. Links

- Website: <https://kilimanjaro.dev>
- Documentation / Developer Hub: <https://docs.kilimanjaro.dev>
- API: <https://api.k9o.io>
- Console: <https://console.k9o.io>
- Open source
  - Platform: <https://github.com/k9o-platform>
  - Community: <https://github.com/k9o-community>

### 2. Install

```bash
npm install -g @k9o/cli
```

Bun works too: `bun add -g @k9o/cli`.

- Requires Node.js or Bun.
- The [local stack commands](#local-development-stack-k9o-stack) also need Docker and a `k9o-core` checkout.
- Signing in with a password or passkey needs a person at the terminal. In CI, use an API token or the [keyless workload exchange](#6-keyless-sign-in-from-ci), and know that the exchanged token has no project grants yet, so project commands are refused.
- `k9o rollups reattest` needs a signed-in person: an API token is refused with exit 67.

Check the install:

```bash
k9o --version
```

```text
k9o/1.5.0 api/v2
```

### 3. Choose the right package

| Package | Use it when you are… | Registry | Source |
| --- | --- | --- | --- |
| `@k9o/core` | Building a backend service that uses the platform's data, compute, governance and control features. | [npm](https://www.npmjs.com/package/@k9o/core) | [sdk-typescript](https://github.com/k9o-platform/sdk-typescript) |
| `@k9o/gate` | Implementing sign-up, sign-in, sessions, federation and end-user identity, or verifying a Gate token. | [npm](https://www.npmjs.com/package/@k9o/gate) | [sdk-gate-typescript](https://github.com/k9o-platform/sdk-gate-typescript) |
| `@k9o/extension-client` | Calling an extension installed in your project, by its slug, through typed bindings. To write an extension, use the extension runtime package instead. | [npm](https://www.npmjs.com/package/@k9o/extension-client) | [sdk-extension-client-typescript](https://github.com/k9o-platform/sdk-extension-client-typescript) |
| `@k9o/extension-runtime` | Writing an extension: reading and writing data, generating text and embeddings, and calling the platform services the extension's manifest grants. | [npm](https://www.npmjs.com/package/@k9o/extension-runtime) | [sdk-extension-runtime-typescript](https://github.com/k9o-platform/sdk-extension-runtime-typescript) |
| `@k9o/extension-manifest` | Declaring an extension's manifest: its permissions, surfaces and endpoints, checked the way the platform checks them at registration. | [npm](https://www.npmjs.com/package/@k9o/extension-manifest) | [sdk-extension-manifest-typescript](https://github.com/k9o-platform/sdk-extension-manifest-typescript) |
| `@k9o/kibo` | Keeping secrets in the vault, or encrypting and decrypting with a key you hold. | [npm](https://www.npmjs.com/package/@k9o/kibo) | [sdk-kibo-typescript](https://github.com/k9o-platform/sdk-kibo-typescript) |
| `@k9o/barbican` | Checking model input and redacting model output on your own machine, with no account. | [npm](https://www.npmjs.com/package/@k9o/barbican) | [sdk-barbican-typescript](https://github.com/k9o-platform/sdk-barbican-typescript) |
| `@k9o/cli` | Operating projects from a terminal or CI: migrations, functions, sign-in providers and secrets. | [npm](https://www.npmjs.com/package/@k9o/cli) | [k9o-cli](https://github.com/k9o-platform/k9o-cli) |

`@k9o/core` also exposes Gate as `k9o.gate` and the vault as `k9o.kibo.vault`.

### 4. Quick start

The examples use an organization `acme` with a project `member-portal`.

```bash
k9o login --org acme --project member-portal
k9o whoami
```

```text
Signed in as me@acme.com (usr_...) on org=acme project=member-portal (profile=default)
me@acme.com (usr_...) on org=acme project=member-portal (profile=default)
```

See the [command reference](#101-command-reference) for everything else you can run. To try the platform on your own machine, see the [local development stack](#local-development-stack-k9o-stack).

## B. Sign in and choose a project

### 5. Sign in

`k9o login` signs you in as an operator, not as a project end user. It saves the session in `~/.k9o/credentials` (mode `0600`).
Every other command uses it.

- Email and password are prompted for when you leave them out. The password is never echoed, and there is no `--password` flag: set `K9O_PASSWORD` in a script.
- If your organization requires MFA, you are asked for an authenticator code. Enroll an authenticator in the Console first.
- Password sign-in is the interim method until browser-based device authorization lands.
- `--org` picks your organization. `--project` is optional and sets the active project.
- `k9o logout` clears the saved session.

```bash
k9o login --org acme
```

```text
Signed in as me@acme.com (usr_...) on org=acme (no active project; run `k9o project set-active <slug>`) (profile=default)
```

For a custom host, add `--base-url` with the apex or the full organization host.

```bash
k9o login --base-url https://platform.example.com --org acme
```

Each setting also has an environment variable. See [environment variables](#103-environment-variables).

#### Scripts and CI

Pass the MFA code with `--mfa-code` or `K9O_MFA_CODE` when there is no terminal to prompt on.
For CI, skip the login and use a service token. It takes precedence over a saved login.

```bash
K9O_SERVICE_TOKEN=... K9O_ORG=acme K9O_PROJECT=member-portal k9o migration apply migrations.json
```

#### Several identities

Log in under different profiles to keep them side by side, for example one per environment.

```bash
k9o login --profile staging --org acme --project member-portal
k9o project set-active member-portal --profile staging
k9o whoami --profile staging
```

#### Where credentials live

- `k9o login` writes the session to `~/.k9o/credentials` (mode `0600`), one entry per profile. Anyone who can read your home directory can use it, so do not log in on a shared machine.
- `k9o logout` removes the profile from that file on this machine. It does not revoke the session at the gateway.
- On a CI runner, a container or any build agent that is thrown away, do not log in. Use a service token from the environment, or [keyless sign-in](#6-keyless-sign-in-from-ci), which keeps its token in memory only and writes nothing to disk.

#### Session limits

Your organization sets one operator session policy, and a `k9o login` session follows it:

| Setting | Default | Range |
| --- | --- | --- |
| Inactivity before the session ends | 30 minutes | 5 minutes to 24 hours |
| Maximum session length | 12 hours | 15 minutes to 30 days |
| Live sessions per person | 10 | 1 to 50 |

- Inactivity is measured when the CLI refreshes its access token, not at each command, so it holds to within 15 minutes, the access-token lifetime.
- A new sign-in past the session limit ends your oldest live sessions. It does not refuse the new one, so signing in on another machine or in the Console can end the session on this one.
- When a session has ended, the next command exits with code 74. Run `k9o login` again.
- A personal access token and a service token are not sessions. None of these limits apply to them.

### 6. Keyless sign-in from CI

A CI job can sign in with no stored secret. The CLI takes the OIDC token your CI provider issues to the job, exchanges it at the
gateway for a short-lived platform token, and uses that token for the rest of the run. The token lives in memory only.
Nothing is written to disk.

1. Register a federated workload (`swi_...`) in the project and set its trust config to your CI provider's issuer, audience and claims.
2. Give the CLI the workload id, the org, the project, and a token source.

| Setting | Flag | Environment variable |
|---|---|---|
| Workload id (`swi_...`) | `--workload-id` | `K9O_WORKLOAD_ID` |
| Label for the run (optional) | `--workload-tag` | `K9O_WORKLOAD_TAG` |
| OIDC token from a file | `--oidc-token-file` | |
| OIDC token | | `K9O_OIDC_TOKEN` |
| Audience to request on GitHub Actions | `--oidc-audience` | `K9O_OIDC_AUDIENCE` |

The token comes from `--oidc-token-file`, then `K9O_OIDC_TOKEN`, then the GitHub Actions token endpoint. The last needs an audience
and `permissions: id-token: write` on the job.

```yaml
permissions:
  id-token: write
steps:
  - run: k9o whoami
    env:
      K9O_WORKLOAD_ID: swi_abc123
      K9O_ORG: acme
      K9O_PROJECT: member-portal
      K9O_OIDC_AUDIENCE: https://acme.example
```

```text
federated workload swi_abc123 on org=acme project=member-portal, token valid for 900s
```

The exchanged token acts as the workload, not as a person. It can deploy and manage functions, run migrations and read or
write storage objects, as far as the IAM policy bound to the workload allows. An admin binds a policy to the workload
(`POST /@<project>/iam-policies/<policyId>/bindings` with `principalType: "workload"`), and a binding that widens what the
workload may do waits for a second admin's approval. Until a policy is bound, every command is refused. `k9o whoami` shows
the exchange worked. Other commands refuse a workload token; use `K9O_SERVICE_TOKEN` for those.

### 7. Choose a project

Project-scoped commands need a project. The first one found is used:

- The `--project` flag.
- The `K9O_PROJECT` environment variable.
- The active project saved on the profile.

Save an active project once:

```bash
k9o project set-active member-portal
```

If none is set, the command exits with code 65. See [exit codes](#104-exit-codes).

## C. Use the CLI

### 8. Run a command

Commands are grouped: `k9o <group> <subcommand>`. List the groups, or the subcommands of one group:

```bash
k9o --help
k9o migration --help
```

Apply a migration from a JSON file shaped like `{ "migrations": [{ "version", "slug", "up", "down" }] }`:

```bash
k9o migration apply migrations.json
```

```text
Applied 1 migration(s):
  1  create-tasks
```

List the projects you can access:

```bash
k9o project list
```

```text
Projects:
  member-portal                   Member Portal                             PLATFORM_MANAGED   de01    prj_01j9x2k4m7
```

`k9o function invoke add-numbers --payload '{"x": 1, "y": 2}'` runs a deployed function and prints its result as JSON.

Publish an event to a stream, then follow the stream:

```bash
k9o stream publish orders --data '{"id":1,"total":42}' --subject eu.new
k9o stream tail orders --from 0
```

```text
Accepted 19 bytes on k9o.de01.acme.prj_01j9x2k4m7.user.pstr_01j9x2k5q1.eu.new
1  2026-10-26T10:00:01.000Z  eu.new  {"id":1,"total":42}
```

`tail` keeps running until you press Ctrl-C.

Read your data with SQL or full-text search. Rows print one JSON object per line:

```bash
k9o query "SELECT id, title FROM tasks WHERE done = :done" --params '{"done":false}'
k9o search articles --column body --q "climate resilience" --limit 5
```

```text
{"id":"tsk_01j9x6","title":"Write the README"}
{"id":"art_01j9x7","title":"Planning for flood risk","body":"..."}
```

Review changes waiting for approval, and list the project's collections:

```bash
k9o approvals list --status pending_approval
k9o schema collections --limit 2
```

```text
Pending changes:
  apr_01j9x3                pending_approval  update  orders                    usr_01j9x1  2026-10-26T10:00:00.000Z
Collections:
  orders                              120 rows    8 cols    3 idx  add_orders
  tasks                                14 rows    4 cols    1 idx  create-tasks
More: --cursor dGFza3M
```

Reject a change (a reason is required):

```bash
k9o approvals reject apr_01j9x3 --reason "duplicate"
```

```text
Rejected. Change apr_01j9x3
  status: rejected
  update on orders (rec_01j9x2)
  proposed by: usr_01j9x1
  created: 2026-10-26T10:00:00.000Z
  decided by: usr_01j9x8 at 2026-10-26T10:05:00.000Z
  reason: duplicate
```

Queue a write for approval instead of applying it, then see it in the queue:

```bash
k9o data insert orders --data '{"id":"o-1","total":42}' --require-approval
```

```text
Queued for approval: apr_5oLshD2MVT27 (insert on orders).
Nothing was written yet. Decide it with: k9o approvals approve apr_5oLshD2MVT27 | k9o approvals reject apr_5oLshD2MVT27 --reason <text>
```

Give an end user a role, and take it away again:

```bash
k9o end-user role-grant grant --end-user eu_YmGE3Z6nkv5i --role billing-manager
k9o end-user role-grant revoke eurg_AbCdEf123456
```

```text
Granted. eurg_AbCdEf123456  eu_YmGE3Z6nkv5i  billing-manager  granted 2026-10-26T17:59:56.815Z by usr_01j9x1
Revoked eurg_AbCdEf123456 at 2026-10-26T18:00:00.000Z.
```

Full list: [command reference](#101-command-reference). Flags that work everywhere: [global flags](#102-global-flags).

### 9. Read output and exit codes

Human output is for people. Use `--output json` in scripts and CI.

```bash
k9o whoami --output json
```

```json
{
  "data": {
    "profile": "default",
    "userId": "usr_...",
    "email": "me@acme.com",
    "orgSlug": "acme",
    "activeProjectSlug": "member-portal",
    "baseUrl": "https://acme.api.k9o.io"
  },
  "meta": {}
}
```

Failures go to stderr and set the exit code. With `--output json` stderr holds `{ code, message, context, recommendation }`, plus `retryAfterSec` when the gateway asks you to wait. `recommendation` is always text or `null`; when the gateway sends it as an object, the CLI prints its action text.

```bash
k9o whoami --profile missing
```

```text
[UNAUTHENTICATED] No credentials for profile "missing". Run `k9o login` first.
→ k9o login --org <slug>   (or set K9O_SERVICE_TOKEN for CI)
```

The most useful codes:

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 2 | Usage error |
| 65 | Missing project or organization |
| 66 | Not signed in |

All of them are in [exit codes](#104-exit-codes).

## D. Reference

### 10. Appendix

#### 10.1 Command reference

Run `k9o <group> --help` for the same list in your terminal.

##### Session

| Command | What it does |
|---|---|
| `k9o login` | Sign in as an operator and save the session |
| `k9o logout` | Clear the saved session |
| `k9o whoami` | Print the active identity |
| `k9o init` | Guided setup: sign in and pick an active project |

| `login` flag | Meaning |
|---|---|
| `--org`, `--project`, `--base-url` | Organization, optional active project, custom host |
| `--email` | Skip the email prompt |
| `--mfa-code` | Authenticator code, for scripts |

##### Projects: `k9o project`

| Command | What it does |
|---|---|
| `list` | List projects you can access |
| `create <slug>` | Create a project |
| `get <slug>` | Show one project |
| `set-active <slug>` | Make it the active project for this profile |

| `create` flag | Meaning |
|---|---|
| `--name <text>` | Display name; defaults to the slug |
| `--region <code>` | Platform region, such as `de01` |
| `--custody-mode` | `PLATFORM_MANAGED`, `SKR`, `BYOK` or `HYOK` |

##### Migrations: `k9o migration`

| Command | What it does |
|---|---|
| `list` | List applied migrations (alias `status`) |
| `apply <file>` | Apply migrations from a JSON file |
| `pending` | List queued migrations |
| `apply-pending <pendingId>` | Apply a queued migration |

##### Functions: `k9o function`

Sandbox functions run in a [Firelock](https://github.com/firelock-sandbox/firelock) microVM sandbox.

| Command | What it does |
|---|---|
| `deploy [<manifest.json>]` | Upload an artifact and deploy a function |
| `list` | List deployed functions |
| `get <name>` | Show one function |
| `invoke <name>` | Run it (`--payload <json>` or `--payload-file <path>`) |
| `delete <name>` | Retire a function; the name is reusable after 24 hours |

| `deploy` flag | Meaning |
|---|---|
| `--name`, `--version` | Function name and version label |
| `--runtime` | `bun`, `python`, `go`, `java`, `kotlin`, `dotnet`, `swift`, `php`, `ruby`, `rust` or `zig` |
| `--tier` | `sandbox` (a `.tar` artifact, up to 256 MiB). Functions run in the sandbox; the `gateway` tier is for the platform operator and is refused for your project |
| `--artifact <file>` | Upload this file as the artifact |
| `--artifact-key <key>` | Use an artifact you already uploaded; not with `--artifact` |
| `--description <text>` | Optional description |

Flags override the same fields in the manifest file.

```bash
k9o function deploy --name my-fn --runtime go --tier sandbox --version 1 --artifact ./fn.tar
```

```text
Function my-fn (fn_...) — runtime=go tier=sandbox status=active
```

##### Function triggers: `k9o function trigger`

An event trigger runs a function when a record is inserted, updated, deleted or upserted in a collection. Needs the project admin role.

| Command | What it does |
|---|---|
| `list <function>` | List the function's triggers, newest first |
| `create <function>` | Create a trigger |
| `update <function> <trigger-id>` | Change a trigger |
| `delete <function> <trigger-id>` | Delete a trigger |

| Flag | Used by | Meaning |
|---|---|---|
| `--collection <name>` | create | An existing collection (letters, digits, underscores) |
| `--events <list>` | create, update | 1 to 4 of `insert`, `update`, `delete`, `upsert`, comma-separated. On update it replaces the list |
| `--filter <json\|@file\|->` | create, update | A predicate object, for example `'{"eq":["resource.status","paid"]}'`. Without it the trigger fires on every event |
| `--clear-filter` | update | Remove the filter |
| `--disabled` | create | Create the trigger switched off |
| `--enable`, `--disable` | update | Switch the trigger on or off |
| `--log-ok-invocations` | create, update | Record successful runs too (`--no-log-ok-invocations` turns it off on update) |

```bash
k9o function trigger create notify --collection orders --events insert,update
k9o function trigger delete notify 0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11
```

```text
Created trigger on notify:
  0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11  enabled   orders                    insert,update
Deleted trigger 0b8f6a52-3f0e-4c8e-9a47-5d2b0f1c7e11 from notify.
```

- `update` needs at least one flag. The collection cannot be changed. Deleting a trigger twice is an error.
- For triggers on a timetable use [`k9o schedule`](#schedules-k9o-schedule).

###### What the function receives

The function is called with this JSON payload:

```json
{
  "event": "update",
  "collection": "orders",
  "record": { "id": "ord_1", "status": "paid" },
  "record_old": { "id": "ord_1", "status": "open" },
  "projectId": "proj_a1b2c3",
  "triggeredAt": "2026-10-27T09:14:03.512Z",
  "eventId": "evt_7f3c9d2e"
}
```

- `event` is the operation name: `insert`, `update`, `delete` or `upsert` (an upsert is reported as the insert or update as applied).
- On `insert`, `record` is the new row and `record_old` is `null`. On `update`, both rows are set. On `delete`, `record` is `null` and `record_old` is the deleted row.
- `record` and `record_old` are redacted as for a read with no reveal: columns flagged for reveal are redacted, and encrypted columns appear as the redacted marker.
- `triggeredAt` is the time the change was committed, not the time of the delivery attempt.
- `eventId` is unique per delivery. Delivery is at-least-once, so the function must dedupe on `eventId`.

##### Streams: `k9o stream`

| Command | What it does |
|---|---|
| `create --name <text> --max-bytes <size>` | Create a stream (project admin) |
| `list` | List the project's streams |
| `get <slug>` | Show one stream |
| `delete <slug>` | Retire a stream (project admin) |
| `publish <slug> --data <json\|@file\|->` | Append an event (project admin); `-` reads stdin |
| `tail <slug>` | Follow a stream live until interrupted (project admin or auditor) |
| `replay <slug>` | Read a bounded range once (project admin or auditor) |

| Flag | Used by | Meaning |
|---|---|---|
| `--max-bytes <size>` | create | At least 10 MiB (10485760 bytes) and at most 64 GiB: bytes, or a size like `10MiB` or `4GiB` |
| `--retention <time>` | create | Whole hours, at least 1 hour: seconds, or `24h`, `7d`; default 24 hours |
| `--subject <suffix>` | publish | Up to 8 dot-separated tokens of `[a-z0-9_-]` |
| `--from <sequence>` | tail, replay | Start after this sequence |
| `--until <sequence>` | replay | Stop at this sequence |
| `--limit <n>` | replay | 1 to 10000; default 100 |
| `--count <n>` | tail | Stop after this many events |

- With `--output json`, `tail` prints one JSON event per line.
- `tail` reopens its connection by itself from the last sequence it printed.
- A `K9O_STREAM_UNAVAILABLE` error means streams are not available in that deployment yet.

##### Query and search: `k9o query` and `k9o search`

| Command | What it does |
|---|---|
| `query <sql\|->` | Run one read-only SQL statement; `-` reads it from stdin |
| `query --file <path\|->` | Read the statement from a file |
| `search <collection> --column <name> --q <text>` | Full-text search one text column, best match first |

| Flag | Used by | Meaning |
|---|---|---|
| `--params <json>` | query | A JSON array (positional `$1`, `$2`) or object (named `:name`); values are strings, numbers, booleans or null |
| `--language <name>` | search | Text-search configuration; default `english` |
| `--type plain\|phrase\|websearch` | search | Query syntax; default `plain` |
| `--limit <n>`, `--cursor <c>` | search | Page size and the cursor of the next page |

- Raw SQL is read-only and takes one statement per call. It needs the project-editor role.
- Rows print one JSON object per line; with `--output json` you get the whole result.

##### Vector search: `k9o vectors`

Stores embeddings you computed yourself and finds the nearest ones. The vector travels in the request body, so real embeddings of any common size work. A vector collection's name starts with `_`.

| Command | What it does |
|---|---|
| `nearest <collection>` | The rows nearest to a vector, closest first |
| `upsert <collection>` | Insert or overwrite 1 to 1000 rows; the first upsert creates the collection and fixes its dimension |

| Flag | Used by | Meaning |
|---|---|---|
| `--vector <json>` | nearest | The query vector as a JSON array of numbers (1 to 16000) |
| `--vector-file <path\|->` | nearest | The same, read from a file or from stdin |
| `--top-k <n>` | nearest | 1 to 1000 results (default 10) |
| `--min-score <x>` | nearest | Drop results scoring below this |
| `--metric <m>` | nearest | `cosine` (default), `euclidean` or `dot` |
| `--filters <json>` | nearest | Equality filters on `id`, `contentHash`, `source.<key>` and `metadata.<key>` |
| `--rows <json>` | upsert | A JSON array of rows: `vector` and `_source` (`handle`, `chunkIndex`) required; `id`, `contentHash`, `text`, `metadata` optional |
| `--rows-file <path\|->` | upsert | The same, read from a file or from stdin |

```bash
k9o vectors upsert _notes --rows '[{"id":"n1","vector":[1,0,0],"_source":{"handle":"intro","chunkIndex":0},"text":"x axis","subjectIds":["eu_abc123"]}]'
k9o vectors nearest _notes --vector '[1,0,0]' --top-k 2
```

```text
Upserted 1 row in _notes.
Nearest in _notes:
  1.0000  n1  intro#0  x axis
```

- Each row needs `subjectIds` (one end-user id, `["eu_..."]`) unless the collection was declared shared.
- Searching a collection that was never upserted exits non-zero with `K9O_COLLECTION_NOT_FOUND`. With `--output json` you get the whole result, including `results[].score`, `text`, `metadata`, `contentHash`, `model` and `chunk`.

##### Metadata: `k9o metadata`

Filters, searches and finds the nearest rows over columns you declare on a collection. Declare the columns first; `set` writes declared columns only, and the other commands read declared columns only. The columns must already exist on the collection. Column names are sent as `metadata.<name>`; the prefix is added when you leave it out.

| Command | What it does |
|---|---|
| `index declare <collection>` | Declare the columns, replacing the previous declaration (`[]` clears it) |
| `index get <collection>` | Show the declared columns |
| `set <collection> <id>` | Write declared columns of one record |
| `filter` | Rows whose declared columns meet a condition |
| `search` | Full-text search of a declared text column |
| `nearest` | The rows nearest to an embedding, closest first |

| Flag | Used by | Meaning |
|---|---|---|
| `--columns <json>` | index declare | A JSON array of `{ column, indexed? }`: at most 64, no `id`, no repeats |
| `--set <json>` | set | A JSON object of declared columns (inline, `@file`, or `-` for stdin) |
| `--surface <s>` | filter, search, nearest | `collection:<name>`, `telemetry:<event-prefix>` or `storage:<bucket>`; `filter` takes a comma-separated list; `search` and `nearest` take a collection only |
| `--where <json>` | filter, nearest | A JSON array of `{ field, op, value }`; `op` is `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `in` or `notIn` |
| `--limit <n>` | filter, search | 1 to 1000 (default 100 for `filter`, 50 for `search`) |
| `--cursor <c>` | filter | The cursor printed by the previous page; needs exactly one surface |
| `--field <column>`, `--q <text>` | search | The text column and the words to look for |
| `--column <column>` | nearest | The declared vector column |
| `--embedding <json>` | nearest | The query embedding as a JSON array of numbers |
| `--embedding-file <path\|->` | nearest | The same, read from a file or from stdin |
| `--k <n>`, `--metric <m>` | nearest | 1 to 1000 results (default 10); `cosine` (default), `euclidean` or `dot` |

```bash
k9o metadata index declare posts --columns '[{"column":"title"},{"column":"body"},{"column":"priority"},{"column":"embedding"}]'
k9o metadata set posts p1 --set '{"title":"Quarterly report","body":"Finance review","priority":3,"embedding":"[1,0,0]"}'
k9o metadata filter --surface collection:posts --where '[{"field":"priority","op":"gte","value":2}]'
k9o metadata search --surface collection:posts --field body --q finance
k9o metadata nearest --surface collection:posts --column embedding --embedding '[1,0,0]' --k 3
```

```text
Declared columns on posts:
  title
  body
  priority
  embedding
Updated posts/p1: {"id":"p1","title":"Quarterly report","body":"Finance review","priority":3,"embedding":"[1,0,0]","_k9o_deleted_at":null,"_k9o_deleted_by":null,"_k9o_purge_after":null}
  collection:posts  p1  {"body":"Finance review","embedding":"[1,0,0]","priority":3,"title":"Quarterly report"}
  collection:posts  p1  {"body":"Finance review","embedding":"[1,0,0]","priority":3,"title":"Quarterly report"}
  collection:posts  p1  {"body":"Finance review","embedding":"[1,0,0]","priority":3,"title":"Quarterly report"}
```

The collection must already have the four columns (`embedding` is a `vector(3)` column) and a record `p1`. The declared columns print in the order you gave them; a row's `metadata` lists them alphabetically.

- `filter` ends with `More: --cursor <c>` when another page exists. `search` returns the first page only, and `nearest` at most 50 rows with no score. With `--output json` you get the whole `{data, meta}`.
- A `storage:` surface exits non-zero with `K9O_NOT_IMPLEMENTED`; more than 10000 rows exit with `K9O_QUERY_RESULT_TOO_LARGE`; an undeclared column exits with `K9O_METADATA_FIELD_NOT_INDEXED`.
- Following changes live is an SDK feature (`client.metadata.subscribe` in `@k9o/core`).

##### Records: `k9o data`

| Command | What it does |
|---|---|
| `insert <collection> --data <json>` | Insert one record |
| `update <collection> <id> --data <json>` | Change one record; `--data` is the patch |
| `delete <collection> <id>` | Delete one record |

| Flag | Used by | Meaning |
|---|---|---|
| `--data <json\|@file\|->` | insert, update | A JSON object: inline, from a file, or `-` for stdin |
| `--require-approval` | insert, update, delete | Queue the write for approval instead of applying it |

- With `--require-approval` the command prints the change id (`apr_...`). Nothing is written until it is approved with `k9o approvals approve <id>`.
- What a write does depends on the matching approval policy:

| Matching policy | Without `--require-approval` | With `--require-approval` |
|---|---|---|
| none | applied | queued |
| `queue` | queued | queued |
| `auto_approve` | applied | applied (not queued) |
| cannot be evaluated | queued | queued |

- With `--output json` the result is `{data, meta}` as the gateway sent it: a queued change has `data.status` `pending_approval` and `meta.approval.status`.
- Bulk writes and upserts do not take the flag. An end user cannot queue a write.

##### Approvals: `k9o approvals`

| Command | What it does |
|---|---|
| `list` | List pending changes, newest first, one page at a time |
| `get <id>` | Show one change |
| `approve <id>` | Approve a change |
| `reject <id> --reason <text>` | Reject a change (reason required) |
| `bulk --action approve\|reject --criteria '<json>'` | Decide every pending change matching a predicate |
| `comment <id> --body <text> --visibility everyone\|approvers_only` | Post a comment on a change |
| `comments <id>` | List the comments you may see on a change, oldest first |

| Flag | Used by | Meaning |
|---|---|---|
| `--status <s>` | list | `pending_approval`, `approved`, `rejected`, `expired` or `redeemed` |
| `--limit <n>` | list, comments | 1 to 200; default 50 |
| `--cursor <c>` | list, comments | The cursor printed after the previous page (`More: --cursor <c>`); for `list`, use the same `--status` |
| `--reason <text>` | approve, reject, bulk | Note stored with the decision; required for reject |
| `--body <text>` | comment | Plain text, 1 to 4000 characters |
| `--visibility everyone\|approvers_only` | comment | Required, no default; fixed once posted. `everyone`: everyone who can read the change. `approvers_only`: the people who can decide it |
| `--action approve\|reject` | bulk | What to do with the matches |
| `--criteria '<json>'` | bulk | A predicate object, for example `'{"eq":["change.table","orders"]}'` |

- Admins and auditors see every change; other members see only their own. Deciding needs the admin or auditor role.
- When more approvers are needed, `approve` says so and the change stays `pending_approval`.
- When more changes exist, `list` ends with `More: --cursor <c>`; the last page prints no cursor. A malformed cursor, or one used with another `--status`, fails with `K9O_INVALID_CURSOR`.
- `bulk` succeeds even when rows fail. It prints the ids it decided, then the rows that failed (`id  code  reason`): compare them with what you intended.
- With `--output json` the `{data, meta}` is printed as sent: the next cursor is `meta.cursor.next` and failed rows are `data.failed`.
- `comment` posts one comment and prints it. A comment is never a decision, and there is no edit or delete. It needs a signed-in session: a personal access token alone is refused with `K9O_RBAC_DENY`. `K9O_APPROVAL_COMMENT_NOT_ELIGIBLE` (exit 67) means you may not comment on that change; `K9O_APPROVAL_COMMENT_CLOSED` means the change is no longer open for comments. A missing or invalid `--body` or `--visibility` is a usage error (exit 2) and nothing is sent.
- `comments` prints one comment per entry (`id  created  author  visibility`, then the body), oldest first, and shows only the comments you may see. When more exist it ends with `More: --cursor <c>`. With `--output json` the page is printed as `{data, nextCursor, meta}`.

```bash
k9o approvals comment apr_01j9x3 --body "Does this match the invoice?" --visibility approvers_only
```

##### Custody status: `k9o custody`

| Command | What it does |
|---|---|
| `status` | Show how the active project's keys are held |

```text
k9o custody status
```

```text
Custody mode: PLATFORM_MANAGED
Attached: no
Provider: platform
Last job: -
```

This project's keys are held by the platform. For an HSM project the output continues with `HSM vendor`, `HSM cluster`, `HSM region` and `HSM attestation` lines.

- Read-only; needs the project-admin or project-auditor role. Changing custody is a Console action.
- The `HSM` lines appear only when the provider is `hsm`. With `--output json` the `{data, meta}` is printed as sent; `data.hsm` may be absent.

##### Approval policies: `k9o approval-policy`

| Command | What it does |
|---|---|
| `list` | List the project's policies, oldest first |
| `create` | Create a policy |
| `delete <id>` | Delete a policy |

| Flag | Used by | Meaning |
|---|---|---|
| `--collection <name>` | create | Letters, digits and underscores, starting with a letter or underscore (up to 63) |
| `--operation <op>` | create | `insert`, `update` or `delete` |
| `--action <a>` | create | `queue` or `auto_approve` |
| `--predicate '<json>'` | create | A predicate object, for example `'{"gt":["change.row.amount",1000]}'` |

##### Schema: `k9o schema`

| Command | What it does |
|---|---|
| `collections` | List collections by name with row, column and index counts and the last migration |

`--limit <1-200>` sets the page size (default 50). Pass the printed cursor to `--cursor` for the next page.

##### Schedules: `k9o schedule`

A schedule runs a function on a cron timetable.

| Command | What it does |
|---|---|
| `list` | List schedules, newest first |
| `get <id>` | Show one schedule |
| `create` | Create a schedule |
| `update <id>` | Change a schedule |
| `delete <id>` | Delete a schedule |
| `runs <id>` | List the schedule's runs, newest first |
| `run-now <id>` | Start one run now, outside the timetable |

| Flag | Used by | Meaning |
|---|---|---|
| `--function <name>` | create, list | The function to run (on list: only this function's schedules) |
| `--cron <expr>` | create, update | Five fields (minute hour day month weekday), or `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly` |
| `--timezone <tz>` | create, update | `UTC` (default) or `Region/City` |
| `--catchup <policy>` | create, update | `skip` (default), `run_once` or `run_all` |
| `--collection <name>` | create | An existing collection to pass with each run |
| `--status <s>` | list, update | `active` or `paused` |
| `--disabled` | create | Create the schedule switched off |
| `--log-ok-invocations` | create, update | Record successful runs too (`--no-log-ok-invocations` turns it off on update) |
| `--limit <n>`, `--cursor <c>` | list, runs | 1 to 200 (default 50); the printed cursor fetches the next page |

```bash
k9o schedule create --function nightly-report --cron "@daily" --timezone Europe/Berlin
```

```text
Created. Schedule 5a2c0a39-6b1e-4f40-9a58-0c7f1d9d2b01
  function: nightly-report
  cron: 0 0 * * * Europe/Berlin
  status: active  catchup: skip
  last run: -  next run: -
  created: 2026-10-26T17:59:56.815Z
```

- An alias is stored and shown expanded.
- An interval under 5 minutes, or `--catchup run_all`, can be refused with `K9O_TIER_FEATURE_GATED`.
- `update` needs at least one flag; the function cannot be changed.

##### End users: `k9o end-user`

| Command | What it does |
|---|---|
| `list` | List end users, newest first (project admin) |
| `get <id>` | Show one end user (project admin) |
| `role-grant list` | List active role grants, oldest first |
| `role-grant grant --end-user <id> --role <role>` | Give an end user a role (project admin) |
| `role-grant revoke <grant-id>` | Revoke a grant (project admin) |

| Flag | Used by | Meaning |
|---|---|---|
| `--status <s>` | list | `active`, `locked`, `deleted` or `all` (default: active and locked) |
| `--q <prefix>` | list | Email prefix, case-sensitive |
| `--limit <n>`, `--cursor <c>` | list | 1 to 200 (default 50); the printed cursor fetches the next page |
| `--end-user <id>` | role-grant list, grant | The end user (`eu_...`) |
| `--role <role>` | role-grant grant | Any string of 1 to 128 characters; there is no fixed list |

- Granting a role the user already holds is an error. A revoked role can be granted again.
- Revoking an unknown or already revoked grant is not an error: it prints `revoked: false`.

##### Sign-in providers: `k9o idp`

The identity providers your project's end users sign in with: Google, GitHub, Microsoft, Apple, Facebook, X, OIDC, SAML, SCIM, LDAP and Active Directory.

| Command | What it does |
|---|---|
| `list` | List the project's providers (project admin) |
| `create` | Register a provider; it is created disabled unless you pass `--enable` (project admin) |
| `update <id>` | Change a provider (project admin) |
| `test <id>` | Check that the provider's endpoints are reachable and a secret is stored |

| Flag | Used by | Meaning |
|---|---|---|
| `--provider <kind>` | create | `google`, `github`, `microsoft`, `apple`, `facebook`, `twitter`, `oidc`, `saml`, `scim`, `ldap` or `active_directory` |
| `--display-name <name>`, `--client-id <id>` | create, update | Name shown to the operator, and the OAuth client id |
| `--client-secret-env <VAR>`, `--client-secret-file <path>` | create, update | Where the client secret is read from. It is never taken from a flag |
| `--redirect-origin <origins>` | create, update | Origins of your web app that may receive the sign-in result, comma separated. On update it replaces the list |
| `--metadata-url <url>`, `--attribute-map <json>` | create, update | Discovery metadata and the claim mapping |
| `--enable`, `--disable` | create (`--enable`), update | Turn the provider on or off |

- The secret is write-only: the gateway encrypts it and reads show only that one is stored.
- If the origin of the redirect address passed to `signInWithProvider` is not in `--redirect-origin`, sign-in is refused with `K9O_IDP_REDIRECT_URI_NOT_ALLOWED`.
- `create` prints the callback URL to add at the provider.

##### Policies: `k9o policy`

A file with a top-level `include` array pulls in other files' rules. Several files are composed into one document.

| Command | What it does |
|---|---|
| `list` | List bundles (`--status draft\|published\|superseded`) |
| `current` | Show the published policy |
| `get <id>` | Show one bundle |
| `validate <file>...` | Lint policy files without saving |
| `apply <file>...` | Create a draft bundle |
| `publish <id>` | Activate a draft bundle; a second approver may be needed |

##### Audit: `k9o audit`

| Command | What it does |
|---|---|
| `tail` | Follow the audit log live, one event per line, until interrupted |
| `replay` | Read one page of events in order, after a known event or from a position |
| `recent` | Fetch the last few minutes of events once |
| `query` | Search history |
| `export <file>` | Write all matching events to an NDJSON file |

| Flag | Meaning |
|---|---|
| `--type <t>` | `tail` only; repeat it (or comma-separate) to keep only those event types |
| `--json` | `tail` only; the same as `--output json` |
| `--after-audit-event-id <evt_...>`, `--from-sequence <n>` | `replay` only; give one. The event id wins over a position |
| `--limit <n>` | `replay`: events in the page (1 to 10000) |
| `--since-minutes`, `--limit` | `recent` only; defaults 5 and 100 |
| `--event-type` | Event type |
| `--actor` | Actor id |
| `--after`, `--before` | ISO time range |
| `--limit`, `--cursor` | Page size (1 to 200) and position |

```bash
k9o audit tail --type data.write.access.insert --json
```

```text
{"auditEventId":"evt_01HZX3","type":"data.write.access.insert","actorType":"user","occurredAt":"2026-10-27T10:00:00.000Z","outcome":"success","eventId":"evt_01HZX3F"}
{"auditEventId":"evt_01HZX4","type":"data.write.access.insert","actorType":"user","occurredAt":"2026-10-27T10:00:03.000Z","outcome":"success","eventId":"evt_01HZX4F"}
```

- `tail` runs until you press Ctrl-C and exits 0. It reconnects by itself and prints each event once. An event has five fields (`auditEventId`, `type`, `actorType`, `occurredAt`, `outcome`) plus `eventId`, the id of the stream message that carried it; read the full row with `k9o audit query`.
- It needs the org-owner, org-admin, project-admin or project-auditor role; an extension cannot tail. `warden.checkpoint` events are not in the live tail; `replay` and `query` carry them.
- `replay` prints one page: the events (each with its `sequence`), `nextCursor` and `hasMore`. Page on by giving `--after-audit-event-id` the last event of the page while `hasMore` is true. An unknown event id is refused with `K9O_INVALID_CURSOR`.

```bash
k9o audit replay --from-sequence 0 --limit 2 --output json
```

```text
{
  "data": {
    "events": [
      {
        "auditEventId": "evt_UGgF77wit3Xx",
        "type": "data.write.pulse_stream.created",
        "actorType": "user",
        "occurredAt": "2026-09-03T08:10:16.927Z",
        "outcome": null,
        "sequence": "1"
      },
      {
        "auditEventId": "evt_BydN0m0dto2Q",
        "type": "data.write.pulse_stream.deleted",
        "actorType": "user",
        "occurredAt": "2026-09-03T15:07:33.960Z",
        "outcome": null,
        "sequence": "2"
      }
    ],
    "nextCursor": "2",
    "hasMore": true
  },
  "meta": {
    "cost": {
      "egress": {
        "gb": 8.91e-7,
        "zone": "intra-region"
      }
    },
    "timing": {
      "gatewayMs": 171.105,
      "totalMs": 171.105
    },
    "context": {
      "requestId": "req_XXXX",
      "traceId": "req_XXXX",
      "projectId": "proj_XXXX"
    }
  }
}
```

`req_XXXX` stands for the request id. `outcome` is `null` for an event that has none.

- `recent` prints the events once and returns:

```bash
k9o audit recent --since-minutes 10
```

```text
2 event(s) in the last 10 minute(s):
  2026-01-15T09:31:02.000Z  migration.applied                         actor=usr_...  target=migration:1
  2026-01-15T09:30:41.000Z  auth.signin                               actor=usr_...  target=-:-
```

##### Keys: `k9o keys`

The project's encryption keys, as metadata only. No key material is ever shown.

| Command | What it does |
|---|---|
| `list [--all]` | List the keys (not paged); `--all` adds the rotating and revoked versions |
| `get <key-id>` | Show one key |
| `rotate <key-id> [--step-up-proof-cmd '<command>']` | Rotate the active key |

```bash
k9o keys list
```

```text
Keys:
  vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90  v3     active     PLATFORM_MANAGED      2026-10-01T10:00:00.000Z
```

- Reading needs the project-admin or project-auditor role, and a person's sign-in (service and workload tokens are refused).
- `rotate` needs project-admin and a fresh MFA step-up. Without `--step-up-proof-cmd`, a missing step-up is printed with its challenge (JSON with `--output json`), the CLI exits 66 and does not retry; complete the step-up and run the command again.
- With `--step-up-proof-cmd`, your command answers the challenge. It receives the challenge as JSON on stdin and the HTTP method and URL in `K9O_STEPUP_METHOD` and `K9O_STEPUP_URL`, and prints `{"method":"dpop|mtls|webauthn","proof":"..."}` as JSON on stdout. The CLI sends the rotation once more with that proof, and only once; a second refusal is printed as it is. The proof is never printed, and the command is stopped when the challenge expires (120 seconds).

```bash
k9o keys rotate vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90 --step-up-proof-cmd './sign-stepup.sh'
```

```text
Rotated vkey_0b9e5c1a-3f6d-4c11-9a52-7d1f2c3e4a90: version 3 -> 4 (rotated).
```

- A rotation is refused, before any step-up, with `K9O_STATE_CONFLICT` (a rotation is running, or the key is not active; exit 69) or `K9O_RATE_LIMITED` (at most 3 rotations in 24 hours; exit 72).
  A rotation is limited to 3 in 24 hours (exit 72) and one at a time (exit 69).

##### Datasets: `k9o analytics`

A dataset is a typed, partitioned table you append to and query with SQL. `dataset` and `datasets` are aliases of `analytics`.

| Command | What it does |
|---|---|
| `list` | List the datasets |
| `get <slug>` | Show one dataset |
| `create <slug>` | Create a dataset |
| `delete <slug>` | Retire a dataset; its slug is never reissued |
| `query` | Run a read-only `SELECT` |
| `read <slug>` | Page through the rows |
| `materialize <slug>` | Copy rows in from a collection or a saved query |
| `write <slug>` | Append rows |
| `upload <slug> <file>` | Load a CSV or JSON file (up to 25 MiB) |
| `download-original <slug>` | Save the original uploaded file |
| `rollups create\|list\|delete\|reattest <dataset>` | Rollups of a stream into the dataset |
| `schedules create\|list\|delete\|reattest <dataset>` | Recurring materializations from a collection |

| Flag | Used by | Meaning |
|---|---|---|
| `--name <text>`, `--residency per-subject\|shared`, `--columns <json\|@file\|->`, `--partition-by a,b` | create | Display name, residency class, `[{"name","type"}]`, partition keys |
| `--sql <sql\|@file\|->`, `--datasets a,b` | query | The statement (refer to each dataset as `dataset.<slug>`) and the datasets it reads |
| `--partition-filter <json>`, `--limit <n>`, `--cursor <c>` | read | Constrain partitions; the printed cursor fetches the next page |
| `--from-collection <name>` or `--from-query <id>` | materialize | Exactly one source |
| `--rows <json>` or `--rows-file <path\|->` | write | A JSON array, or newline-delimited JSON from a file |
| `--on-error skip\|reject` | write, upload | Skip bad rows and report them (default), or refuse the whole write |
| `--format csv\|json`, `--dry-run`, `--delimiter`, `--encoding`, `--no-header`, `--manifest <json\|@file>` | upload | Format (from the extension when absent), preview only, CSV options, create the dataset in the same call |
| `--out <file>` | download-original | Where to save the file |

```bash
k9o analytics create orders --name "Orders" --residency shared --columns '[{"name":"city","type":"string"},{"name":"amount","type":"float64"}]'
k9o analytics write orders --rows '[{"city":"Berlin","amount":42.5},{"city":"San Francisco","amount":17}]'
k9o analytics query --sql 'SELECT city, sum(amount) AS total FROM dataset.orders GROUP BY city' --datasets orders --output json
```

```text
Created. Dataset orders (Orders)
  residency: shared  storage: managed
  partitions: region
  columns: city:string, amount:float64
  created: 2026-11-12T15:47:26.791Z
Wrote to orders: ingested 2, skipped 0
{
  "data": [
    {
      "city": "Berlin",
      "total": 42.5
    },
    {
      "city": "San Francisco",
      "total": 17
    }
  ],
  "meta": {
    "cost": {
      "egress": {
        "gb": 2.47e-7,
        "zone": "intra-region"
      }
    },
    "timing": {
      "gatewayMs": 178.25,
      "totalMs": 178.25
    },
    "context": {
      "requestId": "req_XXXX",
      "traceId": "req_XXXX",
      "projectId": "proj_XXXX"
    }
  }
}
```

The query returns `data` as a list of rows, each an object keyed by column name.

Rollups and schedules:

| Command | Flags |
|---|---|
| `rollups create <dataset>` | `--slug`, `--source <stream>`, `--measures <json\|@file>`, `--window-seconds <n>` (at least 60), `--subject-field <f>` or `--non-personal`, `--dimensions a,b`, `--reattest-days 7\|30\|90\|365` |
| `schedules create <dataset>` | `--from-collection <name>`, `--interval-seconds <n>` (at least 60), `--reattest-days` |
| `rollups reattest <dataset> <id>`, `schedules reattest <dataset> <id>` | `--reattest-days` |

- A rollup or schedule pauses once its attestation interval (default 90 days) passes. `reattest` confirms it is still wanted and resumes it.
  `reattest` is for people only and needs a signed-in session. A service, workload or extension token is refused with `K9O_RBAC_DENY` and reason `human_only` (exit 67); a personal access token is refused with `K9O_RBAC_DENY` and reason `session_required`.
- Project service tokens and extension tokens cannot call these routes at all.

##### Rollups: `k9o rollups`

Read the rollups across the project. Create and re-attest them on a dataset with `k9o analytics rollups`.

| Command | What it does |
|---|---|
| `list` | List the rollups you can read |
| `read <slug>` | Read the cells for a time range (`--from`, `--to`, `--dims a,b`; default the last 24 hours) |
| `subscribe <slug>` | Follow a rollup live, one cell per line (`--from-sequence <n>`, `--count <n>`) |

A rollup folds a stream, and its `--source` is the stream's slug (the one `stream create` prints, or `logs`, `metrics` or `traces` for the project's own streams). A cell exists once its window has closed, so with one-minute windows the first lines arrive about two minutes after the events:

```bash
k9o stream create --name orders-stream --max-bytes 10MiB
k9o analytics rollups create orders --slug orders-per-minute --source orders-stream --measures '[{"name":"orders","agg":"count"},{"name":"revenue","agg":"sum","column":"amount"}]' --window-seconds 60 --non-personal --dimensions city
k9o stream publish orders-stream --data '{"city":"Berlin","amount":19.9}'
k9o rollups subscribe orders-per-minute --output json --count 2
```

```text
{"cellKey":"2026-11-12T15:49:00.000Z|Berlin","bucket":"2026-11-12T15:49:00.000Z","dims":{"city":"Berlin"},"final":true,"measures":{"orders":3,"revenue":59.699999999999996}}
{"cellKey":"2026-11-12T15:49:00.000Z|San Francisco","bucket":"2026-11-12T15:49:00.000Z","dims":{"city":"San Francisco"},"final":true,"measures":{"orders":1,"revenue":19.9}}
```

The output is from publishing four events (three for Berlin, one for San Francisco) with the `publish` line repeated.

- Each line is the cell. A cell below the cohort threshold has `status` `suppressed` and `reason` `cohort_below_k` instead of values; without `--output json` the line starts with `status=suppressed  reason=cohort_below_k`. A cell the stream re-sends prints once. `subscribe` runs until Ctrl-C or `--count` cells, reconnects by itself, and says on stderr when cells in between were lost (re-read them with `read`).

##### Server-side encryption: `k9o crypto`

Encrypt and decrypt data with the project's key encryption key (KEK). You never name a key.

| Command | What it does |
|---|---|
| `encrypt` | Encrypt plaintext; prints the ciphertext as base64 text |
| `decrypt` | Decrypt a ciphertext; writes the plaintext |
| `rewrap` | Open a ciphertext and seal it again under the current key version, in one call |
| `mode` | Print the project's custody mode and epoch (`--output json` for JSON). Pass `--crypt <name>` to ask about that crypt: a personal access token or workload policy scoped to named crypts is refused without one |
| `federated-token` | Write a short-lived identity token to a file or file descriptor, for your own cloud's token exchange (BYOK, HYOK) |

| Flag | Meaning |
|---|---|
| `--crypt <name>` | Required; `a-z`, `0-9` and `-`, 1 to 64 characters, not `actions`. Give the same one on decrypt |
| `--context <text>` | Binds the ciphertext to a value (at most 256 bytes); give the same one on decrypt and rewrap |
| `--in <file\|->`, `--out <file\|->` | Input and output: a file, or `-` for stdin and stdout (the defaults) |
| `--encoding utf8\|base64` | The plaintext as raw bytes (default) or as base64 text, for the input of `encrypt` and the output of `decrypt` |
| `--items-file <file>` | A batch of 1 to 100 items as a JSON array instead of `--in`: `[{"plaintext","context"}]` or `[{"ciphertext","context"}]` |

```bash
printf 'call back on Tuesday' | k9o crypto encrypt --crypt customer-notes --context customer:1042 --out note.enc
k9o crypto decrypt --crypt customer-notes --context customer:1042 --in note.enc
```

```text
call back on Tuesday
```

The first command prints nothing because `--out` writes the ciphertext to `note.enc`. Both commands ran with a personal access token scoped to the `crypto` resource class and the `customer-notes` crypt: an unconstrained personal access token can encrypt, but `decrypt` exits 67 with `K9O_ACCESS_DENIED` ("A personal access token can decrypt or rewrap only when it is scoped to resource class crypto and named crypts").

- A batch prints a JSON array in the order of the items, each entry `{"ok":true,"ciphertext":"..."}` (or `"plaintext"` for decrypt) or `{"ok":false,"code":"...","message":"..."}`. A failed entry is also printed on stderr and the exit code is non-zero; the others are still written.
- Limits: 64 KiB of plaintext per item and 1 MiB per call. The ciphertext is base64 of one opaque container: store it and hand it back unchanged.
- Nothing is retried, a 5xx or a 429 included. The error is printed with its code and the exit code follows the usual map: `K9O_ENVELOPE_INTEGRITY_FAILURE` (a ciphertext that cannot be opened: wrong crypt or context, damaged, another project's) exits 70; `K9O_SEALED_UNDER_RETIRED_KEY` exits 69 (`rewrap` is the fix while the re-seal window is open); `K9O_ZK_STORE_FLOW_REQUIRED` exits 69 too; `K9O_RATE_LIMITED` exits 72; `K9O_KEY_SERVICE_UNAVAILABLE` exits 73.
- How it routes: `encrypt` checks the project's custody mode on every call and never sends plaintext to the platform when the key is in your own KMS or HSM (BYOK or HYOK). That path needs the Kibo client core; the CLI has none registered, so a BYOK or HYOK project gets `K9O_ZK_CLIENT_CORE_UNAVAILABLE` (exit 73) with the requirement printed, and nothing is sent. If the custody mode answer is unknown, missing or malformed, `encrypt` fails closed with `K9O_CRYPTO_CUSTODY_UNKNOWN` and sends nothing; if the mode call itself fails, its own error is shown unchanged. `decrypt` and `rewrap` try the platform first; for ciphertext that belongs to your own key they end in the same `K9O_ZK_CLIENT_CORE_UNAVAILABLE`. Use `kibo.encrypt` and `kibo.decrypt` directly for those projects.
- Who may call: Encrypt needs only a grant on the crypt. Decrypt and rewrap are for machine identities provisioned for that crypt: a service token created with the crypt, or a workload with a policy that names it. A personal access token can decrypt or rewrap only when its scope names the `crypto` resource class and the crypt and it was created with step-up; an unconstrained token is refused (`crypto_requires_scoped_pat`). A browser session needs a fresh step-up for each decrypt or rewrap. Extensions, end users and mobile cannot call it (extensions keep `k9o.kibo.encrypt`). IAM on the crypt decides who may encrypt, decrypt or rewrap; the default floor is `PROJECT_EDITOR`.
- `federated-token`: `k9o crypto federated-token --crypt <name> [--op encrypt|decrypt|rewrap] --out <file>|--out-fd <n>|--out - [--force]`. The token is a credential and lasts at most 15 minutes, so it is never printed unless you ask: `--out <file>` creates the file with mode 0600 and refuses an existing file unless `--force` (which replaces it); `--out-fd <n>` (3 or higher) writes to an open descriptor, for a pipe or process substitution; `--out -` writes it to stdout with a newline. Files and descriptors hold the token exactly, with no trailing newline. stdout otherwise shows where it went and `expiresAt`, `issuer`, `subject`, `audience` and `kid`, never the token. Delete the file when you are done. `K9O_CUSTODY_SERVER_ROUTE` means no token is issued: the route is `server` when the platform holds the key or the install is self-hosted, and `client-idp` when the platform has no identity token for your key's provider.

```bash
k9o crypto federated-token --crypt customer-notes --out /run/user/1000/k9o-token
AWS_WEB_IDENTITY_TOKEN_FILE=/run/user/1000/k9o-token aws sts get-caller-identity
```

- Erasure: the ciphertext is covered by the project KEK's lifecycle only. A zeroize of the key or a project purge makes it unreadable everywhere. It is not covered by per-subject erasure: the platform does not know whose data you encrypted.

##### Vault secrets: `k9o vault-secret`

Every command except `list` needs `--region`.

| Command | What it does |
|---|---|
| `list` | List secret metadata (`--prefix`, `--cursor`, `--limit`) |
| `get <name>` | Show one secret's metadata |
| `create <name>` | Seal a new secret |
| `reveal <name>` | Mint a challenge and show the plaintext value |
| `update <name>` | Set a new value |
| `rotate <name>` | Re-wrap under a fresh key |
| `move <name> --new-path <path>` | Rename the path |
| `delete <name>` | Retire a secret |

`create` and `update` take `--value` (prompted if omitted) and `--metadata k=v,k2=v2`. `create` also takes `--visibility private|shared`.

##### Storage: `k9o storage`

| Command | What it does |
|---|---|
| `buckets list` | List buckets |
| `buckets get <name>` | Show one bucket |
| `buckets create <name>` | Create a bucket |
| `buckets update <name>` | Change a bucket |
| `buckets delete <name>` | Delete a bucket; `--empty` removes its objects first |
| `objects upload <bucket> <path>` | Upload (`--file <path>` or `--stdin`) |
| `objects list <bucket>` | List objects (`--prefix`) |
| `objects sign <bucket> <path>` | Make a signed download URL |
| `objects delete <bucket> <path>` | Delete an object |
| `locations list\|get\|create\|update\|retire\|test` | Manage your own object stores |

| Flag | Used by | Meaning |
|---|---|---|
| `--file-size-limit <bytes>` | buckets create, update | Largest object size |
| `--allowed-mime-types <a,b>` | buckets create, update | Allowed content types |
| `--location <locationId>` | buckets create, update | Link the bucket to a storage location |
| `--content-type`, `--upsert`, `--metadata k=v` | objects upload | Content type, overwrite, labels |
| `--expires-in <seconds>` | objects sign | Required, in seconds; the gateway clamps it to 900 |
| `--download` | objects sign | Make the URL download the file |

- On `buckets update`, `--clear-file-size-limit`, `--any-mime-type` and `--unlink-location` remove a setting.
- The gateway caps a signed URL at 900 seconds, whatever you ask for. The CLI prints a note when it does.
- `locations create` needs `--provider`, `--bucket-name`, `--region`, `--provider-region` and `--credential-ref`.
- Optional `locations` flags: `--endpoint-override` and `--custody-mode PLATFORM_MANAGED|BYOK|HYOK`.
- Providers are `s3`, `s3_compatible`, `gcs`, `azure_blob`, `minio`, `r2` and `b2`.
- `r2` also needs `--account-id` and `--parent-access-key-id`. `b2` needs `--bucket-id`.

##### Own-store credentials: `k9o byos-cred`

| Command | What it does |
|---|---|
| `create <name>` | Store a cloud credential in the vault and print a `kibo://byos-creds/<id>` reference |

- `--provider` is `s3`, `s3_compatible`, `minio`, `gcs`, `b2` or `r2`.
- `--region` is required (or `K9O_BYOS_REGION`). `--provider-region` is also required for `s3`, `s3_compatible` and `minio`.
- Pass that reference to `k9o storage locations create --credential-ref`.

##### AI: `k9o ai`

| Command | What it does |
|---|---|
| `embed <text>...` | Turn each text into a vector (`--model <id>`) |
| `embed --file <path\|->` | Embed a whole file or stdin as one input |
| `generate <prompt\|->` | Print generated text (`--model <id>`, `--max-tokens N`, `--temperature T`); usage goes to stderr |

Run it as a project member. An end user's token is refused.
Without `--model`, `generate` uses the org's default model and answers 400 when there is none.
A model served by an outside provider answers 501 until that provider is built.

##### Extensions: `k9o ext-admin` and `k9o ext`

`k9o extension-admin` and `k9o extension` are aliases.

| Command | What it does |
|---|---|
| `ext-admin list` | List extensions installed on the project |
| `ext-admin enable <slug>` | Enable an extension |
| `ext-admin disable <slug>` | Disable an extension |
| `ext-admin config <slug>` | Show the config, or merge a JSON object with `--set <json>` |
| `ext <slug> <verb>` | Run a command the extension declares |

`ext` works for a signed-in operator only. A service token or personal access token is refused.

##### Organization: `k9o org`

| Group | Verbs |
|---|---|
| `get` | Read the organization |
| `members` | `list`, `invite`, `remove` |
| `groups` | `list`, `get` (read-only) |
| `roles` | `list`, `grant`, `revoke` |
| `audit` | `query` |
| `smtp` | `set`, `test`, `unset` |
| `idp` | `list`, `create`, `configure`, `delete` |

##### Your account: `k9o me`

| Group | Verbs |
|---|---|
| `profile` | `get`, `update` |
| `sessions` | `list`, `revoke`, `revoke-all` |
| `api-tokens` | `list`, `create`, `delete` |

`k9o me api-tokens create <label> --tier readonly|readwrite|admin [--projects <slug,...>] [--resource-classes <a,b>] [--cidrs <cidr,...>] [--ttl-days <n>]` creates a token at one tier: `readonly` can read, `readwrite` can also change content, and `admin` can also manage access, keys and credentials. A higher tier includes the ones below it. `--tier` is required. `list` shows each token's tier; a token that holds no access shows `no access (re-create)`.

A `readonly` token can still decrypt, because decrypt counts as a read. Its crypt grant limits which crypts it reaches, and it cannot encrypt or rewrap. Do not hand a `readonly` token to anything that must not see plaintext.

##### Local settings: `k9o config`

Defaults for the active profile are kept in `~/.k9o/config.json`.

| Command | What it does |
|---|---|
| `set <key> <value>` | Set a key |
| `get <key>` | Read a key |
| `unset <key>` | Clear a key |
| `list` | List all keys |

| Key | Values |
|---|---|
| `outputFormat` | `human`, `json` |
| `color` | `true`, `false` |

##### Local development stack: `k9o stack`

These commands need `run.sh` from a `k9o-core` checkout. The npm package does not ship it.
Run them inside a checkout, or set `K9O_RUNSH_PATH`. `k9o up` is an alias for `k9o stack up`.

| Command | What it does |
|---|---|
| `up` | Start the stack |
| `down` | Stop it and keep data |
| `nuke [--yes]` | Stop it and wipe data |
| `status` | Print health and endpoints |
| `logs [service]` | Tail logs |
| `showroom list` | List demo verticals (run as `k9o showroom list`) |
| `showroom <slug>` | Provision a demo project (run as `k9o showroom <slug>`) |
| `doctor` | Check Docker, ports and disk (run as `k9o doctor`) |

| Tier flag | Adds |
|---|---|
| `--minimal` | Gateway and Postgres only |
| `--ai` | Local model inference |
| `--full` | Real vault custody |

##### Utilities

| Command | What it does |
|---|---|
| `k9o ledger verify` | Verify an exported audit ledger offline |
| `k9o completion <shell>` | Print a completion script for `bash`, `zsh` or `fish` |

- `ledger verify` takes `--file <path>` or `--stdin`, and optionally `--key-set` with `--signature`, and `--format json|ndjson`.
- It needs the `kibo-ledger-verify` binary on `PATH`, or `K9O_LEDGER_VERIFY_BIN`. The npm package does not ship it.

```bash
source <(k9o completion bash)
```

#### 10.2 Global flags

These work on every command.

| Flag | What it does |
|---|---|
| `--project <slug>`, `-P` | Override the project |
| `--org <slug>`, `-O` | Override the organization |
| `--base-url <url>` | Gateway host; used by `login`, `init` and service-token runs |
| `--output human\|json` | Choose the output format |
| `--profile <name>`, `-p` | Choose the profile |
| `--no-color` | Turn off colors (also honors `NO_COLOR`) |
| `--quiet`, `-q` | Hide non-essential output |
| `--verbose`, `-v` | Print debug diagnostics |
| `--help`, `-h` | Show help |

#### 10.3 Environment variables

The flag wins when both are set.

| Variable | Same as | Notes |
|---|---|---|
| `K9O_SERVICE_TOKEN` | | Bearer token for CI. No login needed; set the org and project too |
| `K9O_WORKLOAD_ID` | `--workload-id` | Keyless sign-in from CI. Set the org and project too |
| `K9O_WORKLOAD_TAG` | `--workload-tag` | Optional label |
| `K9O_OIDC_TOKEN` | | External OIDC token to exchange |
| `K9O_OIDC_AUDIENCE` | `--oidc-audience` | Audience to request on GitHub Actions |
| `K9O_ORG` | `--org` | |
| `K9O_PROJECT` | `--project` | |
| `K9O_PROFILE` | `--profile` | Default `default` |
| `K9O_OUTPUT` | `--output` | `human` or `json` |
| `K9O_BASE_URL` | `--base-url` | `login`, `init` and service-token runs |
| `K9O_EMAIL` | `--email` | Login only |
| `K9O_PASSWORD` | | Login only (there is no flag) |
| `K9O_MFA_CODE` | `--mfa-code` | Login only |
| `K9O_RUNSH_PATH` | | Path to `run.sh` for the local stack commands |
| `K9O_LEDGER_VERIFY_BIN` | | Path to the `kibo-ledger-verify` binary |

#### 10.4 Exit codes

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic or unclassified error |
| 2 | Usage error (missing argument, unknown command) |
| 64 | Local config file is malformed |
| 65 | Missing project or organization |
| 66 | Not signed in or sign-in failed (HTTP 401) |
| 67 | Not permitted (HTTP 403) |
| 68 | Not found (HTTP 404) |
| 69 | Conflict or already exists (HTTP 409) |
| 70 | Invalid request (HTTP 400) |
| 71 | Request rejected as invalid (HTTP 422) |
| 72 | Plan limit reached (`K9O_TIER_CAP_HIT`, HTTP 409) or rate limited (HTTP 429) |
| 73 | Service unavailable (HTTP 5xx) |
| 74 | Token or session expired (HTTP 410) |
| 75 | Lifecycle conflict, such as a soft-deleted project |


#### 10.6 About Kilimanjaro

Kilimanjaro is a modular developer platform for building secure enterprise applications.
You define AI agents, functions and data pipelines on the platform.
The SDKs let you deploy and invoke them, read and write your data, publish to and subscribe to streams,
sign users in, and encrypt with keys you hold.

It provides four building blocks:

- **Keep**: AI security and governance. Guardrails and policy for the agents you run.
- **Pulse**: data intelligence and real-time stream processing. Streams, analytics and live feeds.
- **Gate**: customer identity and access management. Sign-in and sessions, and automatic data scoping so a signed-in user reaches only their own data.
- **Kibo**: cryptographic keys and secrets management. Client-side encryption with keys you hold, and a secrets vault.

#### 10.5 Command manifest

The package ships `command-manifest.json`: one entry for every `k9o` command, generated from the CLI's own source with `bun run manifest`. A test fails when the committed file differs from what the generator produces.

Each entry holds:

| Field | Holds |
|---|---|
| `path` | The words after `k9o`, for example `["rollups", "read"]`. |
| `aliases` | Other first words that run the same command, for example `dataset` for `analytics`. |
| `usage` | The full usage line, optional parts in brackets. |
| `sample` | The shortest call that works: the required arguments and flags, each with a placeholder. |
| `description` | The help text for the command. |
| `positionals`, `flags` | The arguments and flags, each marked optional or required. A flag with a `null` value is a switch. |
| `sdkMethods` | The SDK methods the command calls, written the way the OpenAPI `x-sdk-method` field writes them, for example `k9o.rollups.read()`. Empty for a command that makes no API call, or that calls the gateway directly. |
| `restRoutes` | For a command with no SDK method that calls a gateway route directly: each route as `METHOD /path/{template}`, written as the gateway's OpenAPI document writes it, for example `GET /@{projectSlug}/extensions-admin`. |

`sdkMethodIndex` maps each SDK method to the commands that call it, and `restRouteIndex` maps each `METHOD /path/{template}` to the commands that call that route directly. When several commands share a key, the first is the one to show.

A sample reads `k9o <command> [<subcommand>] <argument>... --flag <value>...`. A name in angle brackets is for you to replace. A flag that takes no value stands alone, for example `--non-personal`. When a command accepts one of several flags, the sample shows the first. Run the sample after `k9o login --org <slug> --project <slug>`, or with `K9O_SERVICE_TOKEN`, `K9O_ORG` and `K9O_PROJECT` set.

```json
{
  "path": ["rollups", "read"],
  "usage": "k9o rollups read <slug> [--from <ISO time>] [--to <ISO time>] [--dims a,b]",
  "sample": "k9o rollups read <slug>",
  "sdkMethods": ["k9o.rollups.read()"]
}
```

### 11. License

Apache-2.0 © Formelo Inc. See `LICENSE` and `NOTICE`.
