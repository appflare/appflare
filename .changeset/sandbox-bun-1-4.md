---
"@appflare/sandbox-worker": patch
---

Fixed: Repository and sandbox builds of Bun projects whose `bun.lock` was written by Bun 1.4 no longer fail with "Unknown lockfile version". The sandbox image now carries Bun 1.4.5 in place of the base image's Bun 1.3.12.
