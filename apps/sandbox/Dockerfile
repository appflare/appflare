# syntax=docker/dockerfile:1.7
#
# The Appflare sandbox Worker image: the container a sandbox build runs in.
#
#   docker buildx build --platform linux/amd64 -f apps/sandbox/Dockerfile \
#     -t docker.io/mendylanda/appflare-sandbox:<version> .
#
# Build it from the repository root: the packer is built from this checkout,
# so the image always carries the @appflare/pack of the sandbox Worker's own version.
# Dockerfile.dockerignore (next to this file) limits the context to what that
# build needs. Cloudflare Containers run linux/amd64 images.
#
# Base: the Cloudflare Sandbox runtime image, matching the @cloudflare/sandbox
# version in apps/sandbox/package.json (the SDK checks that they match). It
# provides the sandbox control server (the entrypoint), git, s3fs and FUSE for
# mounting the build bucket, and bun. Node.js is replaced with Node 22, the
# version Appflare builds with, copied the same way the Sandbox image installs
# its own Node.

ARG SANDBOX_IMAGE=docker.io/cloudflare/sandbox:0.12.10@sha256:35c932d3e5b35f28d350800cf00551cac46dfe28274afb54e16325b8d8f560d1
ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

# ---------------------------------------------------------------------------
# The packer, built from this checkout with the lockfile's exact dependencies.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS packer
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY . .
# No dependency install scripts: building the packer needs none.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec turbo run build --filter=@appflare/pack...
# A self-contained copy of @appflare/pack and its production dependencies
# (wrangler among them), as the release workflow bundles it. --legacy: pnpm
# 10's deploy otherwise requires inject-workspace-packages.
RUN pnpm --filter @appflare/pack deploy --prod --legacy /opt/appflare-pack

FROM ${NODE_IMAGE} AS node

# ---------------------------------------------------------------------------
# The runtime.
# ---------------------------------------------------------------------------
FROM ${SANDBOX_IMAGE}

# Node 22 with its npm and corepack, in place of the base image's Node.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# pnpm and yarn through corepack. A checkout that pins another version gets
# that version; COREPACK_ENABLE_STRICT=0 (set per build command) lets one
# without a pin use these.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm yarn \
  && corepack prepare pnpm@10.34.5 --activate \
  && corepack prepare yarn@1.22.22 --activate

# The packer and its wrangler.
COPY --from=packer /opt/appflare-pack /opt/appflare-pack
RUN ln -s /opt/appflare-pack/bin/appflare-pack.js /usr/local/bin/appflare-pack \
  && ln -s /opt/appflare-pack/node_modules/wrangler/bin/wrangler.js /usr/local/bin/wrangler

# `bunx` beside the base image's bun, as bun's own installers provide it: bun
# projects call it in their build scripts (glance builds its web UI with
# `bunx vite build`). Bun acts as `bunx` when it runs under that name.
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Builds do not use the Sandbox code interpreter; its warm pools would only
# take memory from the build.
ENV JAVASCRIPT_POOL_MIN_SIZE=0 \
    TYPESCRIPT_POOL_MIN_SIZE=0 \
    PYTHON_POOL_MIN_SIZE=0

# npm 11 in npx's cache, as the exact spec the packer runs (NPM_11_SPEC in
# packages/pack/src/install.ts; a test holds the two together). The packer
# installs with it when a checkout's
# package.json asks for npm 11 (`packageManager`, `engines.npm`), or when
# Node 22's npm 10 refuses a lockfile npm 11 wrote. yarn 2 and later run
# through `corepack yarn`, which fetches the version the checkout pins.
RUN npx --yes npm@11.20.0 --version
# pnpm 9 the same way (PNPM_9_SPEC in the same file): the packer installs a
# lockfileVersion 6 lockfile (pnpm 8's) with it, since pnpm 10 refuses one.
RUN npx --yes pnpm@9.15.9 --version

# Fail the image build, not a user's build, when a tool is missing.
RUN node --version | grep -q '^v22\.' \
  && pnpm --version && yarn --version && corepack --version && bun --version && bunx --version \
  && git --version \
  && s3fs --version | head -n 1 \
  && wrangler --version && appflare-pack --help > /dev/null

# Repository builds read a checkout's wrangler config with `appflare-pack
# inspect` (wrangler's own reader, so TOML too); an image whose packer lacks it
# could never build a repository.
RUN mkdir /tmp/inspect-check \
  && printf 'name = "inspect-check"\n\n[vars]\nGREETING = "hello"\n' > /tmp/inspect-check/wrangler.toml \
  && appflare-pack inspect /tmp/inspect-check --config wrangler.toml \
    | grep -qF '"name":"inspect-check","vars":["GREETING"]' \
  && rm -rf /tmp/inspect-check

# Pack a small entry the way a build does: its wrangler config kept only as a
# template, a Hyperdrive binding the catalog manifest declares, and a build of
# two commands where the second needs the first (`cp` into the `dist` that
# `mkdir` made). The artifact must verify and must not carry the config id.
RUN <<'CHECK'
set -eu
dir=/tmp/pack-check
mkdir -p "$dir/src"
cd "$dir"
printf 'export default { fetch: () => new Response("ok") };\n' > src/index.js
printf 'name = "pack-check"\nmain = "dist/index.js"\ncompatibility_date = "2025-01-01"\n\n[vars]\nGREETING = "hello"\n\n[[hyperdrive]]\nbinding = "DB"\nid = "feedfacefeedfacefeedfacefeedface"\n' > wrangler.toml.example
printf '%s\n' '{"slug":"pack-check","name":"Pack check","summary":"Checks the packer in the sandbox image.","homepage":"https://github.com/appflare/appflare","repo":"appflare/appflare","license":"Apache-2.0","categories":["utilities"],"maintainers":["appflare"],"source":{"ref":"v1.0.0","sha":"0123456789abcdef0123456789abcdef01234567"},"install":{"tier":"artifact","packageManager":"npm","wranglerConfig":"wrangler.toml.example","workerName":"pack-check","buildCommand":["mkdir dist","cp src/index.js dist/index.js"]},"resources":{"hyperdrive":[{"binding":"DB","protocol":"postgres"}]},"plan":"free","requires":[],"secrets":[],"vars":[],"postInstall":[],"tokenPermissions":[]}' > appflare.jsonc
appflare-pack inspect "$dir" --config wrangler.toml.example \
  | grep -qF '"name":"pack-check","vars":["GREETING"],"unsupported":[]'
appflare-pack "$dir" --manifest appflare.jsonc --out out --no-install
appflare-pack verify out --hashes-only
node -e 'const m = JSON.parse(require("fs").readFileSync("out/manifest.json", "utf8"));
if (!m.worker.bindings.some((b) => b.type === "hyperdrive" && b.name === "DB")) process.exit(1);'
if grep -q feedface out/manifest.json; then
  echo "the artifact carries the Hyperdrive configuration id" >&2
  exit 1
fi
cd /
rm -rf "$dir"
CHECK

WORKDIR /workspace
# The base image's ENTRYPOINT (the sandbox control server) stays as it is.
