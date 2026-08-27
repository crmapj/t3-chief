# Command reference

Every command supports global `--json`, `--quiet`, `--environment NAME`, and `--include-prompt`.
The last flag reveals stored schedule prompt bodies, which are redacted by default. JSON output
uses a versioned envelope and writes errors as JSON to stderr.

## Fleet and threads

```text
t3chief providers
t3chief status
t3chief brief THREAD [--turns 1..150]
t3chief settle-ready [--apply]

t3chief thread send THREAD [--prompt TEXT | --prompt-file PATH | stdin]
t3chief thread start --project ID --title TITLE --provider INSTANCE --model SLUG
  [--option ID=VALUE] [--effort VALUE]
  [--runtime-mode MODE] [--interaction-mode MODE]
  [--worktree --base-branch BRANCH --start-from-origin]
  [--prompt TEXT | --prompt-file PATH | stdin]
t3chief thread interrupt THREAD
t3chief thread settle THREAD
t3chief thread unsettle THREAD
```

Exact IDs are preferred. An unambiguous ID prefix or exact title can be used for interactive reads;
mutations reject ambiguous references.

## Projects

```text
t3chief project list
t3chief project create --title TITLE --workspace ABSOLUTE_PATH
  [--create-workspace]
  [--provider INSTANCE --model SLUG [--effort VALUE] [--option ID=VALUE]]
```

`project list` reads the shell snapshot and reports each project's ID, title, workspace root, and
thread count. `project create` dispatches T3's `project.create` command with a client-generated
project ID, so the new ID is known before the call and is returned in the envelope.

`--workspace` is resolved to an absolute path locally and normalized again by T3. Creating a
project whose workspace root already belongs to another project fails closed, naming the existing
project, so one directory never ends up with two IDs. `--create-workspace` lets T3 create the
directory when it does not exist yet.

A default route is optional and all-or-nothing: `--provider` and `--model` must be given together
and are validated against the live catalog before dispatch. New threads in the project inherit it.

## Provider limits

```text
t3chief limits [--provider codex|claude|grok] [--claude-budget TOKENS] [--window-minutes MINUTES]
  [--no-probe]
t3chief limits configure-claude [--profile NAME --command ABSOLUTE_PATH [ARG...]] [--remove NAME]
t3chief limits statusline-sink [--profile NAME] [--exec COMMAND [ARG...]]
```

`limits` reports quota headroom per provider. Every entry carries `windows[]`, an optional
`credits`, `observedAt`, optional `notes`, an optional `profile` for separately metered accounts,
and a `source` stating the reading's authority:

| Source | Meaning | Authority |
|---|---|---|
| `exact-snapshot` | The provider's own quota record, such as the `rate_limits` block in the newest Codex rollout. | fact |
| `oauth-usage` | Anthropic's `GET /api/oauth/usage`. | fact |
| `probe` | Anthropic's unified rate-limit response headers from a one-token call. | fact |
| `statusline` | A capture from Claude Code's statusline feed. | fact |
| `signal` | Inferred from an observed session-limit message. | limited-only |
| `estimate` | Summed from local transcripts. | indicative |
| `unknown` | No readable source on this host. Unknown headroom, not zero. | none |

`usedPercent` is always a 0..100 percentage and `resetsAt` is always RFC3339, whichever source
produced them. Sources disagree on the wire: response headers use a 0..1 fraction and epoch
seconds, the usage endpoint uses 0..100 and RFC3339, and the statusline feed uses 0..100 and epoch
seconds. Normalization happens on ingest.

### Codex

Primary source is an ephemeral `codex app-server`, driven over stdio JSON-RPC with
`account/rateLimits/read`, the same call the Codex TUI's `/status` makes. It costs no tokens and no
quota, writes no rollout, and returns every metered bucket on the account. Each bucket becomes its
own row, labelled with its `limitId` in `profile` and carrying its own windows, credits, and plan.

