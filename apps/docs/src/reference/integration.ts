import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import catalogManifestJsonSchema from "@appflare/schema/json-schema/v1.json" with { type: "json" };
import type { Plugin } from "vite";
import { manifestFieldNotes, manifestReferenceIntro } from "./manifest-notes.ts";
import { type JsonSchemaNode, renderSchemaReference } from "./render-schema.ts";

/** Where the generated page lands, relative to the docs package. */
export const referencePage = "content/docs/catalog/manifest-reference.md";

/** Renders the manifest reference page from `@appflare/schema`'s JSON Schema. */
export function renderManifestReference(): string {
  return renderSchemaReference(catalogManifestJsonSchema as JsonSchemaNode, {
    notes: manifestFieldNotes,
    intro: manifestReferenceIntro,
  });
}

/**
 * Writes the manifest reference into the docs content when Vite starts, before
 * Fumadocs MDX reads the content, on every `vite build` and `vite dev`. The page
 * is generated, never edited by hand, and ignored by git.
 */
export function manifestReference(): Plugin {
  return {
    name: "appflare-manifest-reference",
    enforce: "pre",
    configResolved(config) {
      const target = resolve(config.root, referencePage);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, renderManifestReference());
    },
  };
}
