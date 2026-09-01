---
name: t3-chief
description: Manage and supervise T3 Code fleets with the standalone t3chief CLI. Use when the user asks to inspect active or unsettled T3 threads, get bounded recent context, delegate or steer agent work, choose a live provider/model/effort, settle completed threads, schedule a future turn, recover session limits or planned maintenance, or inspect and manage systemd and cron jobs.
---

# T3 Chief

Use `t3chief` as the deterministic control plane and remain the reasoning manager. T3 owns the
threads and transcripts; the CLI supplies cheap fleet reads, bounded context, typed mutations,
durable schedules, and recovery.

## Start every management pass

Run these first:

```sh
t3chief --json doctor
t3chief --json status
```

If `doctor` reports an unreachable T3 environment, report the partial state. Do not infer that its
threads disappeared.

Use `t3chief --json providers` before choosing a provider, model, effort, or provider option. Treat
the returned instance IDs and model slugs as live routing truth. Never substitute a driver name for
an instance ID and never silently fall back.

## Check provider headroom

Before choosing a route for new or rescheduled work, read quota headroom:

```sh
t3chief --json limits
t3chief --json limits --no-probe
```

Each row reports a `source`, which says how much its numbers are worth. Rows with a `profile` are
separately metered accounts of the same provider; route to the one with headroom.

Provider-reported fact, trust it:

1. `probe` is a live read from the provider: Codex's app server, xAI's billing extension, or
   Anthropic's unified rate-limit response headers.
2. `oauth-usage` is Anthropic's usage endpoint.
3. `statusline` is a capture from Claude Code's own statusline feed.
4. `exact-snapshot` is a provider record found on disk, such as the `rate_limits` block Codex
   writes into a rollout. Accurate for what it covers, but see the bucket trap below.

Weaker, and labelled as such:

5. `signal` is derived from an observed session-limit message. It is correct about being limited
   and silent about headroom.
6. `estimate` is summed from local transcripts. It is indicative, not exact: it has no quota
   denominator, so `usedPercent` stays null until `--claude-budget TOKENS` supplies one, and
   `usage.totalTokens` is a floor whenever a note says a transcript was truncated.
7. `unknown` means no readable source. Unknown headroom, not zero headroom.

Never treat `estimate` or `unknown` as a reason to declare a provider exhausted or free. Say which
source you used when you justify a route.

What each provider reports:

- **Codex** returns every metered bucket, one row per bucket (for example, `example-weekly` and
  `example-burst`), each with its own windows.
- **Claude** returns one row per configured profile.
- **Grok** returns tier and the weekly window. A pure subscription seat publishes no headroom
  metric, so its `usedPercent` is null by design. That is honesty, not a failure.

Five things that will mislead you if you forget them:

- **A Codex row is per bucket, not per account.** An `exact-snapshot` row covers only the bucket
  the last turn happened to use, so it can read 0% while another bucket on the same account is a
  third spent. Only a `probe` row set covers everything. When a Codex row is `exact-snapshot`,
  treat it as one bucket's story and say which bucket it was.
- **A null `usedPercent` is not zero usage.** Grok publishes no denominator for a subscription
  seat, and a Claude `estimate` has none either. Route on the window reset and the tier, and say
  the metric was unavailable.
- **Gate on `usedPercent`, never on a weekly `resetsAt`.** The weekly reset time is advisory.
  Measured replenishment has run on roughly 72-hour cycles while the reported reset sat a full week
  out, and the counter can jump mid-cycle. Use thresholds on utilization, not predicted reset
  times.
- **One probe costs quota.** The Codex and Grok probes are free local reads. The Claude probe
  spends about one token against the same 5h window it reports, and any Claude work you delegate
  draws from the same buckets. Every reading is cached, so do not loop `limits`. Use `--no-probe`
  when a cached or local reading is good enough.
- **A row can be missing on purpose.** A configured profile that could not be read appears as
  `unknown` with the reason. That is not zero usage.

`limits` never prints a credential and never spends provider credits beyond the one-token Claude
probe.

## Anchor in the roadmap

Before starting new work, read the scoped repository instructions and its authoritative roadmap or
issue source. Keep the manager thread focused on priorities, dependencies, decisions, acceptance
contracts, and unresolved risks. Do not copy whole issue collections into the conversation.

If a roadmap source is unavailable, continue supervising work already in flight and mark the status
partial. Do not invent or delegate new roadmap work until the source is fresh.

## Spend context in layers

`status` loads no message bodies. Classify the entire fleet from that result first.

Open only threads that need a decision: blocked on approval or input, failed, newly completed,
stale, or named by the user. Start with:

```sh
t3chief --json brief THREAD_ID --turns 10
```

Increase to `--turns 50` only when the decision needs it. The unit is a user-anchored turn, so one
turn may include related agent and subagent messages. The CLI also caps each message and the total
projection. Do not fetch or copy a full transcript into a manager thread.

## Manage the fleet

Use the following order:

1. Report blocked work and failures first.
2. Review completed work against its stated acceptance evidence.
3. Send one concrete correction or next step where needed.
4. Start new workers with a self-contained brief, exact scope, acceptance checks, and the live
   route selected by the user or current policy.
5. Settle only after the outcome has been consumed and no approval, input, run, queue, background
   work, or actionable plan remains.

Prefer exact thread and project IDs. A title is a display label and may be ambiguous.

Dry-run conservative bulk settlement first:

```sh
t3chief --json settle-ready
t3chief --json settle-ready --apply
```

The first command finds only execution-safe candidates. You still own evidence acceptance before
applying the plan. Keep interrupt, settle, and archive as separate decisions.

## Delegate or follow up

