import type { LLMsOptions } from "fumadocs-core/mdx-plugins";

type Stringify = NonNullable<LLMsOptions["stringify"]>;
type Node = Parameters<Stringify>[0];
type State = Parameters<Stringify>[2];
type Info = Parameters<Stringify>[3];

/** The parts of an MDX JSX element this module reads. */
interface JsxElement {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name: string | null;
  attributes: Array<{ type: string; name?: string; value?: unknown }>;
  children: Node[];
}

function isJsxElement(node: Node): node is Node & JsxElement {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

function attribute(node: JsxElement, name: string): string | undefined {
  const found = node.attributes.find((a) => a.type === "mdxJsxAttribute" && a.name === name);
  return typeof found?.value === "string" ? found.value : undefined;
}

function childrenMarkdown(node: Node & JsxElement, state: State, info: Info): string {
  return state.containerFlow(node as Parameters<State["containerFlow"]>[0], info).trim();
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

type Filter = NonNullable<LLMsOptions["filterElement"]>;

/**
 * Which nodes reach the text agents read. An MDX comment (`{/* … *\/}`) is a
 * note for editors and is left out; the rest follows Fumadocs' default:
 * components render as `stringifyForAgents` writes them, other JSX as its
 * children.
 */
export const filterForAgents: Filter = (node) => {
  if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
    return !/^\s*\/\*[\s\S]*\*\/\s*$/.test(node.value);
  }
  if (isJsxElement(node)) {
    return ["Callout", "Cards", "Card", "Prompt"].includes(node.name ?? "") || "children-only";
  }
  return true;
};

/**
 * Writes the site's MDX components as plain Markdown in the text agents read
 * (each page's `.md`, `llms-full.txt`): a `Callout` becomes a blockquote led by
 * its title, `Cards` a list of links, and a `Prompt` just the code block it
 * wraps. Everything else keeps Fumadocs' default output.
 */
export const stringifyForAgents: Stringify = (node, _parent, state, info) => {
  if (!isJsxElement(node)) return undefined;
  switch (node.name) {
    case "Callout": {
      const title = attribute(node, "title");
      const body = childrenMarkdown(node, state, info);
      return blockquote(title ? `**${title}**\n\n${body}` : body);
    }
    case "Cards":
      return node.children
        .filter((child): child is Node & JsxElement => isJsxElement(child))
        .map((card) => {
          const title = attribute(card, "title") ?? "";
          const href = attribute(card, "href");
          const text = childrenMarkdown(card, state, info).replace(/\s+/g, " ");
          const link = href ? `[${title}](${href})` : title;
          return text ? `- ${link}: ${text}` : `- ${link}`;
        })
        .join("\n");
    case "Prompt":
      return childrenMarkdown(node, state, info);
    default:
      return undefined;
  }
};
