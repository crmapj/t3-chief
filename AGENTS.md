# t3-chief

Standalone manager CLI for T3 Code fleets. It must not depend on an external orchestration
platform or read T3's SQLite files directly.

## Invariants

- T3 owns projects, threads, turns, transcripts, providers, and command receipts.
- t3-chief owns managerial schedules, occurrence intents, verification evidence, and host-job
  inventory.
- Validate provider instance, model, and options against the live T3 catalog when a schedule is
  saved and again before dispatch. Never fall back silently.
- Persist deterministic occurrence, command, message, and new-thread IDs before network I/O.
- Use stable IDs for mutations. Titles are display labels only.
- System systemd and `/etc/cron*` jobs are read-only. Mutate user jobs only through explicit CLI
  commands and never invoke sudo or PolicyKit.
- Keep one 60-second host wake timer. Do not create one OS job per T3 schedule.
- Tests must cover every behavior change through public seams.

## Commands

```sh
bun run check
bun run build
```
