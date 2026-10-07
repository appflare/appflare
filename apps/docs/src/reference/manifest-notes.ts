import type { FieldNotes } from "./render-schema.ts";

/** Opening text of the generated manifest reference page. */
export const manifestReferenceIntro = `
Each app in the catalog is described by one file, \`apps/<slug>/appflare.jsonc\`.
This page lists every field the catalog accepts. It is generated from the
manifest's JSON Schema each time the docs are built. The catalog checks every
manifest against the same schema when an app is packed and refuses a field it
does not know, so a misspelled field is an error, never silently dropped.

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
 * Descriptions for fields whose schema carries none (a field's own
 * description in the schema wins). Keys are field paths as `fieldPaths()`
 * returns them; a test fails when one no longer exists.
 */
export const manifestFieldNotes: FieldNotes = {
  $schema: "Set it to `https://appflare.github.io/catalog/schema/v1.json` for editor checks.",
  slug: "The app's id in the catalog. The folder name `apps/<slug>/` must be the same.",
  name: "Display name shown in the catalog.",
  summary: "One or two sentences shown on the app's catalog page.",
  repo: "The public GitHub repository the app is built from, as `owner/repo`.",
  maintainers:
    "GitHub usernames of the people who package the app for the catalog, shown as \"Packaged by\" on the app's page. They own the app's folder in CODEOWNERS and review changes to it, and merge the version bumps that do not merge themselves (see `bump`).",
  source: "The exact upstream commit the version is built from. The bump bot edits it.",
  install: "How the packer builds the app and what the manager calls it.",
  plan: 'The Workers plan the app needs. Use `"paid"` when it cannot run on the free plan.',
  secrets: "Secrets the install form asks for.",
  vars: "Settings the install form asks for. Each reaches the Worker as a variable: text, or JSON when the wrangler config gives it a value that is not a string.",
  resources: "Settings for resources that the wrangler config cannot describe.",
  "install.packageManager": "The package manager used to install the app's dependencies.",
  "install.wranglerConfig":
    "Path of the app's own wrangler config inside the repository, for example `wrangler.jsonc`. When the build leaves a `.wrangler/deploy/config.json` redirect beside it (as the Cloudflare Vite plugin does), the packer builds from the config it points at, as `wrangler deploy` does.",
  "install.workerName":
    "The default Worker name. The user can change it at install. Defaults to the slug.",
  "install.fixedWorkerName":
    "Set to `true` when the app only works under `workerName`. It can then be installed once per account.",
  "secrets[].name": "The secret's name as the Worker reads it from `env`.",
  "secrets[].label": "Label of the form field.",
  "secrets[].help": "Help text under the form field.",
  "vars[].name": "The variable's name as the Worker reads it from `env`.",
  "vars[].label": "Label of the form field.",
  "vars[].help": "Help text under the form field.",
  "postInstall[].type": "Only Markdown steps exist today.",
  "resources.vectorize":
    "One entry per Vectorize binding in the wrangler config, keyed by binding name. Required for each such binding.",
  "resources.vectorize.<name>.dimensions":
    "Vector size of the index. Fixed when the index is created.",
  "resources.vectorize.<name>.metric":
    "Distance metric of the index. Fixed when the index is created.",
};
