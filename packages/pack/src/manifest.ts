import {
  type CatalogManifest,
  catalogLicenseProblem,
  catalogManifestSchema,
  formatPath,
  licenseProblem,
  strictCatalogManifestSchema,
  strictSchema,
} from "@appflare/schema";
import { parseJsonc } from "./jsonc.ts";

/** Options for {@link readCatalogManifest}. */
export interface ReadCatalogManifestOptions {
  /**
   * The manifest is the one Appflare works out for an app built from a
   * repository without a catalog entry: its `license` may also be
   * `NOASSERTION` or `SEE LICENSE IN <file>`, as its `package.json` says.
   */
  repositoryBuild?: boolean | undefined;
}

/**
 * The strict catalog manifest schema for a repository build: unknown keys
 * are refused as for a catalog entry, and `license` may also take the two
 * forms only such a build carries.
 */
const repositoryBuildManifestSchema = strictSchema(catalogManifestSchema, (input) => {
  const license =
    typeof input === "object" && input !== null && "license" in input ? input.license : undefined;
  // A license of the wrong shape is the schema's own problem, reported once.
  if (typeof license !== "string" || licenseProblem(license) !== null) return [];
  const problem = catalogLicenseProblem(license, { repositoryBuild: true });
  return problem === null ? [] : [{ path: ["license"], message: `license ${problem}` }];
});

/** Zod issues as lines of `- <path>: <message>`. */
export function issueLines(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((issue) => `- ${formatPath(issue.path) || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Parses the text of an `appflare.jsonc` as the packer checks a catalog
 * manifest: every key the schema does not know is refused with its path (a
 * misspelling would otherwise be dropped without a word), and `license` is
 * written as a catalog entry writes it (current SPDX ids, a
 * `LicenseRef-<name>`, or `NONE`). Throws an error listing every problem.
 */
export function readCatalogManifest(
  text: string,
  options: ReadCatalogManifestOptions = {},
): CatalogManifest {
  let json: unknown;
  try {
    json = parseJsonc(text);
  } catch (error) {
    throw new Error(
      `the catalog manifest is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const schema =
    options.repositoryBuild === true ? repositoryBuildManifestSchema : strictCatalogManifestSchema;
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  throw new Error(`the catalog manifest is not valid:\n${issueLines(result.error.issues)}`);
}
