import type { ReactNode } from "react";

/**
 * Wraps a code block that holds a prompt for an AI agent. Its lines wrap to the
 * page width instead of scrolling sideways, so the prompt can be read before it
 * is copied; the copy button still copies the text exactly as written.
 */
export function Prompt({ children }: { children: ReactNode }) {
  return <div className="docs-prompt">{children}</div>;
}
