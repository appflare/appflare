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

/** Rewrites the text of one appflare.jsonc into the v1 shape, keeping comments and layout. */
export function migrate(text: string): MigratedManifest;
