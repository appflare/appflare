/** The result of rewriting one catalog manifest: its new text and what changed. */
export interface MigratedManifest {
  text: string;
  /** What the rewrite changed, one line each. */
  changes: string[];
  /** What a person may want to look at; nothing is wrong. */
  notes: string[];
  /** What a person must check or finish by hand. */
  todos: string[];
}

/**
 * Rewrites the text of one appflare.jsonc into the v1 shape, keeping comments
 * and layout. A manifest already in the v1 shape comes back unchanged.
 */
export function migrate(text: string): MigratedManifest;

/**
 * What shows a parsed manifest is still in the shape before v1, one line
 * each; empty when it is in the v1 shape.
 */
export function preV1Signs(manifest: { [key: string]: unknown }): string[];

/**
 * What only a person can finish, which a rewrite leaves in the file (token
 * permissions of an unknown group, a stage option other than the tool's own).
 */
export function leftForAPerson(manifest: { [key: string]: unknown }): string[];