The shared daemon (`codex app-server daemon start`) is deliberately never used, because it shares
state with a running fleet. The binary is resolved from `PATH`, or from `T3CHIEF_CODEX_BIN`.

The rollout parse remains as a fallback and is now labelled accordingly. A rollout records only the
bucket its last turn used, so it is a single-bucket reading that can be hours old: an account can
sit at 20% on `example-weekly` while the newest rollout reports 0% for `example-burst`. Fallback rows name
the bucket and their age in a note.

There is deliberately no probe turn: a trivial `codex exec` costs around 9-10k input tokens and
refreshes the wrong bucket. The `chatgpt.com` usage endpoint is deliberately not called directly
either, because its bearer is a short-lived JWT the CLI owns refreshing, and the app-server route
inherits that refresh for free.

### Claude

With no profiles configured, Claude falls back to a transcript estimate: `message.usage` summed
over a trailing window, de-duplicated by message ID because one API response leaves several
records behind while it streams. Without a denominator `usedPercent` stays null and `usage` carries
the raw counts; `--claude-budget` supplies the denominator. `usage.totalTokens` is a floor whenever
a note reports a truncated transcript.

Configure a profile to get real numbers:

```sh
t3chief limits configure-claude --profile work --command /absolute/path/to/token-command work
```

The command must print an OAuth token on stdout. t3chief never stores the token, never passes it as
an argument, and never logs it; a failing token command is reported by exit code only, because a
misconfigured command could print the token to stderr. Configuration lives in the config file, not
in this repository.

Per profile, in order: a cached reading, then a fresh statusline capture, then
`GET /api/oauth/usage`, then a one-token `POST /v1/messages` whose response headers carry the same
numbers. Setup tokens are inference-scoped and answer the usage endpoint with HTTP 403, which is
why the header path exists. Both are internal surfaces, so every parse is defensive and any failure
leaves the profile reported as `unknown` with a reason rather than as a fabricated number.

Cost and rate-limit discipline, all enforced in the ledger:

- Readings are cached for five minutes.
- Endpoint calls are reserved atomically, so parallel t3chief processes never double-fetch and no
  profile is called more often than once every three minutes.
- HTTP 429 backs the profile off for the longer of `Retry-After` and the minimum interval, and a
  shorter later backoff never shortens one already in force.
- Requests carry `User-Agent: claude-code/<installed version>`. Without a client user agent the
  usage endpoint throttles hard and stays throttled.
- `--no-probe` skips the network entirely. Cached and statusline readings still count.

A probe spends about one token against the same 5h window it measures, so `limits` is not something
to poll.

The weekly `resetsAt` is advisory. Measured replenishment has run on roughly 72-hour cycles while
the reported reset sat a week out, and the counter can jump mid-cycle. Gate routing on
`usedPercent`, not on a predicted weekly reset.

### Statusline capture

`statusline-sink` reads Claude Code's statusline JSON on stdin, atomically writes the normalized
reading into the state directory, and prints nothing. Point Claude Code's `statusLine` setting at
it, using `--exec` to keep an existing statusline visible:

```sh
t3chief limits statusline-sink --profile work --exec /path/to/my-statusline
```

`rate_limits` appears in that payload only in TUI sessions on a paid plan and only after the first
response, so a missing capture is normal.

### Grok

T3's Grok driver is xAI's official CLI on a subscription seat, so the key-based
`api.x.ai` surfaces do not apply. `limits` spawns an ephemeral `grok agent stdio` and calls the
`_x.ai/billing` and `_x.ai/auth/check_subscription` ACP extensions. This costs no tokens.
`session/new` is never called, because it would create session directories as a side effect. The
binary is resolved from `PATH`, or from `T3CHIEF_GROK_BIN`.

The row reports the subscription tier, the current usage window with its exact end as the reset,
and any access gate or unauthenticated state. It reports no account identity.

`usedPercent` is null for a pure subscription seat, and that is deliberate: xAI publishes no
remaining-headroom metric until on-demand credits give the number a denominator. When
`onDemandCap` is above zero, or the provider supplies `creditUsagePercent`, the real percentage is
reported. A percentage is never derived from session token counts.

