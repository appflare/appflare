---
"@appflare/sandbox-worker": patch
---

Builds keep a catalog entry's D1 seed statements and seed-only secrets and vars, and the sandbox Worker says so in `info().features` (`d1-seed`), so the manager can refuse to build such an entry on an earlier sandbox Worker that would drop them.
