---
"@appflare/manager": patch
---

Tighten the "Clean up the deploy copy" card on the home page: two numbered steps, each one line with its own button ("Open Builds" now lands on the Builds section of the Worker's settings, "Find on GitHub" searches for the copy), a one-sentence warning, and a small line linking to the API tokens page for the token Workers Builds may have created. The Deploy to Cloudflare form shows every variable as an editable field, so the manager now tolerates edits: any `APPFLARE_INSTALL_SOURCE` starting with "deploy", in any case, counts as a button install, and `/api/health` and the version in the footer report the version built into the code rather than the `APPFLARE_VERSION` variable.
