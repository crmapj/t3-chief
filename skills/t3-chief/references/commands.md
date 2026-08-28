# Commands

All commands accept `--json`, `--quiet`, and `--environment NAME` globally.

```text
t3chief doctor
t3chief providers
t3chief limits [--provider codex|claude|grok] [--claude-budget TOKENS] [--window-minutes MINUTES]
  [--no-probe]
t3chief limits configure-claude [--profile NAME --command ABSOLUTE_PATH [ARG...]] [--remove NAME]
t3chief limits statusline-sink [--profile NAME] [--exec COMMAND [ARG...]]
t3chief project list
t3chief project create --title TITLE --workspace ABSOLUTE_PATH [--create-workspace]
t3chief project icon --project REF (--path IMAGE_FILE | --clear)
  [--provider INSTANCE --model SLUG] [--effort VALUE] [--option ID=VALUE]
t3chief status
t3chief brief THREAD --turns COUNT
t3chief settle-ready [--apply]

t3chief thread send THREAD [--reply-to SENDER_THREAD] (--prompt TEXT | --prompt-file PATH | stdin)
t3chief thread start --project ID --title TITLE --provider INSTANCE --model SLUG
  [--effort VALUE] [--option ID=VALUE]
  [--runtime-mode MODE] [--interaction-mode default|plan]
  [--worktree --base-branch BRANCH --start-from-origin]
  [--reply-to SENDER_THREAD]
  (--prompt TEXT | --prompt-file PATH | stdin)
t3chief thread interrupt THREAD
t3chief thread settle THREAD
t3chief thread unsettle THREAD

t3chief schedule validate KEY DEFINITION_FLAGS
t3chief schedule add KEY DEFINITION_FLAGS
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

t3chief jobs
t3chief job enable REF
t3chief job disable REF
t3chief job run REF [--request-id KEY]
t3chief host jobs
t3chief host install --backend systemd-user|cron --executable ABSOLUTE_PATH
t3chief host uninstall --backend systemd-user|cron

t3chief environment list
t3chief environment add NAME --url URL
  (--pairing-stdin | --token-stdin | --token-file PATH) [--default]
t3chief environment default NAME
t3chief environment local-refresh NAME --t3-cli ABSOLUTE_PATH --base-dir ABSOLUTE_PATH
  [--before-days DAYS]
t3chief environment refresh NAME
t3chief environment remove NAME
```

Schedule definition flags:

```text
--at RFC3339
  | --cron 'FIVE FIELD CRON' --timezone IANA_ZONE [--until RFC3339]
--thread THREAD_ID
  | --project PROJECT_ID --new-thread TITLE --provider INSTANCE --model SLUG
--effort VALUE
--option ID=VALUE                  repeatable
--runtime-mode MODE
--interaction-mode default|plan
--worktree --base-branch BRANCH --start-from-origin
--prompt TEXT | --prompt-file PATH | stdin
--misfire latest|skip
--when-busy defer|skip
--disabled
--expected-revision NUMBER
```

Use the refs returned by `jobs --json`. Common forms are `t3:SCHEDULE_KEY` and
`systemd:user:UNIT.timer`.
