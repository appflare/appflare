import catalogManifestJsonSchema from "@appflare/schema/json-schema/v1.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { renderManifestReference } from "./integration.ts";
import { manifestFieldNotes } from "./manifest-notes.ts";
import {
  code,
  fieldPaths,
  type JsonSchemaNode,
  renderSchemaReference,
  slugify,
} from "./render-schema.ts";

const manifestSchema = catalogManifestJsonSchema as JsonSchemaNode;

describe("renderSchemaReference", () => {
  const schema: JsonSchemaNode = {
    type: "object",
    properties: {
      slug: { type: "string", minLength: 1 },
      plan: { type: "string", enum: ["free", "paid"] },
      tier: { type: "string", enum: ["artifact", "sandbox", "self-deploying"] },
      requires: { type: "array", items: { type: "string", enum: ["r2", "zone"] } },
      source: {
        type: "object",
        properties: { sha: { type: "string", pattern: "^[0-9a-f]{40}$" } },
        required: ["sha"],
      },
      secrets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            generate: { type: "boolean", default: false },
          },
          required: ["name", "generate"],
        },
      },
      tags: { type: "array", items: { type: "string", pattern: "a|b" } },
      resources: {
        type: "object",
        properties: {
          vectorize: {
            type: "object",
            propertyNames: { type: "string", minLength: 1 },
            additionalProperties: {
              type: "object",
              properties: { dimensions: { type: "integer", minimum: 1, maximum: 1536 } },
              required: ["dimensions"],
            },
          },
        },
      },
    },
    required: ["slug", "plan", "source", "secrets"],
  };
  const page = renderSchemaReference(schema, {
    notes: { slug: "The app's id.", "secrets[].name": "Secret name." },
  });

  it("writes front matter Fumadocs accepts", () => {
    expect(page.startsWith('---\ntitle: "Manifest reference"\ndescription: ')).toBe(true);
  });

  it("gives every object its own section, linked from its parent", () => {
    expect(page).toContain("## `source`");
    expect(page).toContain("## `secrets[]`");
    expect(page).toContain("## `resources.vectorize.<name>`");
    expect(page).toContain("| `source` | [object](#source) | yes |");
    expect(page).toContain("| `secrets` | array of [objects](#secrets) | yes |");
    expect(page).toContain("map of name to [object](#resourcesvectorizename)");
  });

  it("shows enums, constraints, and notes", () => {
    expect(page).toContain('| `plan` | `"free"` or `"paid"` | yes |');
    expect(page).toContain(
      '| `tier` | one of `"artifact"`, `"sandbox"`, `"self-deploying"` | no |',
    );
    expect(page).toContain('| `requires` | array, each one of `"r2"`, `"zone"` | no |');
    expect(page).toContain("| `tags` | array of strings | no |");
    expect(page).toContain("| `slug` | string | yes | The app's id. Must not be empty. |");
    expect(page).toContain("Must match `^[0-9a-f]{40}$`.");
    expect(page).toContain("From 1 to 1536.");
    expect(page).toContain("| `name` | string | yes | Secret name. Must not be empty. |");
  });

  it("marks defaulted fields optional even when the schema lists them as required", () => {
    expect(page).toContain("| `generate` | boolean | no (default `false`) |");
  });

  it("names each type of a union", () => {
    const union = renderSchemaReference({
      type: "object",
      properties: {
        generate: {
          anyOf: [{ type: "boolean" }, { type: "string", enum: ["vapid-private-key"] }],
          default: false,
        },
      },
    });
    expect(union).toContain(
      '| `generate` | boolean, or `"vapid-private-key"` | no (default `false`) |',
    );
  });

  it("escapes pipes so they do not split table cells", () => {
    expect(page).toContain("Each must match `a\\|b`.");
  });
});

describe("the catalog manifest reference", () => {
  const page = renderManifestReference();

  it("documents every field of the published schema", () => {
    for (const path of fieldPaths(manifestSchema)) {
      const name = path.split(".").at(-1)?.replace("[]", "") ?? path;
      expect(page, path).toContain(`| ${code(name)} |`);
    }
  });

  it("has notes only for fields that exist", () => {
    const paths = new Set(fieldPaths(manifestSchema));
    const stale = Object.keys(manifestFieldNotes).filter((path) => !paths.has(path));
    expect(stale).toEqual([]);
  });

  it("describes every field", () => {
    const undescribed = fieldPaths(manifestSchema).filter(
      (path) => manifestFieldNotes[path] === undefined && !hasSchemaDescription(path),
    );
    expect(undescribed).toEqual([]);
  });
});

describe("slugify", () => {
  it("matches the anchors Fumadocs gives these headings", () => {
    expect(slugify("Top-level fields")).toBe("top-level-fields");
    expect(slugify("`install`")).toBe("install");
    expect(slugify("`secrets[]`")).toBe("secrets");
    expect(slugify("`resources.vectorize.<name>`")).toBe("resourcesvectorizename");
  });
});

/** Whether the schema itself describes the field at `path`. */
function hasSchemaDescription(path: string): boolean {
  let node: JsonSchemaNode | undefined = manifestSchema;
  for (const segment of path.split(".")) {
    if (!node) return false;
    if (segment === "<name>") {
      node = typeof node.additionalProperties === "object" ? node.additionalProperties : undefined;
      continue;
    }
    const isItems = segment.endsWith("[]");
    const property: JsonSchemaNode | undefined = node.properties?.[segment.replace("[]", "")];
    node = isItems ? property?.items : property;
  }
  return node?.description !== undefined;
}
