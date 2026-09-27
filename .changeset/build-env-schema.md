---
"@appflare/schema": minor
---

A catalog manifest can set public build-time constants in `install.buildEnv`, for apps that compile settings into their files at build time (Vite's `import.meta.env`, SvelteKit's `$env/static/public`). Names are upper-case. Names that look like credentials are refused, since the values are published and compiled into downloadable files, and so are names that would change how the build runs: those read by wrangler and what it runs (esbuild, Miniflare, workerd), Node.js and the package managers, git and CI, shells, the dynamic linker, TLS and HTTP clients and their proxies, configuration directories, other language toolchains, and monorepo build tools. The list catches known cases; catalog review reads every constant as well. Cloudflare's own `Default Multipart Abort Rule` id is refused for a declared R2 lifecycle rule, since the manager keeps that rule.

An install directory can set `devDependencies: false` to install its production dependencies alone, for a project whose devDependencies cannot be installed and are not needed to bundle the Worker.

`resources.vectorize[binding].metadataIndexes` lists the metadata properties an app's queries filter on, and `resources.r2[binding].lifecycle` lists lifecycle rules (delete, move to Infrequent Access, abort unfinished multipart uploads, each after some days) for the bucket of an R2 binding. Artifact bindings carry both, and an artifact with either is format 6, so a manager that would drop them refuses it. The sandbox feature `build-env` says a sandbox Worker's packer knows all four settings.
