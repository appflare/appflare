---
"@appflare/cli": minor
---

The installer sends anonymous usage data: one event when a command ends, with the command, its outcome, duration, the step it reached and an error category, the installer's version, the operating system, CPU architecture, Node.js major version, and whether it ran in CI or under a coding agent. Nothing is sent before a command ends, and it never sends the account, the Worker name, paths, user names or error messages. It prints a notice when a command starts. `--no-telemetry` on any command, or `APPFLARE_TELEMETRY=off` or `DO_NOT_TRACK=1` in the environment, turns it off; `create-appflare` then deploys the manager with `APPFLARE_TELEMETRY=off`, which keeps the manager's usage data off too. Otherwise the manager is deployed with the run's random install id (`APPFLARE_INSTALL_ID`), so its own usage data continues it.
