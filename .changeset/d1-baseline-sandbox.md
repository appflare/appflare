---
"@appflare/sandbox-worker": patch
---

Builds keep a catalog entry's D1 baseline and check its bytes in the stored zip, and the sandbox Worker says so in `info().features` (`d1-baseline`), so the manager can refuse to build such an entry on an earlier sandbox Worker that would drop it.
