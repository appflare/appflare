import type { FieldNotes } from "./render-schema.ts";

/** Opening text of the generated manifest reference page. */
export const manifestReferenceIntro = `
Each app in the catalog is described by one file, \`apps/<slug>/appflare.jsonc\`.
This page lists every field the catalog accepts. It is generated from the
manifest's JSON Schema each time the docs are built, so it always matches what the
catalog validates.

Start the file with the schema URL so your editor can check it as you type:

\`\`\`jsonc
{
  "$schema": "https://appflare.github.io/catalog/schema/v1.json"
}
\`\`\`

Bindings, compatibility settings, static assets, Durable Object migrations, and cron
triggers are not listed here. The packer reads them from the app's own wrangler
config at the pinned commit. See [Submit an app](/catalog/submit/) for a worked
example.
`;

/**
 * Descriptions for fields whose schema carries none. Keys are field paths as
 * `fieldPaths()` returns them; a test fails when one no longer exists.
 */
export const manifestFieldNotes: FieldNotes = {
  $schema: "Set it to `https://appflare.github.io/catalog/schema/v1.json` for editor checks.",
  slug: "The app's id in the catalog. The folder name `apps/<slug>/` must be the same.",
  name: "Display name shown in the catalog.",
  summary: "One sentence shown on the catalog card.",
  homepage: "Link shown on the app's catalog page.",
  repo: "The upstream GitHub repository, as `owner/repo`. It must be public.",
  license: "The upstream license, for example `MIT`.",
  categories: "Free-form labels such as `utilities` or `ai`.",
  maintainers:
    "GitHub usernames. They own the app's folder in CODEOWNERS and review changes to it, including version bumps.",
  source: "The exact upstream commit the version is built from. The bump bot edits it.",
  install: "How the packer builds the app and what the manager calls it.",
  plan: 'The Workers plan the app needs. Use `"paid"` when it cannot run on the free plan.',
  requires: "Account features the app needs beyond Workers. Shown on the catalog page.",
  secrets: "Secrets the install form asks for.",
  vars: "Settings the install form asks for. Each reaches the Worker as a variable: text, or JSON when the wrangler config gives it a value that is not a string.",
  postInstall: "Instructions shown after a successful install.",
  tokenPermissions:
    "Permissions for a Cloudflare API token the app needs for itself. The user creates that token; it is stored as the app's secret, never the manager's.",
  resources: "Settings for resources that the wrangler config cannot describe.",
  "source.ref":
    "The tag (`v1.2.3`) or branch (`main`) the commit belongs to. A semver tag becomes the app's version.",
  "source.sha": "The full 40-character commit SHA. Builds use this commit, never the ref.",
  "install.tier": 'Only `"artifact"` is installable today: a signed bundle built by the catalog.',
  "install.packageManager": "The package manager used to install the app's dependencies.",
  "install.wranglerConfig":
    "Path of the app's own wrangler config inside the repository, for example `wrangler.jsonc`. When the build leaves a `.wrangler/deploy/config.json` redirect beside it (as the Cloudflare Vite plugin does), the packer builds from the config it points at, as `wrangler deploy` does.",
  "install.workerName": "The default Worker name. The user can change it at install.",
  "install.fixedWorkerName":
    "Set to `true` when the app only works under `workerName`. It can then be installed once per account.",
  "install.healthPath":
    "The path the health check requests after an install or update. If it answers JSON with a string `version`, an update's check requires the new version. Defaults to `/`.",
  "secrets[].name": "The secret's name as the Worker reads it from `env`.",
  "secrets[].label": "Label of the form field.",
  "secrets[].help": "Help text under the form field.",
  "secrets[].generate":
    "When `true`, the install form fills in a random value that the user can copy, regenerate, or replace.",
  "vars[].name": "The variable's name as the Worker reads it from `env`.",
  "vars[].label": "Label of the form field.",
  "vars[].help": "Help text under the form field.",
  "vars[].required": "When `true`, the install form does not accept an empty value.",
  "postInstall[].type": "Only Markdown steps exist today.",
  "postInstall[].content":
    "Markdown. `{{workerUrl}}` becomes the installed Worker's URL and `{{workerName}}` its name.",
  "tokenPermissions[].name":
    "The permission as the Cloudflare dashboard names it, for example `Zone.DNS`.",
  "tokenPermissions[].description": "Why the app needs it.",
  "tokenPermissions[].scope": "Whether the permission applies to an account, a zone, or the user.",
  "resources.vectorize":
    "One entry per Vectorize binding in the wrangler config, keyed by binding name. Required for each such binding.",
  "resources.vectorize.<name>.dimensions":
    "Vector size of the index. Fixed when the index is created.",
  "resources.vectorize.<name>.metric":
    "Distance metric of the index. Fixed when the index is created.",
};
