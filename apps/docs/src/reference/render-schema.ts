/**
 * Renders the catalog manifest's JSON Schema as a Markdown reference page.
 *
 * The docs build calls this with `@appflare/schema`'s published JSON Schema, so
 * the reference always matches the schema the catalog validates against. It
 * understands the subset of JSON Schema that `z.toJSONSchema` emits for the
 * manifest: objects, arrays, string enums, patterns, lengths, integer ranges,
 * defaults, unions of scalar types, and records (objects keyed by a free-form
 * name).
 */

/** The JSON Schema keywords this renderer reads. Anything else is ignored. */
export interface JsonSchemaNode {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  propertyNames?: JsonSchemaNode;
  items?: JsonSchemaNode;
  /**
   * A union of scalar types, such as `boolean` or one of some strings. Loosely
   * typed: the manifest also uses `anyOf` for rules whose members are not fields.
   */
  anyOf?: readonly unknown[];
  enum?: readonly (string | number | boolean)[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  $id?: string;
}

/**
 * Extra descriptions keyed by field path. A path joins property names with `.`,
 * marks an array's items with `[]` and a record's values with `<name>`, for
 * example `secrets[].generate` or `resources.vectorize.<name>.metric`. A
 * `description` in the schema itself takes precedence.
 */
export type FieldNotes = Readonly<Record<string, string>>;

/** One object in the schema that gets its own table on the page. */
interface ObjectSection {
  /** Field path of the object (`""` for the top level). */
  path: string;
  /** Heading text for the section. */
  heading: string;
  node: JsonSchemaNode;
}

export interface RenderOptions {
  notes?: FieldNotes;
  /** Markdown placed between the front matter and the first table. */
  intro?: string;
}

/**
 * Every field path in the schema, in document order. Used to check that
 * hand-written notes still point at real fields.
 */
export function fieldPaths(schema: JsonSchemaNode): string[] {
  const paths: string[] = [];
  for (const section of collectSections(schema)) {
    for (const name of Object.keys(section.node.properties ?? {})) {
      paths.push(joinPath(section.path, name));
    }
  }
  return paths;
}

/** Renders the whole reference page, front matter included. */
export function renderSchemaReference(schema: JsonSchemaNode, options: RenderOptions = {}): string {
  const notes = options.notes ?? {};
  const sections = collectSections(schema);
  const anchors = new Map(sections.map((section) => [section.path, slugify(section.heading)]));

  const lines: string[] = [
    "---",
    `title: ${yamlString("Manifest reference")}`,
    `description: ${yamlString(
      "Every field of appflare.jsonc, generated from the catalog manifest JSON Schema.",
    )}`,
    "---",
    "",
  ];
  if (options.intro) lines.push(options.intro.trim(), "");

  for (const section of sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.path !== "") lines.push(sectionLead(section.path), "");
    lines.push("| Field | Type | Required | Details |", "| --- | --- | --- | --- |");
    const required = new Set(section.node.required ?? []);
    for (const [name, field] of Object.entries(section.node.properties ?? {})) {
      const path = joinPath(section.path, name);
      const cells = [
        code(name),
        describeType(field, path, anchors),
        describeRequired(field, required.has(name)),
        describeDetails(field, notes[path]),
      ];
      lines.push(`| ${cells.map(tableCell).join(" | ")} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Walks the schema breadth-first and returns every object that has properties. */
function collectSections(schema: JsonSchemaNode): ObjectSection[] {
  const sections: ObjectSection[] = [];
  const queue: ObjectSection[] = [{ path: "", heading: "Top-level fields", node: schema }];
  while (queue.length > 0) {
    const section = queue.shift();
    if (!section) break;
    sections.push(section);
    for (const [name, field] of Object.entries(section.node.properties ?? {})) {
      const child = nestedObject(field, joinPath(section.path, name));
      if (child) queue.push({ ...child, heading: code(child.path) });
    }
  }
  return sections;
}

/** The object a field leads to (directly, as array items, or as record values). */
function nestedObject(
  field: JsonSchemaNode,
  path: string,
): { path: string; node: JsonSchemaNode } | undefined {
  if (hasProperties(field)) return { path, node: field };
  if (field.type === "array" && field.items && hasProperties(field.items)) {
    return { path: `${path}[]`, node: field.items };
  }
  const values = recordValues(field);
  if (values && hasProperties(values)) return { path: `${path}.<name>`, node: values };
  return undefined;
}

function hasProperties(node: JsonSchemaNode): boolean {
  return node.type === "object" && node.properties !== undefined;
}

/** The value schema of a record (`additionalProperties` given as a schema). */
function recordValues(node: JsonSchemaNode): JsonSchemaNode | undefined {
  if (node.type !== "object" || node.properties !== undefined) return undefined;
  return typeof node.additionalProperties === "object" ? node.additionalProperties : undefined;
}

function sectionLead(path: string): string {
  if (path.endsWith("[]")) return `Each entry of ${code(path.slice(0, -2))} has these fields.`;
  if (path.endsWith(".<name>")) {
    return `Each value of ${code(path.slice(0, -".<name>".length))}, keyed by name, has these fields.`;
  }
  return `Fields of ${code(path)}.`;
}

function describeType(field: JsonSchemaNode, path: string, anchors: Map<string, string>): string {
  const link = (target: string, text: string) => {
    const anchor = anchors.get(target);
    return anchor ? `[${text}](#${anchor})` : text;
  };
  if (field.type === "array" && field.items) {
    const items = field.items;
    if (hasProperties(items)) return `array of ${link(`${path}[]`, "objects")}`;
    return pluralType(items);
  }
  if (hasProperties(field)) return link(path, "object");
  const values = recordValues(field);
  if (values) {
    if (hasProperties(values)) return `map of name to ${link(`${path}.<name>`, "object")}`;
    return `map of name to ${scalarType(values)}`;
  }
  return scalarType(field);
}

function scalarType(field: JsonSchemaNode): string {
  if (field.type === undefined && field.anyOf !== undefined && field.anyOf.length > 0) {
    return field.anyOf.map((member) => scalarType(member as JsonSchemaNode)).join(", or ");
  }
  if (field.enum) {
    const values = enumValues(field.enum);
    if (values.length === 1) return values.join("");
    return values.length === 2 ? values.join(" or ") : `one of ${values.join(", ")}`;
  }
  if (field.type === "string" && field.format === "uri") return "string (URL)";
  return field.type ?? "any";
}

function pluralType(field: JsonSchemaNode): string {
  if (field.enum) return `array, each one of ${enumValues(field.enum).join(", ")}`;
  return `array of ${field.type ?? "value"}s`;
}

function enumValues(values: readonly (string | number | boolean)[]): string[] {
  return values.map((value) => code(JSON.stringify(value)));
}

function describeRequired(field: JsonSchemaNode, listedAsRequired: boolean): string {
  // z.toJSONSchema lists defaulted fields as required (their parsed output always
  // has them), but a manifest author may leave them out.
  if (field.default !== undefined) return `no (default ${code(JSON.stringify(field.default))})`;
  return listedAsRequired ? "yes" : "no";
}

function describeDetails(field: JsonSchemaNode, note: string | undefined): string {
  const parts: string[] = [];
  const description = field.description ?? note;
  if (description) parts.push(description.trim());
  const constraints = [
    ...describeConstraints(field),
    ...(field.type === "array" && field.items ? describeConstraints(field.items, "each ") : []),
    ...(field.propertyNames ? describeConstraints(field.propertyNames, "names ") : []),
  ];
  if (constraints.length > 0) parts.push(`${capitalize(constraints.join("; "))}.`);
  return parts.join(" ");
}

function describeConstraints(field: JsonSchemaNode, prefix = ""): string[] {
  const out: string[] = [];
  if (field.minLength === 1 && field.maxLength === undefined) {
    out.push(`${prefix}must not be empty`);
  } else if (field.minLength !== undefined || field.maxLength !== undefined) {
    out.push(`${prefix}length ${range(field.minLength, field.maxLength)}`);
  }
  if (field.pattern !== undefined) out.push(`${prefix}must match ${code(field.pattern)}`);
  if (field.minimum !== undefined || field.maximum !== undefined) {
    out.push(`${prefix}from ${range(field.minimum, field.maximum)}`);
  }
  return out;
}

function range(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  if (min !== undefined) return `at least ${min}`;
  return `at most ${max}`;
}

function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}.${name}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Wraps text in a code span, using a fence longer than any backtick run inside. */
export function code(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes a value for a GFM table cell: pipes split cells, even inside code spans. */
function tableCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** A double-quoted YAML scalar (JSON strings are valid YAML). */
function yamlString(text: string): string {
  return JSON.stringify(text);
}

/**
 * The heading anchor Fumadocs generates, for the characters these headings
 * use: lower case, spaces to hyphens, everything that is not a letter, digit,
 * hyphen, or underscore dropped (the github-slugger rules).
 */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