Both extensions are undocumented and the Grok CLI self-updates, so every field is optional. An
unknown-method error, a spawn failure, or an unexpected schema degrades the row to `unknown` with
the reason rather than failing the command.

## Caching and cost

Codex and Grok readings cache for 60 seconds; Claude readings cache for five minutes. All three
reserve their endpoint through the same ledger transaction, so concurrent t3chief processes cannot
double-probe. `--no-probe` skips every spawn and network call and serves cached, rollout, and
estimate readings only.

## Environments

```text
t3chief environment list
t3chief environment add NAME --url URL
  (--token-stdin | --pairing-stdin | --token-file PATH) [--default] [--insecure]
t3chief environment default NAME
t3chief environment local-refresh NAME --t3-cli ABSOLUTE_PATH --base-dir ABSOLUTE_PATH
  [--before-days DAYS]
t3chief environment refresh NAME
t3chief environment remove NAME
```

Use stdin pairing for normal setup. `--token-file` exists for automated provisioning where an
already scoped session is supplied through a protected file. Non-loopback environments require
HTTPS/WSS. `--insecure` prints a warning and permits HTTP/WS only for a trusted local network.

## Schedules

`add` and `validate` share these flags:

```text
--at RFC3339 | --cron 'FIVE FIELD CRON' --timezone IANA_ZONE
--thread THREAD_ID
  | --project PROJECT_ID --new-thread TITLE --provider INSTANCE --model SLUG
--option ID=VALUE                 repeatable
--effort VALUE                    convenience for a live effort descriptor
--runtime-mode approval-required|auto-accept-edits|auto|full-access
--interaction-mode default|plan
--worktree --base-branch BRANCH --start-from-origin
--prompt TEXT | --prompt-file PATH | stdin
--misfire latest|skip             default: latest
--when-busy defer|skip            default: defer
--disabled
--expected-revision NUMBER        compare-and-swap update
```

The commands are:

```text
t3chief schedule validate KEY [definition flags]
t3chief schedule add KEY [definition flags]
t3chief schedule list
t3chief schedule show ID_OR_KEY
t3chief schedule pause ID_OR_KEY
t3chief schedule resume ID_OR_KEY
t3chief schedule remove ID_OR_KEY
t3chief schedule run ID_OR_KEY [--request-id KEY] [--now RFC3339] [--dry-run]
t3chief schedule occurrences [--schedule ID_OR_KEY]
t3chief schedule tick [--apply] [--now RFC3339]

t3chief tick [--apply] [--now RFC3339]
t3chief rate-limits tick [--apply] [--now RFC3339]
t3chief rate-limits status
t3chief maintenance capture
t3chief maintenance stopped [--at RFC3339]
t3chief maintenance deliver [--now RFC3339]
t3chief maintenance status
```

`schedule tick` is the only recurrence mutation loop. Without `--apply`, it returns a plan and does
not reserve or deliver occurrences. Schedule prompts are omitted from human and JSON output unless
the global `--include-prompt` opt-in is present.

## Unified jobs and scheduler wake

```text
t3chief jobs [--include-commands]
t3chief job enable REF
t3chief job disable REF
t3chief job run REF [--request-id KEY]
t3chief host jobs [--include-commands]
t3chief host install [--backend systemd-user|cron] [--executable ABSOLUTE_PATH]
t3chief host uninstall [--backend systemd-user|cron]
t3chief doctor
```

References are explicit, for example `t3:nightly-audit`,
`systemd:user:t3-nightly-update.timer`, or a ref returned by `t3chief jobs --json`. Inspect an
item's `capabilities` before mutation.

Cron commands and command-derived labels are redacted in both output modes by default. Use
`--include-commands` only for an explicit inspection by a local caller.

`tick` is the installed one-minute entry point. It runs the schedule, rate-limit, and maintenance
loops. The narrower tick commands exist for inspection and repair.