Create a new worker with a prompt file or stdin. Include the goal, why it matters, in-scope and
out-of-scope work, acceptance criteria, constraints, and required evidence. Do not pass the chief's
conversation as worker context.

```sh
t3chief --json thread start \
  --project PROJECT_ID \
  --title 'Concrete task title' \
  --provider PROVIDER_INSTANCE \
  --model MODEL_SLUG \
  --effort EFFORT \
  --runtime-mode RUNTIME_MODE \
  --prompt-file /tmp/worker-brief.md
```

Every worker needs a project. List them before choosing one, and register a workspace when the
right project does not exist yet, rather than parking work in an unrelated project:

```sh
t3chief --json project list
t3chief --json project create --title 'Concrete project title' --workspace /absolute/workspace/path
```

`project create` returns the new project ID in the envelope; pass that ID straight to
`thread start --project`. It fails closed if the workspace already belongs to another project, so
check `project list` first when you are unsure. Add `--create-workspace` only when T3 should create
the directory, and `--provider`/`--model` only when the project should have a default route.

`project icon --project REF --path FILE` sets the icon T3 shows for that project in the sidebar,
which makes a pinned manager thread recognisable at a glance. The path may be absolute or relative
to the workspace root, and must be an avif, gif, ico, jpg, jpeg, png, svg, or webp file. Use
`--clear` to remove it.

`project rename --project REF` changes a project's title, its workspace root, or both in one
command. Use it after renaming a directory on disk: the project keeps its id and every existing
thread, which a delete-and-recreate would lose. `--root` must point at a directory that exists and
is not already claimed by another project.

Use `--worktree --base-branch BRANCH` when T3 should prepare isolation. Follow up through
`t3chief thread send THREAD_ID --prompt-file FILE`; this keeps the thread's current model and modes.

### Reply-back channel

If the delegator wants a response, it must say so in the message: pass its own thread ID with
`--reply-to THREAD_ID` on `thread start` or `thread send`. The CLI appends a deterministic
`REPLY-TO THREAD:` footer instructing the worker to report outcome, evidence, and open questions
back with `t3chief thread send`. A persistent chief passes its own T3 thread ID; a session that is
not a T3 thread has no reply address, so omit the flag and poll with `status` and `brief` instead.
Never hand-write the footer; the flag keeps the format uniform.

When a prompt you receive carries a `REPLY-TO THREAD:` footer, send one concise reply to that
thread when you finish, become blocked, or need a decision. Do not settle or interrupt the
delegator's thread.

## Schedule work

Validate a definition before saving it when the route or target is new. Existing-thread schedules
use that thread's current route. New-thread schedules require an exact provider, model, and options.

```sh
t3chief schedule validate KEY ...
t3chief schedule add KEY ...
t3chief schedule list
t3chief schedule occurrences --schedule KEY
```

Use an RFC3339 `--at` instant or a five-field `--cron` with an IANA `--timezone`. The default
policies are `--misfire latest` and `--when-busy defer`; keep them unless the user explicitly wants
missed work dropped. A prompt file is read and snapshotted when saved.

For a bounded recurring burst ("every 20 minutes for the next 2 hours"), add `--until RFC3339` to a
cron schedule instead of stacking one-shot `--at` entries. The last firing at or before the bound
still runs; after the bound passes and any in-flight run resolves, the tick auto-disables the
schedule so it stops surfacing as active work. Compute the bound from the current time yourself and
state it absolutely. `--until` is cron-only and rejected with `--at`.

```sh
t3chief schedule add checkin-burst \
  --cron '*/20 * * * *' --timezone Europe/Amsterdam \
  --until 2030-01-01T14:00:00+02:00 \
  --thread YOUR_THREAD_ID \
  --prompt 'Self check-in: scan the fleet, report blocked work, close finished loops.'
```

Use a stable `--request-id` for manual retries. Do not run `schedule tick --apply` concurrently;
the installed host timer owns routine reconciliation.

Stored prompts are redacted from command output by default. Use the global `--include-prompt` flag
only when the local task genuinely needs to inspect a schedule body.

A persistent chief can wake itself by scheduling an existing-thread turn into its own T3 thread.
The scheduled prompt should explicitly ask for the `t3-chief` skill, a roadmap refresh, the layered
fleet scan, evidence review, safe follow-ups, settlement, and a short status report. For a
time-boxed supervision window, combine this with `--until` as shown above.

## Manage host jobs

Run `t3chief --json jobs` for the unified inventory. Cron commands and command-derived labels are
redacted by default; use `--include-commands` only for an explicit local inspection. Inspect each
job's `capabilities` before an action. T3 schedules and user systemd jobs may be enabled, disabled,
or run. System systemd and `/etc/cron*` jobs are read-only. User crontab changes are guarded and
backed up.

Install only one scheduler wake backend, preferably:

```sh
t3chief host install --backend systemd-user --executable "$HOME/.local/bin/t3chief"
```

That timer also owns exact session-limit recovery and planned-maintenance resume. Inspect these
without touching T3 state directly:

```sh
t3chief --json rate-limits status
t3chief --json maintenance status
```

Use `maintenance capture` immediately before a planned T3 stop and `maintenance stopped`
immediately after it stops. Normal manager turns should not create or close maintenance windows.

Read [references/commands.md](references/commands.md) for exact command forms. Read
[references/operating-policy.md](references/operating-policy.md) before autonomous settlement,
scheduling, recovery, or host-job mutation.

## Hard boundaries

- Do not use a separate orchestration platform, raw harness processes, tmux polling, or direct T3
  SQLite access.
- Do not mirror transcripts or load every thread body.
- Do not widen runtime authority beyond the user's request.
- Do not guess provider or model identifiers.
- Do not mutate system jobs or bypass a missing capability with sudo.
- Do not mark a stopped turn successful without evidence.
