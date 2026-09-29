# @appflare/sandbox-worker

## 0.1.9

### Patch Changes

- Updated dependencies [3544a99]
- Updated dependencies [06adf84]
- Updated dependencies [e88bd26]
- Updated dependencies [c016f30]
- Updated dependencies [815f073]
- Updated dependencies [815f073]
- Updated dependencies [49c9307]
- Updated dependencies [97ec662]
- Updated dependencies [60797b3]
- Updated dependencies [a6c5111]
- Updated dependencies [2736169]
- Updated dependencies [2736169]
- Updated dependencies [b45a840]
- Updated dependencies [ae48aff]
- Updated dependencies [eeb5b06]
- Updated dependencies [98384ea]
- Updated dependencies [7d6af32]
- Updated dependencies [6b9731c]
- Updated dependencies [580b7f4]
- Updated dependencies [3346e0e]
- Updated dependencies [886b5c7]
- Updated dependencies [8a6a95d]
- Updated dependencies [4c45fab]
- Updated dependencies [21e5cc3]
- Updated dependencies [a9f0b6d]
- Updated dependencies [e864f0a]
- Updated dependencies [32c389b]
- Updated dependencies [9d208b0]
- Updated dependencies [4e92e7d]
- Updated dependencies [dfad03f]
- Updated dependencies [60797b3]
- Updated dependencies [a8540ea]
- Updated dependencies [3fdeebc]
- Updated dependencies [3fdeebc]
- Updated dependencies [89059c8]
- Updated dependencies [12cd361]
- Updated dependencies [d026dbb]
- Updated dependencies [1438130]
- Updated dependencies [1438130]
- Updated dependencies [22a9d4e]
- Updated dependencies [3edcbc0]
- Updated dependencies [85de1c6]
- Updated dependencies [6cd65c4]
- Updated dependencies [7154030]
- Updated dependencies [388db3e]
- Updated dependencies [122cb3b]
- Updated dependencies [d3a73ff]
- Updated dependencies [4c1dd8a]
- Updated dependencies [bf8ebf4]
- Updated dependencies [c7e02de]
- Updated dependencies [dc4a311]
- Updated dependencies [dc4a311]
- Updated dependencies [9dd3645]
- Updated dependencies [391cc90]
- Updated dependencies [97ec662]
- Updated dependencies [6cd65c4]
- Updated dependencies [2fc5f32]
- Updated dependencies [2ff840a]
- Updated dependencies [c385480]
- Updated dependencies [b16d011]
- Updated dependencies [b16d011]
- Updated dependencies [a799aed]
- Updated dependencies [ad23fad]
- Updated dependencies [e737d12]
- Updated dependencies [580b7f4]
- Updated dependencies [115db3e]
- Updated dependencies [eb86c68]
- Updated dependencies [eb86c68]
- Updated dependencies [e4d0719]
- Updated dependencies [ac6d253]
- Updated dependencies [b26f1e3]
- Updated dependencies [307d8cb]
- Updated dependencies [97ec662]
- Updated dependencies [ad3715c]
- Updated dependencies [dfad03f]
- Updated dependencies [a297c5b]
- Updated dependencies [9dbe995]
  - @appflare/cf-api@0.1.0
  - @appflare/schema@0.4.0

## 0.1.8

