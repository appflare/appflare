import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";

/**
 * A remark plugin that turns bare `https://…` and `http://…` addresses in
 * Markdown into links, as GitHub does, so a post-install note that names
 * the app's address (`{{appUrl}}/api/health`) shows it as a link like the
 * Markdown links beside it.
 *
 * It uses GFM's autolink literals (the same parser extension remark-gfm
 * uses, without tables, footnotes and the rest): trailing punctuation stays
 * out of the link ("…/callback." "…/callback;"), a closing parenthesis only
 * when it has no opening one in the address ("(https://x)"), and nothing
 * inside inline code or an existing link is touched. GFM also links names
 * starting with `www.` and email addresses; those are put back as text, so
 * only an address written with its scheme becomes a link. The links then go
 * through react-markdown's URL check like any other.
 */

/** The parts of a Markdown syntax tree node the plugin reads. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Whether `link` is an autolink literal, as written, that is not an `http(s)://` address. */
function notHttpLiteral(link: MdNode, source: string): boolean {
  const start = link.position?.start.offset;
  const end = link.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const written = source.slice(start, end);
  // A Markdown link `[…](…)` or an angle autolink `<…>` is the author's own choice.
  if (written.startsWith("[") || written.startsWith("<")) return false;
  return !/^https?:\/\//i.test(written);
}

function unwrap(node: MdNode, source: string): void {
  const children = node.children;
  if (children === undefined) return;
  node.children = children.flatMap((child) =>
    child.type === "link" && notHttpLiteral(child, source) ? (child.children ?? []) : [child],
  );
  for (const child of node.children) unwrap(child, source);
}

interface ProcessorData {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
}

export function remarkHttpAutolinks(this: { data(): ProcessorData }) {
  const data = this.data();
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push(gfmAutolinkLiteral());
  data.fromMarkdownExtensions ??= [];
  data.fromMarkdownExtensions.push(gfmAutolinkLiteralFromMarkdown());
  return (tree: MdNode, file: { value: unknown }) => {
    unwrap(tree, String(file.value));
  };
}
