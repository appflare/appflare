import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { AgentPrompt } from "./agent-prompt.tsx";
import { InstallButton } from "./install-appflare.tsx";

/**
 * The components a page's MDX can use. The defaults include `Callout`, `Cards`
 * and `Card`, heading anchors, and code blocks with a copy button;
 * `AgentPrompt` copies a short prompt for a coding agent.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    AgentPrompt,
    InstallButton,
    ...components,
  } satisfies MDXComponents;
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
