import { CodeBlock, Link, Text } from "@cloudflare/kumo";
import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { remarkHttpAutolinks } from "./markdown-autolinks";

/** The languages Kumo's code block takes (the package does not export the type by name). */
type CodeLang = NonNullable<ComponentProps<typeof CodeBlock>["lang"]>;

/** The parts of a Markdown syntax tree node that a code block reads. */
interface MarkdownNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: readonly MarkdownNode[];
}

/** The text of a node and everything inside it. */
function nodeText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

/** Fence languages Kumo's code block knows by another name. */
const CODE_LANGS: Record<string, CodeLang> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  json: "jsonc",
  jsonc: "jsonc",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  css: "css",
};

/** The fence's language (`language-bash` on the `code` inside `pre`), when Kumo knows it. */
export function fenceLang(pre: MarkdownNode | undefined): CodeLang | undefined {
  const code = pre?.children?.find((c) => c.tagName === "code");
  const classes = code?.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  for (const name of classes) {
    if (typeof name === "string" && name.startsWith("language-")) {
      return CODE_LANGS[name.slice("language-".length).toLowerCase()];
    }
  }
  return undefined;
}

/** A fenced block's code, without the newline Markdown ends it with. */
export function fenceCode(pre: MarkdownNode | undefined): string {
  return pre === undefined ? "" : nodeText(pre).replace(/\n$/, "");
}

/**
 * Markdown from a signed catalog manifest (`postInstall`), rendered with Kumo
 * typography. Raw HTML is dropped (`skipHtml`) and react-markdown's default URL
 * transform removes `javascript:` and other unsafe links. Bare `https://`
 * addresses become links too (`markdownPlugins`). Fenced code is a
 * Kumo code block; headings sit below the section they appear in.
 */
export const markdownComponents: Components = {
  p: ({ children }) => <Text>{children}</Text>,
  a: ({ href, children }) => (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Link.ExternalIcon />
    </Link>
  ),
  strong: ({ children }) => (
    <Text as="strong" bold>
      {children}
    </Text>
  ),
  code: ({ children }) => (
    <Text as="code" variant="mono">
      {children}
    </Text>
  ),
  // The `code` inside is read from the syntax tree, so the inline mapping above never applies here.
  // Scrolls sideways inside its own box, so a long command never widens the card on a phone.
  pre: ({ node }) => (
    <div className="min-w-0 overflow-x-auto">
      <CodeBlock code={fenceCode(node)} lang={fenceLang(node)} />
    </div>
  ),
  ul: ({ children }) => <ul className="grid list-disc gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="grid list-decimal gap-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="text-base text-kumo-default">{children}</li>,
  h1: ({ children }) => (
    <Text variant="heading" as="h3">
      {children}
    </Text>
  ),
  h2: ({ children }) => (
    <Text variant="heading" as="h3">
      {children}
    </Text>
  ),
  h3: ({ children }) => (
    <Text variant="heading" as="h4">
      {children}
    </Text>
  ),
  h4: ({ children }) => (
    <Text as="h5" bold>
      {children}
    </Text>
  ),
  h5: ({ children }) => (
    <Text as="h6" bold>
      {children}
    </Text>
  ),
  h6: ({ children }) => (
    <Text as="h6" bold>
      {children}
    </Text>
  ),
};

/** Remark plugins every Markdown in the manager uses: bare `http(s)://` addresses become links. */
export const markdownPlugins: Options["remarkPlugins"] = [
  // Typed against the two processor fields it uses rather than unified's own
  // `Processor` (unified is react-markdown's dependency, not ours).
  remarkHttpAutolinks as unknown as NonNullable<Options["remarkPlugins"]>[number],
];

export function Markdown({ children }: { children: string }) {
  return (
    <div className="grid gap-3">
      <ReactMarkdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
