---
"@appflare/manager": patch
---

The release is built as a single server module so Appflare can update itself.
A self-update fetches every module of the new version for one upload, and the
code-split build had too many modules to fit the free plan's subrequest limit.
Self-updates, app updates, and installs now check the module count in their
own step ("check release shape", "plan update", "preflight checks") before
changing anything, and say how many modules fit.
