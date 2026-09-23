---
"@appflare/sandbox-worker": minor
---

First release of the sandbox Worker, `appflare-sandbox`: an optional Worker for accounts on Workers Paid that builds `sandbox` tier apps from their pinned commit inside a Cloudflare Sandbox container (`docker.io/appflare/sandbox:<version>`, `standard-1` by default, `standard-2` when an entry asks for it). A build clones the pinned commit, installs dependencies with install scripts disabled, packs an unsigned artifact with `@appflare/pack` (which runs the entry's `install.buildCommand` first), checks every file of the stored zip against its manifest, and keeps it with its log in the R2 bucket `appflare-builds`, served with HTTP Range requests to callers over a service binding only. The container holds no Cloudflare credentials; its outbound traffic, HTTPS included, is not filtered. It is deleted after every build. Support in the manager for sandbox tier apps comes in a following release.
