---
"@appflare/manager": patch
---

"Throw away" on a build's review now asks before it deletes the build, and shows why it could not in the same dialog. A build's live output on its job page sits in a box of its own that stays at the newest line, so a long build no longer pushes the log far down the page. Updates, rollbacks, uninstalls and version switches in progress show Appflare's moving mark. A catalog that cannot be loaded is now a warning, not a grey note. Success messages share one look, and the result of restoring a database is read out by screen readers when it arrives, as are a failed build, job, install or uninstall. An app with no resources yet, and a job with no log lines yet, show an empty state like the rest of the manager.
