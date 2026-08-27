# t3-chief

`t3chief` is a standalone chief-of-staff control plane for T3 Code. It gives one manager a
body-free fleet view, bounded thread reads, live provider routing, safe thread control, durable
scheduled turns, and one inventory for T3 schedules, systemd timers, and cron jobs.

T3 remains the source of truth for projects, threads, transcripts, providers, sessions, and
command receipts. `t3chief` keeps only configuration, schedule definitions, deterministic delivery
intents, receipts, and audit state. It depends on no external orchestration platform and never
reads T3's database.

## The operating pattern

`t3chief` is built around one way of working:

1. **Pin a few dedicated manager threads.** Each role — a chief of staff, a head of engineering —
   is one long-lived T3 thread, pinned at the top of the fleet and anchored to its own folder
   carrying that role's instructions and personality, which the agent loads on every start.
2. **Managers delegate; they don't do the work inline.** A manager checks `providers` and `limits`,
   opens a worker thread with a self-contained brief, and passes `--reply-to` with its own thread
   ID so the worker reports the outcome back to it.
3. **Managers run the loop.** `status` to scan the fleet without spending context, `brief` to read
   just enough of one thread, `thread send` to steer, `settle-ready` to close finished work, and
   `schedule` for their own recurring pass.

You talk to the pinned managers. The managers run the fleet.

## What works

- Scan every active unsettled thread without loading message bodies.
- Read only the latest requested user-turn window, with local per-message and total text caps.
- Start or drive threads with the exact provider instance, model, and model options advertised by
  the live T3 environment.
- Interrupt, settle, unsettle, and conservatively settle completed threads in bulk.
- Schedule a turn into an existing thread or create a new thread on a one-time or cron trigger.
- Revalidate routes before delivery, defer busy threads, coalesce missed runs, and recover safely
  after crashes with deterministic T3 command IDs.
- List T3 schedules beside user/system systemd timers and user/system cron entries. User jobs
  expose only supported actions; system jobs remain read-only.
- Wake the scheduler through one hardened persistent user systemd timer. A single crontab entry is
  available as a portable fallback.
- Report per-provider quota headroom before choosing a route: live reads from Codex, Claude, and
  Grok where they exist, and a clearly labelled local estimate where they do not.
- Detect the provider's exact session-limit message through bounded T3 API reads, remember it
  before reset, and continue the same thread once after the stated UTC reset plus two minutes.
- Capture turns before planned T3 maintenance and resume only turns that T3 proves were
  interrupted by that stop. The same one-minute timer retries both recovery loops.

## Install

```sh
bun install --frozen-lockfile
bun run check
bun run build
install -d "$HOME/.local/bin"
install -m 0755 dist/t3chief "$HOME/.local/bin/t3chief"
```

Add `$HOME/.local/bin` to `PATH` if your shell does not already include it.

## Install the agent skill

