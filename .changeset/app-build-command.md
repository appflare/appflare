---
"@appflare/schema": minor
"@appflare/pack": minor
---

Apps that need a build step before `wrangler deploy` can now be packed. The catalog manifest takes an optional `install.buildCommand`, for example `pnpm --filter @scope/web build`, for apps built with Vite, React Router, or OpenNext whose wrangler config has no `build.command`. The packer runs it once at the root of the checkout, after installing dependencies with install scripts disabled and before it reads the wrangler config and bundles the Worker, so `install.wranglerConfig` may name a config the build writes (such as the one the Cloudflare Vite plugin generates).

The command runs as a plain command without a shell, with the same scrubbed environment as the rest of the pack (no Cloudflare, signing, or CI credentials) and the checkout's `node_modules/.bin` first on its PATH. Pipes, redirects, quotes, variables, globs, command separators, and `NAME=value` assignments are refused when the manifest is validated, and the command may be at most 256 characters. A build gets 15 minutes; when it fails or runs out of time, the pack fails with its exit code and the last 40 lines of its output, and every process it started is stopped. Once the build ends, the packer waits at most 5 seconds for its output to close, so a background process that escaped the build cannot keep the pack waiting. The command is recorded in the artifact with the rest of the catalog manifest.
