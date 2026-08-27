# Operating policy

## Context budget

1. Read the environment shell with `status`.
2. Rank blocked, failed, review-ready, running, queued, and idle threads.
3. Read 10 recent user-anchored turns for decision candidates only.
4. Expand to 50 only for an explicit forensic need.
5. Keep manager notes as findings and decisions, never copied transcript bodies.

## Delegation contract

A worker brief must state:

- goal and reason;
- included and excluded scope;
- exact acceptance criteria;
- repository and safety constraints;
- expected proof, such as tests, commit, PR, report path, or no-change evidence;
- exact live provider route and runtime authority.

One worker owns one bounded outcome. Do not start overlapping edits in the same checkout. Prefer a
T3-managed worktree for independent code changes.

## Status contract

Report in this order:

1. needs the user: approvals, questions, or policy decisions;
2. failed or stale work: cause, owner, and next action;
3. ready for review: claimed outcome and evidence;
4. working or queued: concise progress and expected next signal;
5. snoozed: wake time and reason;
6. newly delegated work: scope, route, and acceptance checks.

Name the authoritative roadmap snapshot and its observed time when starting new work. A stale or
unavailable roadmap makes the report partial but does not erase known thread state.

## Settlement

Automatic settlement requires all of these:

1. no running, starting, queued, or pending turn;
2. no pending approval or user input;
3. no actionable proposed plan or live background work;
4. the worker supplied the requested evidence;
5. the manager consumed the result and accepted or explicitly abandoned it;
6. T3 accepts the settle command.

A completed process is review-ready, not automatically successful. A failed, interrupted, or
unclear outcome remains unsettled until triaged.

## Scheduling and recovery

- Save schedules with stable keys and use `--expected-revision` for updates made from stale views.
- Validate exact new-thread routes live. Existing threads retain their current route.
- Keep `latest` misfire and `defer` busy policies for ordinary recurring management work.
- Use `skip` only where late execution has no value.
- One unresolved occurrence blocks later occurrences for the same schedule.
- Never edit the ledger directly. Inspect occurrences and let the tick reconcile them.
- Reuse a manual `--request-id` when retrying the same intent; choose a new ID only for a new run.
- The installed composite tick owns routine rate-limit and maintenance recovery. Inspect their
  status before manual replay; never manufacture a provider limit signal or maintenance window.

## Host jobs

- Prefer the one user systemd timer over cron.
- Do not install both wake backends.
- Read capabilities before mutation.
- User timer and user crontab changes are in scope only when the user asks to manage them.
- System timers and system cron are inventory-only. Never add sudo or PolicyKit as a workaround.
- Preserve and report source warnings. Missing user crontab access must not hide other jobs.