`t3chief` is the control plane; the bundled skill is what teaches an agent to use it well. Install
it straight from the repository with the [skills](https://skills.sh) CLI:

```sh
# every agent, user-wide
npx -y skills add crmapj/t3-chief --skill t3-chief --agent '*' --global --yes

# one agent, current project only
npx -y skills add crmapj/t3-chief --skill t3-chief --agent claude-code --yes

# from a local checkout
npx -y skills add . --skill t3-chief --agent '*' --global --yes
```

The skill lives at `skills/t3-chief/` and is discovered automatically; `--list` shows it without
installing anything. It covers when to spend context, how to pick a route, how to check provider
headroom, the reply-back channel, and the hard boundaries.

Pair one environment without putting credentials in process arguments:

```sh
t3 auth pairing create --json | jq -r .credential | \
  t3chief environment add home --url http://127.0.0.1:3787 --pairing-stdin --default
t3chief --json doctor
```

Pairing requests only `orchestration:read` and `orchestration:operate`. Configuration lives under
`$XDG_CONFIG_HOME/t3chief` and credentials use separate owner-only files. The durable ledger lives
under `$XDG_STATE_HOME/t3chief`.

For a T3 server on the same host, enable rolling credential renewal. The local CLI mints a
five-minute one-time pairing credential in memory; t3-chief exchanges it for the same narrow
read/operate session and never writes the bootstrap secret:

```sh
t3chief environment local-refresh home \
  --t3-cli "$HOME/t3-nightly/current/dist/bin.mjs" \
  --base-dir "$HOME/.t3-nightly" \
  --before-days 7
t3chief environment refresh home
```

Remote environments require HTTPS (and use WSS for RPC), remain pairing-only, and should be
renewed by their owner before expiry. `--insecure` is a warned opt-in for trusted local networks;
it sends credentials over plaintext HTTP/WS.

Install the one-minute wake job:

```sh
t3chief host install --backend systemd-user --executable "$HOME/.local/bin/t3chief"
```

## Daily manager loop

```sh
t3chief --json status
t3chief --json brief THREAD_ID --turns 10
t3chief --json thread send THREAD_ID --prompt-file follow-up.md
t3chief --json settle-ready
t3chief --json settle-ready --apply
```

`status` reads only T3 shells. Use `brief` only for blocked, failed, completed, stale, or explicitly
requested threads. `--turns 50` means the last 50 user-anchored turns, not necessarily 50 visible
messages; related agent and subagent items may also be returned. The client then caps each message
at 8,000 characters and the whole projection at 80,000 characters.

A dedicated manager can schedule its own recurring pass by targeting its existing T3 thread:

```sh
t3chief schedule add chief-morning-pass \
  --cron '0 9 * * 1-5' \
  --timezone Europe/Amsterdam \
  --thread CHIEF_THREAD_ID \
  --prompt 'Use the t3-chief skill. Refresh the roadmap, inspect the fleet, drive blocked work, review evidence, and report status.'
```

Keep one manager thread per roadmap or authority boundary. Its T3 conversation carries the
roadmap decisions; the CLI keeps only deterministic operational state.

Projects hold threads. List them, and register a workspace when the right project does not exist:

```sh
t3chief project list
t3chief --json project create --title 'Fleet tooling' --workspace /absolute/workspace/path
```

`project create` generates the project ID locally and dispatches T3's `project.create` command, so
the ID is returned in the envelope and can be passed straight to `thread start --project`. A
workspace that already belongs to another project is rejected rather than duplicated. Pass
`--provider` and `--model` together to give the project a validated default route.

Discover routing keys before starting work:

```sh
t3chief providers
t3chief thread start \
  --project PROJECT_ID \
  --title "Investigate the release gate" \
  --provider codex \
  --model gpt-5.6-sol \
  --effort high \
  --runtime-mode full-access \
  --prompt-file brief.md
```

Provider names, model slugs, and option values are never hard-coded into the scheduler. It also
checks the live instance's enabled, installed, availability, status, and authentication fields.
`--effort` maps onto the matching live option descriptor, while `--option id=value` selects any
advertised model option directly.

## Provider headroom

Check quota before choosing a route:

```sh
t3chief --json limits
t3chief limits --provider codex
t3chief limits --no-probe
```

Every row states a `source` so a caller knows what the numbers are worth. `exact-snapshot`,
`oauth-usage`, `probe`, and `statusline` are provider-reported facts; `signal` proves only that a
limit was hit; `estimate` is indicative; `unknown` means unknown headroom rather than zero.
`usedPercent` is always 0..100 and `resetsAt` is always RFC3339, whichever source produced them.

Codex and Grok are read live at no cost, by driving their own CLIs over stdio JSON-RPC. Codex
returns every metered bucket on the account, one row each; Grok returns its subscription tier and
usage window. Both fall back cleanly when the CLI is missing or its interface changes.

Claude reports real numbers once you register how to obtain a token for each account:

```sh
t3chief limits configure-claude --profile work --command /absolute/path/to/token-command work
```

The command prints an OAuth token on stdout. t3chief never stores it, never passes it as an
argument, and never logs it. Each profile becomes its own row. Readings come from the usage
endpoint when the token's scope allows it, otherwise from the unified rate-limit headers of a
one-token inference call. Results are cached for five minutes, no profile is called more than once
every three minutes, HTTP 429 is honoured with `Retry-After`, and concurrent t3chief processes are
serialized through the ledger so they cannot double-fetch. `--no-probe` skips the network and uses
cached and local readings only.

This is synthetic output; its future dates, round values, generic labels, and profiles are not
account telemetry.

```text
codex/example-weekly        source=probe          observed=2030-01-01T12:00:00.000Z
  weekly      20% used  resets=2030-01-08T12:00:00.000Z
  note     Bucket name: Example weekly allowance.
codex/example-burst         source=probe          observed=2030-01-01T12:00:00.000Z
  5h          40% used  resets=2030-01-01T17:00:00.000Z
claude/work                 source=probe          observed=2030-01-01T12:00:00.000Z
  5h          30% used  resets=2030-01-01T17:00:00.000Z
  weekly      50% used  resets=2030-01-08T12:00:00.000Z
claude/personal             source=probe          observed=2030-01-01T12:00:00.000Z
  5h          20% used  resets=2030-01-01T17:00:00.000Z
  weekly      70% used  resets=2030-01-08T12:00:00.000Z
  note     Provider unified status: allowed_warning.
grok                       source=probe          observed=2030-01-01T12:00:00.000Z
  weekly     n/a  used  resets=2030-01-08T12:00:00.000Z
  note     Subscription tier: Example plan.
  note     No headroom metric published for this seat; the weekly window resets 2030-01-08T12:00:00.000Z.
```

With no profile configured, Claude falls back to a transcript estimate over a trailing window;
`--claude-budget TOKENS` supplies the denominator that turns its raw token counts into a
percentage.

For a zero-cost reading, point Claude Code's `statusLine` setting at the sink, which captures the
quota it already receives and prints nothing:

```sh
t3chief limits statusline-sink --profile work --exec /path/to/my-statusline
```

Three caveats worth respecting. A Codex `exact-snapshot` fallback row covers only the bucket its
last turn used, so it can read 0% while another bucket on the same account is a third spent; a
`probe` row set covers everything. A null `usedPercent` means no denominator was published, not
zero usage: Grok publishes none for a pure subscription seat. And the weekly `resetsAt` is
advisory, since measured replenishment has run on roughly 72-hour cycles while the reported reset
sat a week out, so gate routing on `usedPercent` rather than on a predicted reset.

Only the Claude probe costs anything, about one token against the same 5h window it measures, so
`limits` is not something to poll. Readings are cached and endpoint calls are serialized through
the ledger across processes.

## Scheduled turns

Schedule an existing thread. Its current route and interaction modes are used and revalidated at
delivery time:

```sh
t3chief schedule add weekly-review \
  --cron '0 9 * * 1' \
  --timezone Europe/Amsterdam \
  --thread THREAD_ID \
  --prompt-file weekly-review.md
```

Schedule a new thread with an exact live route:

```sh
t3chief schedule add nightly-audit \
  --cron '30 2 * * *' \
  --timezone UTC \
  --project PROJECT_ID \
  --new-thread 'Nightly audit' \
  --provider PROVIDER_INSTANCE \
  --model MODEL_SLUG \
  --effort high \
  --runtime-mode approval-required \
  --prompt-file audit.md
```

Manage and inspect delivery:

```sh
t3chief schedule list
t3chief schedule show nightly-audit
t3chief schedule pause nightly-audit
t3chief schedule resume nightly-audit
t3chief schedule run nightly-audit --request-id manual-2030-01-01
t3chief schedule occurrences --schedule nightly-audit
t3chief schedule remove nightly-audit
```

Prompts are snapshotted when a schedule is saved and redacted from output by default; pass the
global `--include-prompt` flag only when the local caller needs the body. Each schedule permits one
unresolved occurrence. The default is `latest` misfire handling and `defer` when an existing thread
is busy, so a restart does not flood T3 with stale or overlapping turns.

## Host jobs

```sh
t3chief jobs
t3chief jobs --include-commands
t3chief job run systemd:user:t3-nightly-update.timer
t3chief job disable systemd:user:some-user-job.timer
```

Cron command text and command-derived labels are redacted by default in both human and JSON output.
Use `--include-commands` only for an explicit local inspection. The inventory tags
`t3chief-scheduler.timer` as `scheduled-turn`, `spend-limit`, and
`maintenance-retry`; it tags the T3 nightly updater as `nightly-update`. User systemd timers can be
enabled, disabled, or run. System timers and `/etc/cron*` are read-only. User crontab edits use a
content hash and backup, and fail rather than overwriting concurrent changes.

The host wake calls one composite command:

```sh
t3chief tick --apply
```

It reconciles scheduled turns, rate-limit signals, and pending maintenance resumes independently,
so one failed component does not stop the other two from being attempted. Inspect their ledgers
with `rate-limits status` and `maintenance status`.

## Guarantees and limits

- Live validation occurs when a schedule is saved or resumed and again before dispatch.
- Delivery intent is recorded before network I/O. Recovery checks the message postcondition before
  replaying the same command ID. Removing a schedule cancels unresolved delivery atomically.
- Unknown providers, models, options, unavailable catalogs, and ambiguous thread references fail
  closed. There is no silent provider fallback.
- One-minute scheduling is local and single-host, backed by SQLite. It is not a high-availability
  scheduler.
- Provider headroom never fabricates a number. A reading is either provider-reported, labelled as
  an estimate, or reported as unknown. Probes are cached, rate-limited, and serialized across
  processes, and a probe itself spends about one token against the window it measures.
- Rate-limit recovery recognizes only the exact provider text and only if t3-chief observed it
  before its due time. It never revives an old failure found after reset.
- Maintenance recovery uses T3's HTTP and WebSocket contracts only. It never reads or writes T3's
  SQLite database.
- V1 has no native parent-child lineage. The skill supplies manager behavior; a later adapter can
  map this domain onto Orchestrator V2 lineage and completion delivery.
- `settle-ready` checks T3 execution and interaction state. A manager still owns acceptance of the
  worker's evidence before applying the settlement plan.

See [architecture](docs/architecture.md), [command reference](docs/commands.md),
[operations](docs/operations.md), and [research](docs/research.md).

## Development

```sh
bun run check
bun run build
```

The test suite uses public ports and in-memory SQLite. It covers transport, fleet classification,
bounded reads, provider validation, deterministic recovery, scheduling, host inventory, safe host
installation, configuration, provider limits, and CLI output. No test reads your real
configuration, credentials, or home directory.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE).
