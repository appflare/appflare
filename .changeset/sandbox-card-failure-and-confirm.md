---
"@appflare/manager": patch
---

The Sandbox builds card in Settings > Account and capabilities now names the last enable, update or disable job that failed, with its first error line and a link to its job log, until a newer one succeeds. Before, a first enable that stopped part way left the card showing only "Off". "Enable sandbox builds" and "Update sandbox" now ask for confirmation first: the dialog says what is created or rolled out (the sandbox Worker, its two container applications and the `appflare-builds` bucket), that Workers Paid usage applies while builds run and nothing runs between them, and what a typical build costs.