- Builds take a catalog entry's build-time constants (`install.buildEnv`), install directories with `devDependencies: false`, Vectorize metadata indexes (`resources.vectorize[binding].metadataIndexes`) and R2 lifecycle rules (`resources.r2[binding].lifecycle`), and `info().features` lists `build-env`. The manager refuses to build an entry with any of them on a sandbox Worker that lacks it, since an older one would build without them, and asks for the sandbox Worker to be updated first.
- When a build cannot find a GitHub access token, the message sends you to Settings > Building apps > GitHub access, where the tokens now live.
- The image keeps pnpm 9 in npx's cache, so the packer runs it for a `lockfileVersion` 6 lockfile without fetching it first.
- The image carries the packer of this release: build-time constants set in the environment of every build command and of wrangler's bundling, and recorded in the artifact's catalog manifest; a build that succeeds without creating, changing or removing any file in the checkout refused with its output, the commands of a list judged together; `.git`, `.wrangler` and `node_modules` directories kept out of static assets at any depth, whatever `.assetsignore` says; pnpm 9 for a `lockfileVersion` 6 lockfile, which pnpm 10 refuses; npm 11 when `.nvmrc` or `engines.node` asks for Node.js 24 or later, and when Node 22's npm refuses a `lockfileVersion` 3 lockfile with ERESOLVE; installs without devDependencies (pnpm `--prod`, npm `--omit=dev`, classic yarn and bun `--production`; yarn 2 and later refuse it); R2 lifecycle rules and Vectorize metadata indexes recorded on their bindings, and `resources.r2` naming a binding the wrangler config does not have refused; and artifacts written as format 6 when they carry either, so managers that read only formats 1 to 5 refuse them.

## 0.1.7

- Builds keep a catalog entry's D1 baseline (`resources.d1[binding].baseline`) and check its bytes in the stored zip, and `info().features` lists `d1-baseline`. The manager refuses to build an entry with a baseline on a sandbox Worker that lacks it, since an older one would drop it and run the migrations on an empty database.
- The image's packer writes a catalog entry's inline wrangler config (`install.wranglerConfigInline`) before the install and the build, and `info().features` lists `wrangler-config-inline`. The manager refuses such an entry on a sandbox Worker that lacks it, since an older one would find no config to build from.
- Builds take static sites without Worker code (a wrangler config with `assets` and no `main`), entries whose `install.installDirs` is empty, and multi-line secrets (`secrets[].multiline`). For an empty `install.installDirs` the `install` step says that nothing is installed and the build runs with no dependencies installed, and a repository build lists its install directories as none. `info().features` lists `assets-only`, and the manager asks for the sandbox Worker to be updated instead of sending such an entry to one that lacks it.
- The image carries the packer of this release: a Worker of static assets only packed with no modules; `_redirects` and `_headers` at the root of the assets directory recorded in `assets.config`, as wrangler sends them (a symlinked one skipped, one over 512 KiB refused); D1 baselines checked before anything is built and written to `d1-baseline/<binding>/<path>`; Pipelines bindings recorded by name when the catalog manifest describes the stream under `resources.pipelines`, and refused when it does not; inline wrangler configs written as `.appflare.wrangler.jsonc`, refused where the repository has a config of its own; wrangler config sections the packer does not read (`containers` among them) refused with the config patch that drops them, and config patches that set such a section to `null`, leave out a placeholder storage id or add `ratelimits`; `placement` recorded as wrangler uploads it, so `{ "mode": "off" }` is no placement; a warning for a `license` that is not an SPDX expression; entries of up to 24 Workers; and artifacts written as format 5 when they carry an assets-only Worker, a D1 baseline or a multi-line secret, so managers that read only formats 1 to 4 refuse them.

## 0.1.6

- Builds keep a catalog entry's D1 seed statements (`resources.d1[binding].seed`) and its seed-only secrets and vars, and `info().features` lists `d1-seed`. The manager refuses to build an entry with seeds on a sandbox Worker that lacks it, since an older one would drop them, and asks for the sandbox Worker to be updated first.
- The image carries the packer of this release: D1 seed statements checked as the catalog manifest is read, before anything is built (one guarded INSERT per statement, one param per `?`, every param naming a declared var, secret or hash), carried in the artifact's signed catalog manifest and counted in the pack log; a seed-only secret that the wrangler config lists in `secrets.required`, or a seed-only var the config also declares, refused, and a seed-only secret no longer taking the place of a config var of its name; artifacts written as format 4 when an entry has seeds or keeps one of its Workers off workers.dev (`install.workers[].workersDev: false`), so managers that read only formats 1 to 3 refuse them; and the SQL checks of schema files and seeds taken from `@appflare/schema`.

