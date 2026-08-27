# Operations

## State and security

Defaults follow the XDG base directory specification:

```text
~/.config/t3chief/config.json
~/.config/t3chief/credentials/ENVIRONMENT.token
~/.local/state/t3chief/t3chief.sqlite
~/.local/state/t3chief/backups/
```

Configuration and credential directories are owner-only; credential files use mode `0600`.
Pairing exchanges the one-time credential over HTTP and stores only the scoped bearer session.
Neither prompts nor credentials should be passed as shell arguments in unattended workflows.

Local refresh is optional and typed, not a shell command string. It executes one absolute T3 CLI
path with one absolute base directory, captures a five-minute pairing credential in memory,
requests only `orchestration:read orchestration:operate`, and atomically replaces the owner-only
session file. The default lead time is seven days. Remote environments must be re-paired manually.

## Scheduler wake job

The recommended backend installs:

```text
~/.config/systemd/user/t3chief-scheduler.service
~/.config/systemd/user/t3chief-scheduler.timer
```

The timer is persistent and wakes each minute through `t3chief tick --apply`. The oneshot service has a 55-second timeout,
owner-only umask, no-new-privileges, filesystem protection, kernel and control-group protection,
and restricted address families. Reinstalling backs up prior owned unit files before an atomic
replace.

The cron fallback writes one marked block to the user crontab. It preserves unrelated lines and
backs up the old crontab. Never install both wake backends.

## Recovery

An occurrence is reserved with deterministic occurrence, command, message, and optional new-thread
IDs before T3 is called. On a crash or uncertain response, the next tick first reads a bounded
thread window for the message ID. If present, it records verification without another dispatch. If
the postcondition is absent, it replays the same command ID and lets T3's command receipts dedupe
the effect.

`planned`, `dispatching`, `accepted`, `deferred`, and `blocked` occurrences remain recoverable.
`verified`, `skipped`, and `failed` occurrences are terminal. Removing a schedule atomically marks
its unresolved occurrences skipped, prevents future materialization, and retains occurrence and
audit rows.

## Runbook

```sh
t3chief --json doctor
t3chief --json schedule tick
t3chief --json schedule occurrences
systemctl --user status t3chief-scheduler.timer t3chief-scheduler.service
journalctl --user -u t3chief-scheduler.service --since today
```

If provider validation blocks a delivery, fix or authenticate the exact provider instance, then
run `t3chief schedule resume KEY` or allow the next tick to retry the blocked occurrence. Do not
change a route silently.

Pausing a schedule also holds any deferred, blocked, dispatching, or accepted occurrence. Resuming
revalidates the target and live route, then lets the next tick reconcile the same occurrence IDs.

If user crontab access is unavailable, `jobs` and `doctor` report a warning while preserving
systemd and system-cron results. Prefer the systemd-user wake backend on such hosts.

## T3 nightly maintenance integration

The nightly updater must call these around its T3 service stop:

```sh
t3chief --environment home maintenance capture --quiet
systemctl --user stop t3-nightly.service
t3chief --environment home maintenance stopped --quiet
```

After health returns it may call `maintenance deliver`; the one-minute composite timer also retries
pending delivery. Capture and stop markers are idempotent during the same short maintenance
window. A stopped window must finish before another update begins.

Any earlier single-purpose resume timer is obsolete once the composite timer is installed. Disable
it after confirming that its legacy ledger has no pending work, and keep the unit file as rollback
evidence until a later cleanup.
