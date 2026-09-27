import { z } from "zod";

/**
 * Build-time constants (`install.buildEnv`): names and values the catalog
 * entry sets in the environment of its build, for apps that compile public
 * settings into their files (Vite's `import.meta.env.VITE_*`, SvelteKit's
 * `$env/static/public`), where the Worker cannot read them at run time.
 *
 * They are public by construction: the build bakes them into files anyone
 * can download, and the catalog manifest that sets them is published. So a
 * name that looks like a credential is refused, and so is one the packer's
 * tools read themselves (Node.js, the package managers, git, wrangler), since
 * a constant must never change how the build runs, only what it writes.
 *
 * The artifact embeds the catalog manifest, so the constants a build used
 * travel with it, and a later pack of the same pin (catalog CI's install
 * check) builds with the same ones.
 *
 * This module imports nothing but zod: `catalog.ts` imports it, and the JSON
 * Schema export runs `catalog.ts` directly under Node's type stripping.
 */

/**
 * The `info().features` entry of a sandbox Worker whose packer knows the
 * settings this module and its siblings added together: build-time
 * constants (`install.buildEnv`), installs without dev dependencies
 * (`install.installDirs[].devDependencies: false`), Vectorize metadata
 * indexes and R2 lifecycle rules. A sandbox Worker without it would build
 * such an entry without them, so the manager refuses to send it one.
 */
export const SANDBOX_FEATURE_BUILD_ENV = "build-env";

/** The most constants `install.buildEnv` may set. */
export const MAX_BUILD_ENV_ENTRIES = 32;

/** The longest name of a build-time constant. */
export const MAX_BUILD_ENV_NAME_LENGTH = 128;

/** The longest value of a build-time constant. */
export const MAX_BUILD_ENV_VALUE_LENGTH = 4096;

/*
 * The name rules below are a deny list, and a deny list is never complete:
 * a tool the build runs may read a variable no list here names. It stays a
 * deny list because an allow list would refuse the ordinary names apps
 * compile in (`ORIGINS`, `SITE_TITLE`). The real control is catalog review:
 * a reviewer reads every `install.buildEnv` like any other change to how an
 * app is built. These rules catch the names known to change how a build
 * runs, so review need not.
 */

/**
 * Name prefixes the build's own tools read, or that name a credential the
 * packer strips: the packer and wrangler (and the esbuild, Miniflare and
 * workerd inside it), Node.js and the package managers, git and CI, shells,
 * the dynamic linker and C library, TLS and HTTP clients, the desktop
 * configuration directories, other language toolchains a build script may
 * start, and monorepo build tools. A constant with one could change how the
 * build runs.
 */
export const RESERVED_BUILD_ENV_PREFIXES = [
  // Appflare, wrangler and what wrangler runs.
  "CLOUDFLARE_",
  "WRANGLER_",
  "CF_",
  "APPFLARE_",
  "ESBUILD_",
  "MINIFLARE_",
  "WORKERD_",
  // Node.js and package managers.
  "NODE_",
  "NPM_",
  "NPX_",
  "PNPM_",
  "YARN_",
  "BUN_",
  "COREPACK_",
  "DENO_",
  // git and CI.
  "GIT_",
  "GITHUB_",
  "RUNNER_",
  "ACTIONS_",
  // Shells, the dynamic linker and the C library.
  "BASH",
  "SHELLOPTS",
  "LD_",
  "DYLD_",
  "GCONV",
  // TLS, HTTP clients and configuration directories.
  "SSL_",
  "OPENSSL_",
  "CURL_",
  "XDG_",
  // Other toolchains a build script may start.
  "PYTHON",
  "PERL5",
  "RUBY",
  "JAVA_",
  "_JAVA",
  "CARGO_",
  "RUST",
  // Monorepo and code-generation tools.
  "TURBO_",
  "NX_",
  "PRISMA_",
] as const;

