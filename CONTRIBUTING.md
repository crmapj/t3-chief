# Contributing

Thanks for helping. This is a small, deliberately narrow CLI, so the bar is correctness and
determinism rather than breadth.

## Setup

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

`bun run check` is typecheck, lint, and tests. CI runs the same command plus `bun run build`, so a
green local check is a green pull request.

Formatting and linting are Biome. Run `bun run format` before opening a pull request rather than
hand-matching the style.

Exercising the CLI end to end needs a reachable T3 Code environment; the test suite does not. Every
test uses in-memory SQLite, fake ports, or temporary directories, so `bun test` never touches your
real configuration, credentials, or home directory.

## Tests

Cover every behavior change through a public seam. Practically:

- Put pure logic in `src/domain`, orchestration in `src/core`, and I/O in `src/adapters`, then test
  the domain and core with injected fakes.
- Never reach into private fields or rewrite an assertion to match new output. If output changed
  deliberately, change the expectation and say why in the commit message.
- Add a regression test with any bug fix.

## Pull requests

Keep them small and single-purpose. A good pull request states the behavior change, the reason, and
the evidence you ran. Interface changes to a command or its JSON envelope belong in
`docs/commands.md` and, when they change how an agent should operate, in `skills/t3-chief/`.

Two hard rules, because the tool's value depends on them:

- Never read or write T3's SQLite database or its transcripts. Use the documented HTTP and
  WebSocket contracts.
- Never log, print, or persist a credential, and never pass one as a command-line argument.

## Conduct

Be decent and assume good faith. Behavior that makes others unwelcome is not accepted.
