---
"@appflare/pack": minor
---

The packer sets a catalog entry's build-time constants (`install.buildEnv`) in the environment of every build command and of wrangler's bundling; the artifact's catalog manifest records them, so a later pack of the same pin builds with the same values.

A build that succeeds without creating, changing or removing any file in the checkout is refused with its output, since it built nothing: a command that prints its usage and exits 0 would otherwise pass. The commands of a list are judged together, so a type check may sit beside the build.

Static assets never include `.git`, `.wrangler` or `node_modules` directories, at any depth and whatever `.assetsignore` says, so an assets directory of `.` no longer publishes the repository's history or its installed packages.

Installs pick the package manager version a checkout needs: pnpm 9 (pinned, through npx) for a `lockfileVersion` 6 lockfile, which pnpm 10 refuses; npm 11 when `.nvmrc` or `engines.node` asks for Node.js 24 or later; and npm 11 when Node 22's npm refuses a `lockfileVersion` 3 lockfile with ERESOLVE, as it already did when npm called one out of sync. An install directory with `devDependencies: false` installs without them (pnpm `--prod`, npm `--omit=dev`, classic yarn and bun `--production`; yarn 2 and later refuse it).

R2 lifecycle rules and Vectorize metadata indexes from the catalog manifest are recorded on their bindings, and `resources.r2` naming a binding the wrangler config does not have is refused.