/** Whole names the environment of any process, a shell, or a network client relies on. */
export const RESERVED_BUILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "TZ",
  // Read by the Go toolchain when a build script runs it.
  "GOPATH",
  "GOROOT",
  "GOFLAGS",
  "GOPROXY",
  "GOENV",
  "GOCACHE",
  "GOMODCACHE",
  "GOPRIVATE",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOINSECURE",
  "GOTOOLCHAIN",
  "GOWORK",
  "HOSTNAME",
  "CI",
  "GH_TOKEN",
  // Read by shells when a build script runs one.
  "ENV",
  "PS4",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  // Where network clients send their requests.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
] as const;

/** Words a credential's name carries; a build-time constant is public, so none may. */
export const SECRET_LOOKING_WORDS = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "TOKEN",
  "PRIVATE",
  "CREDENTIAL",
] as const;

/** The same rule as {@link buildEnvNameProblem}, for editors reading the JSON Schema. */
const BUILD_ENV_NAME_PATTERN =
  `^(?!(?:${RESERVED_BUILD_ENV_PREFIXES.join("|")}))` +
  `(?!(?:${RESERVED_BUILD_ENV_NAMES.join("|")})$)` +
  `(?!.*(?:${SECRET_LOOKING_WORDS.join("|")}))` +
  "[A-Z][A-Z0-9_]*$";

/** Why `name` cannot be a build-time constant, or null when it can. */
export function buildEnvNameProblem(name: string): string | null {
  if (name.length === 0) return "is empty";
  if (name.length > MAX_BUILD_ENV_NAME_LENGTH) {
    return `"${name}" is longer than ${MAX_BUILD_ENV_NAME_LENGTH} characters`;
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return `"${name}" must be upper-case letters, digits and _, starting with a letter (for example VITE_API_ORIGIN)`;
  }
  const prefix = RESERVED_BUILD_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix !== undefined) {
    return `"${name}" starts with ${prefix}, which the build's own tools read; a build-time constant may only change what the build writes, not how it runs`;
  }
  if ((RESERVED_BUILD_ENV_NAMES as readonly string[]).includes(name)) {
    return `"${name}" is a name processes, shells or network clients read; a build-time constant may only change what the build writes, so choose a name of the app's own`;
  }
  const word = SECRET_LOOKING_WORDS.find((w) => name.includes(w));
  if (word !== undefined) {
    return `"${name}" looks like a credential (${word}); build-time constants are compiled into files anyone can download and published in the catalog, so a secret belongs in secrets instead`;
  }
  return null;
}

/** `install.buildEnv`: build-time constants by name. */
export const buildEnvSchema = z
  .record(
    // The rule is checked on the whole map below, where its message reaches
    // the author; a key schema's own issues surface only as "Invalid key".
    z.string().meta({ pattern: BUILD_ENV_NAME_PATTERN, maxLength: MAX_BUILD_ENV_NAME_LENGTH }),
    z
      .string()
      .max(MAX_BUILD_ENV_VALUE_LENGTH)
      .refine((value) => !value.includes("\0"), "a value cannot contain a NUL character"),
  )
  .superRefine((env, ctx) => {
    const names = Object.keys(env);
    if (names.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "install.buildEnv sets no constant; leave it out instead",
      });
    }
    if (names.length > MAX_BUILD_ENV_ENTRIES) {
      ctx.addIssue({
        code: "custom",
        message: `install.buildEnv sets at most ${MAX_BUILD_ENV_ENTRIES} constants`,
      });
    }
    for (const name of names) {
      const problem = buildEnvNameProblem(name);
      if (problem !== null) {
        ctx.addIssue({ code: "custom", path: [name], message: `name ${problem}` });
      }
    }
  })
  .meta({ minProperties: 1, maxProperties: MAX_BUILD_ENV_ENTRIES });
export type BuildEnv = z.infer<typeof buildEnvSchema>;
