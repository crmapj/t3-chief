# Architecture

## Boundary

`t3chief` is a manager control plane above T3 Code. It uses T3's authenticated environment HTTP
and WebSocket APIs. It does not host providers, mirror transcripts, or replace T3 command receipts.

The CLI exposes four conceptual operations:

```ts
interface ChiefControlPlane {
  inspect(query: InspectQuery): Promise<Inspection>;
  plan(intent: ManagerIntent): Promise<ManagerPlan>;
  apply(plan: ManagerPlan): Promise<ManagerReceipt>;
  inventory(query?: JobQuery): Promise<HostJob[]>;
}
```

The command surface keeps common calls short, while adapters hide transport and host details.

## Scheduling

SQLite is the recurrence and recovery authority. A single user-level systemd timer wakes
`t3chief tick --apply` every 60 seconds. The composite tick reconciles scheduled turns, exact
provider session-limit signals, and planned-maintenance resumes. Cron is a fallback wake
mechanism, never a second recurrence engine.

Each schedule has a stable caller key and compare-and-swap revision. Each nominal UTC instant has
one deterministic occurrence ID. Command, message, and new-thread UUIDs derive from that occurrence
ID. The ledger records the outbound intent before dispatch. A crash retry sends the same IDs.

Routes validate twice against `server.getConfig`: on schedule creation or resume, then immediately
before dispatch. Validation includes enabled, installed, availability, status, authentication,
model, and option descriptors. Existing-thread schedules use the thread's current route.
New-thread schedules pin an exact provider instance, model slug, option values, runtime mode, and
interaction mode.

The default recurring policy is one unresolved occurrence per schedule, latest-only misfire
coalescing, and defer when an existing thread is busy. This prevents stale backlogs and overlapping
turns.

## Recovery reflexes

Rate-limit discovery starts from the body-free shell, then loads one user-anchored turn only for
idle, terminal, unsettled threads. The exact assistant message supplies the UTC reset clock. A
signal first seen after reset plus the two-minute grace is recorded as ignored and never revived.
Command and continuation-message IDs derive from the immutable provider message ID, so a crash can
verify or replay without duplicating the turn.

Before planned T3 maintenance, `maintenance capture` records active thread/turn IDs through the T3
API. `maintenance stopped` closes the short stop window after systemd has stopped T3. Once T3 is
healthy, delivery resumes only captured turns whose same latest turn is now `interrupted`. It also
detects a turn that began in the few seconds between capture and stop by its requested and
completed timestamps. Normally completed or superseded turns are never resumed.

## Host jobs

The unified inventory normalizes these sources:

- t3-chief schedules, fully manageable;
- user systemd timers, enable/disable/run;
- system systemd timers, read-only;
- user crontab, compare-and-swap mutation when the host supports it;
- `/etc/crontab` and `/etc/cron.d`, read-only.

Every item reports explicit capabilities. Unsupported mutations fail closed.

## T3 generations

The V1 adapter uses bounded shell/thread HTTP reads plus the authenticated WebSocket RPC for the
live provider catalog and mutations. WebSocket dispatch is required because it preserves T3's
bootstrap, managed-worktree, and settlement-session semantics; the V1 HTTP mutation route bypasses
those client-runtime steps. A later V2 adapter can map the same domain intent onto native V2
child/thread APIs. Capability negotiation selects an adapter; version strings do not.
