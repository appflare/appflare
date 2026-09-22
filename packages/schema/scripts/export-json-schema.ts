import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
// Imported with an explicit `.ts` extension so Node's native type stripping can
// resolve it directly (`node scripts/export-json-schema.ts`), no bundler needed.
import { catalogManifestSchema } from "../src/catalog.ts";

/**
 * Regenerates `packages/schema/json-schema/v1.json`, the JSON Schema for the
 * catalog manifest published to `https://appflare.github.io/catalog/schema/v1.json`
 * and referenced by every `appflare.jsonc` `$schema`. Run via:
 *   pnpm --filter @appflare/schema export-json-schema
 * The output is deterministic; re-running it must produce no diff.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "json-schema", "v1.json");

const jsonSchema = z.toJSONSchema(catalogManifestSchema);
const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://appflare.github.io/catalog/schema/v1.json",
  title: "Appflare catalog manifest (appflare.jsonc)",
  ...jsonSchema,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
