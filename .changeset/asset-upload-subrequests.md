---
"@appflare/manager": patch
---

Installing or updating an app with many static asset files no longer fails with
"Too many subrequests". The asset upload now reads neighbouring files from the
release artifact with a single range request, follows the release download's
redirect once per step instead of once per file, and splits an upload group
that would not fit one step into several uploads. If the free plan's
subrequest limit is reached anyway, the job stops at once with an explanation
instead of retrying into the same limit.
