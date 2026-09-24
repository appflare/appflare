import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Prompt } from "./prompt.tsx";

/**
 * The components a page's MDX can use. The defaults include `Callout`, `Cards`
 * and `Card`, heading anchors, and code blocks with a copy button; `Prompt`
 * wraps a code block that holds a prompt for an AI agent.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Prompt,
    ...components,
  } satisfies MDXComponents;
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
