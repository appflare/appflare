---
"@appflare/manager": minor
"@appflare/cli": patch
---

Installs, updates, uninstalls, and Appflare's own updates no longer run out of
the free plan's 50 subrequests on larger apps. Appflare now binds to itself
(a `SELF` service binding) and runs each heavy piece of a job in a separate
call with its own allowance: every asset upload part, the upload of the
Worker's code, each D1 migration, and each page of objects deleted from an R2
bucket. Buckets with many objects are emptied up to 720 objects per uninstall
run; retry the uninstall to continue.

New installs from `create-appflare` get the binding at once. An existing
Appflare gains it with its next self-update after this one; until then it
works as before.
