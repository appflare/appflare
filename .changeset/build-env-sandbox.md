---
"@appflare/sandbox-worker": patch
---

The sandbox Worker reports the `build-env` feature: its packer sets build-time constants, installs without devDependencies, and records Vectorize metadata indexes and R2 lifecycle rules. The image keeps pnpm 9 in npx's cache for lockfiles pnpm 10 refuses.
