import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import catalogManifestJsonSchema from "@appflare/schema/json-schema/v1.json" with { type: "json" };
import type { AstroIntegration } from "astro";
import { manifestFieldNotes, manifestReferenceIntro } from "./manifest-notes.ts";
import { type JsonSchemaNode, renderSchemaReference } from "./render-schema.ts";

/** Where the generated page lands, relative to the docs package's `src/`. */
const referencePage = "content/docs/catalog/manifest-reference.md";

/** Renders the manifest reference page from `@appflare/schema`'s JSON Schema. */
export function renderManifestReference(): string {
  return renderSchemaReference(catalogManifestJsonSchema as JsonSchemaNode, {
    notes: manifestFieldNotes,
    intro: manifestReferenceIntro,
  });
}

/**
 * Writes the manifest reference into the docs content before Astro reads it,
 * on every `astro build`, `astro dev`, and `astro sync`. The page is generated,
 * never edited by hand, and ignored by git.
 */
export function manifestReference(): AstroIntegration {
  return {
    name: "appflare-manifest-reference",
    hooks: {
      "astro:config:setup": ({ config, logger }) => {
        const target = fileURLToPath(new URL(referencePage, config.srcDir));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, renderManifestReference());
        logger.info(`wrote ${referencePage}`);
      },
    },
  };
}
