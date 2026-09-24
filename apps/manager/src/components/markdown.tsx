import { Link, Text } from "@cloudflare/kumo";
import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Markdown from a signed catalog manifest (`postInstall`), rendered with Kumo
 * typography. Raw HTML is dropped (`skipHtml`) and react-markdown's default URL
 * transform removes `javascript:` and other unsafe links.
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
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="grid gap-3">
      <ReactMarkdown skipHtml components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
