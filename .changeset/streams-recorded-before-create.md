---
"@appflare/manager": patch
---

Streaming apps now get the same protection as other resources: an install or update records the name of a Pipelines stream, its sink, its pipeline and the sink's own R2 bucket before creating each one. If Cloudflare made one but Appflare could not record its id, the failed job records that id (or releases the name if nothing was made). The next update then finishes the stream, and an uninstall deletes it, where before the next attempt refused the name as one Appflare had no record of. A name recorded without its id, which only a job stopped from outside can leave, never lets Appflare delete, empty or reuse anything of that name. The next attempt makes it when nothing has that name and otherwise stops, saying an earlier, stopped job may have started making it. An uninstall makes no call for it and logs a warning naming it.
