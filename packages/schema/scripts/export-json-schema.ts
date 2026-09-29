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
 *
 * The schema describes what an author writes: every object refuses keys it
 * does not name (as the strict catalog manifest schema does), and a field
 * with a default is not required.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "json-schema", "v1.json");

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drops from each object's `required` the properties that have a default:
 * Zod's export describes the parsed value, where such a field is always set,
 * while an author may leave it out.
 */
function optionalDefaults(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) optionalDefaults(item);
    return;
  }
  if (!isObject(node)) return;
  const properties = node.properties;
  if (isObject(properties) && Array.isArray(node.required)) {
    const required = node.required.filter(
      (key) =>
        !(typeof key === "string" && isObject(properties[key]) && "default" in properties[key]),
    );
    if (required.length > 0) node.required = required;
    else delete node.required;
  }
  for (const value of Object.values(node)) optionalDefaults(value);
}

const jsonSchema = z.toJSONSchema(catalogManifestSchema) as JsonObject;
optionalDefaults(jsonSchema);
const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://appflare.github.io/catalog/schema/v1.json",
  title: "Appflare catalog manifest (appflare.jsonc)",
  ...jsonSchema,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
