---
"@appflare/manager": patch
---

Builds made for review (from a repository or from source) that nobody installs, updates from or throws away are now thrown away after 7 days, record and files together, so the sandbox Worker's bucket no longer keeps them forever. A build an app or one of its snapshots uses, one still building, and those of an app with a job running are never touched. A thrown-away build is recorded as gone only once its files are deleted; a failed deletion is tried again later. Throwing a build away by hand no longer deletes the files of a build an update is deploying, of a rebuild in progress, or of an older snapshot a rollback can return to.