## 0.1.5

- The image provides `bunx` beside `bun`, so repository builds whose scripts call it (such as `bunx vite build`) work in the sandbox.
- A build of an entry that lists `install.installDirs` skips the root install and lets the image's packer install those directories, so a template repository with no root `package.json` or lockfile builds. A failed install there is reported as the `install` step, and a repository build of such a catalog app names the directories in its log and detection. `info().features` lists `install-dirs`, and the manager refuses to send such an entry to a sandbox Worker that lacks it.
- The image's packer applies a catalog entry's config patch (`install.configPatch`), and `info().features` lists `config-patch`; the manager refuses such a build on a sandbox Worker that lacks it, since an older one would build the config unpatched. A malformed patch is refused before the container starts, and a catalog app built from source is inspected with its catalog manifest (`appflare-pack inspect --manifest`), so a config wrangler only reads patched no longer fails detection.
- A build's stored zip is checked against every D1 file its manifest lists, schema files and post-deploy migrations included.
- Builds keep the wrangler config's `exports`, `cache` and `worker_loaders`, so apps that use them build and install from a repository.
- A build fails, with the reason, when the Worker does not fit one Appflare upload: its modules add up to more than 32 MiB, or they lie so far apart in the artifact that reading them would take more than 42 subrequests. A Worker of any number of modules builds otherwise.
- A build from a repository asks for every secret the wrangler config lists in `secrets.required` as well as those `.dev.vars.example` lists, never as optional, and the log says where they came from. A config whose only `unsafe` bindings are rate limits is no longer refused. The image checks that corepack runs, which yarn 2 and later install through, and caches npm 11 (`npm@11.20.0`) for checkouts that ask for it.
- The image carries the packer of this release: Workers checked against the upload budget (32 MiB, and the Range requests reading them takes) instead of a module count; `install.installDirs` installed in order, each checked for its lockfile first, with `lockfile: "none"` installs whose written lockfile is hashed into the log; D1 migrations found, named and ordered as `wrangler d1 migrations apply` does, with `resources.d1` schema files (held to statements safe to run again) and post-deploy migrations; `exports`, `cache` and `worker_loaders` recorded (Worker Loader only for entries on Workers Paid); config patches applied after the build commands and printed in the pack log; the package manager version a checkout pins, with yarn 2 and later through `corepack yarn` and npm 11 or later through `npx`; rate limits in `unsafe.bindings` recorded as `ratelimit` bindings, any other `unsafe` content refused; a var the catalog manifest declares as a secret left out of the artifact; the main module of a `no_bundle` Worker kept under its own name; `secrets.required` reported by `appflare-pack inspect`; and catalog manifests that declare `install.toolchains` refused for the `sandbox` and `self-deploying` tiers, since the image has no Rust.

## 0.1.4

- The sandbox Worker clones private repositories with a GitHub access token it holds as a secret (`GITHUB_TOKEN_<id>`), named by the build request. Only the commands that fetch the repository get the token, as the password of the https clone through git's environment: never on a command line, in the remote URL or in `.git/config`, never in the dependency install or the build, and never in the log. A new `githubFetch` method makes one GET to github.com or api.github.com with a named token for the manager and returns GitHub's answer, redirects unfollowed. `info().features` lists `github-tokens`.
- A self-deploying entry's build may be a list of commands: the sandbox Worker runs them in order before the installer, stopping at the first that fails, within the build's time limit, and with pre and post hooks of package scripts off for pnpm and npm, as the packer runs a catalog entry's build. Builds of entries whose `install.buildCommand` is a list log it on one line, and a repository build from a catalog app's baseline shows such a list the same way.
- A repository whose root has no `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` but keeps one as a template (`wrangler.toml.example`, `wrangler.jsonc.template`, and so on) can be built from the Catalog page: the build detects the template, and the packer copies it to its real name before wrangler reads it. A real config still wins over any template.
- The image carries the packer of this release: catalog entries of several Workers (`install.workers`), Hyperdrive bindings the catalog manifest declares, wrangler configs kept as templates (in packs and in `appflare-pack inspect`), and `install.buildCommand` lists run in order with package script hooks off. The image build now packs a small entry with a template config, a Hyperdrive binding and a two-command build, and fails if the packer cannot.

