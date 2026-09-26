---
"@appflare/sandbox-worker": minor
---

A self-deploying entry's build may be a list of commands: the sandbox Worker runs them in order before the installer, stopping at the first that fails, within the build's time limit, and with pre and post hooks of package scripts off for pnpm and npm, as the packer runs a catalog entry's build. Builds of entries whose `install.buildCommand` is a list log it on one line, and a repository build from a catalog app's baseline shows such a list the same way.
