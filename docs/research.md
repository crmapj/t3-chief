# Design research

The pre-release research compared T3 V1, the open Orchestrator V2 pull request, and existing
agent supervisors. The decision was to copy their proven control-loop ideas while keeping T3 as the
only runtime.

- [Firstmate](https://github.com/kunchenguid/firstmate) best matches the desired chief behavior:
  one liaison, prompt-only worker briefs, compact status, durable decisions, and event-driven wakes.
- [Agent Deck Conductor](https://github.com/asheshgoplani/agent-deck/blob/01c011b5189ecb0878e8637af076021935b74dab/docs/conductor/README.md)
  demonstrates a persistent manager, an outbox, an audit log, and a heartbeat.
- [OpenAI Symphony](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md)
  supplies the clean reconcile, retry, bounded-concurrency, and proof-of-work loop.
- Gas Town, Herdr, Claude Squad, and similar tools validate demand, but they own terminal sessions,
  worktrees, or harness processes that T3 already owns.

[T3 Orchestrator V2 PR #2829](https://github.com/pingdotgg/t3code/pull/2829) contains useful future
concepts: prompt-only children, lineage, durable completion wakes, idempotent request IDs,
provider-aware creation, and bounded history. At the snapshot date it remained open, conflicting,
and lacked the V1 state-migration stage required for deployment. Its MCP surface is also scoped to
one calling project, while a fleet chief needs environment-level authority.

The adapter boundary therefore targets authenticated environment HTTP and WebSocket APIs today.
A future V2 adapter can adopt native lineage and completion delivery without changing the schedule
ledger or CLI intent model.

## Provider quota surfaces

Provider schemas were verified while building `t3chief limits`, then normalized into synthetic
fixtures; no account telemetry is retained. None of these interfaces is publicly documented, so
all parsing is defensive.

### Codex

`codex app-server` over stdio JSON-RPC, calling `account/rateLimits/read`, is the chosen source. It
costs nothing, writes no rollout, returns every metered bucket in `rateLimitsByLimitId`, and lets
the CLI own OAuth refresh. `codex app-server generate-json-schema` documents the shape. stdin must
stay open until the reply arrives, because EOF shuts the server down.

Rejected alternatives:

- `codex app-server daemon start` shares state with a running fleet.
- A probe turn through `codex exec` costs around 9-10k input tokens and refreshes only the bucket
  that turn used.
- `GET https://chatgpt.com/backend-api/wham/usage` works and is a real fallback candidate. It takes
  `Authorization: Bearer <tokens.access_token>` read from `~/.codex/auth.json`, and returns
  `rate_limit.primary_window` / `secondary_window` with `used_percent`, `limit_window_seconds`,
  `reset_after_seconds`, and `reset_at`, plus `plan_type`, `credits`, `spend_control`, and
  `additional_rate_limits[]`. It was left unimplemented because the bearer is a roughly ten-day JWT
  the CLI owns refreshing: the fallback would be least reliable in exactly the situation that
  triggers it, a missing or broken `codex` CLI. If it is ever added it needs its own parser, since
  the field names differ from the rollout format (`primary_window` vs `primary`,
  `limit_window_seconds` vs `window_minutes`, `reset_at` vs `resets_at`). Never write or refresh
  `auth.json`.
- `GET /backend-api/codex/usage` is bot-gated and answers with Cloudflare HTML. Do not use it.
- `POST /wham/rate-limit-reset-credits/consume` mutates account state. Never call it.

The rollout parse survives only as a labelled fallback: it records a single bucket, whichever the
last turn used, and can be hours stale.

### Claude

Anthropic's `GET /api/oauth/usage` is free but needs a token holding `user:profile`; inference-scoped
setup tokens answer HTTP 403. The unified rate-limit response headers of a one-token
`POST /v1/messages` carry the same figures and are the working fallback. Requests must send a
`User-Agent`, without which the usage endpoint throttles hard and stays throttled.

### Grok

T3's Grok driver is xAI's official CLI on a subscription seat, so key-based `api.x.ai` surfaces do
not apply. `grok agent stdio` exposes the `_x.ai/billing` and `_x.ai/auth/check_subscription` ACP
extensions, which report tier, the usage window, gate state, and on-demand balances at no cost.
`session/new` is avoided because it creates session directories. No remaining-headroom metric is
published for a pure subscription seat, and none is invented.