## 0.1.3

- The sandbox Worker builds public GitHub repositories. `buildRepository()` clones a repository at a branch, tag or commit (the default branch when none is named), holds it to the commit the manager resolved, and works out how to build it from the root of the checkout: the package manager from the lockfile, the wrangler config, the build command from `package.json`'s `build` script (or the one the admin entered, or none), the secrets `.dev.vars.example` or `.env.example` lists (a secret whose comment calls it optional is optional), and, from the config as wrangler reads it (`appflare-pack inspect`, so TOML too), one setting per plain var and the sections the packer would leave out. It then installs, packs, stores and verifies the unsigned artifact exactly as a sandbox tier build does, under a version that never replaces one the install already uses, and reports the commit, the ref and what it detected. The app is named `owner/repo`. The same call builds a catalog app from source at another commit with the catalog manifest as the baseline. `info()` lists the new `repository-builds` feature, which the manager requires; a new `detect` step names failures of the detection.
- The image carries the packer of this release: `appflare-pack inspect`, and catalog manifests with optional secrets and select variables.

## 0.1.2

- The sandbox Worker reports which of its versions answers: it gains a version metadata binding (`CF_VERSION_METADATA`), and `info()` returns its id as `versionId`, which the manager waits on after a secret change.
- When a new version of the sandbox Worker resets a build's or an installer run's container before its first command went through ("interrupted while the platform was updating the sandbox runtime", "Durable Object reset because its code was updated"), the run starts again once in a fresh container (`<id>-r`) instead of failing; the run's log notes it, and only a second reset fails the run.

## 0.1.1

- The container image is published as `docker.io/mendylanda/appflare-sandbox:<version>`.

## 0.1.0

- First release of the sandbox Worker, `appflare-sandbox`: an optional Worker for accounts on Workers Paid that builds `sandbox` tier apps from their pinned commit inside a Cloudflare Sandbox container (`standard-1` by default, `standard-2` when an entry asks for it). A build clones the pinned commit, installs dependencies with install scripts disabled, packs an unsigned artifact with `@appflare/pack` (which runs the entry's `install.buildCommand` first), checks every file of the stored zip against its manifest, and keeps it with its log in the R2 bucket `appflare-builds`, served with HTTP Range requests to callers over a service binding only. The container holds no Cloudflare credentials; its outbound traffic, HTTPS included, is not filtered. It is deleted after every build.
- The sandbox Worker runs self-deploying apps' own installers. `deploySelfManaged` and `destroySelfManaged` check out the pinned commit, install dependencies with install scripts disabled, run the entry's build command without credentials, and then run the installer's deploy or destroy command with the stage appended and the app's token, account id, settings and secrets in that one command's environment. The token and secrets come from secrets the manager set on the sandbox Worker for the install; values it knows are redacted from the log it keeps in R2 and returns. After a deploy it reads the expected Workers and their bindings back from the account with the app's token (not the installer's output) and reports every Worker, D1 database, KV namespace, R2 bucket, queue, Vectorize index, Durable Object class and Workflow they own, with the main Worker's workers.dev URL; after a destroy, the Workers that remain. `selfManagedStatus` says whether the token and secrets are held and which Workers exist. `info()` lists `features: ["self-deploying"]`. Before the installer's command runs, any `.env` in the project or at the checkout root is deleted, since Alchemy reads it before the environment. Build and installer requests take an optional `attempt`; a later attempt runs in a container of its own (`-a2`, ...) instead of wiping the work directory of one that may still be running.
