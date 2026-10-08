/** How the site's Worker tells a request for a page's Markdown, and where that Markdown is. */

/**
 * Whether an `Accept` header prefers Markdown: it names `text/markdown` with a
 * quality above zero, and HTML, if named at all, with no higher quality.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) return false;
  const quality = new Map<string, number>();
  for (const range of accept.split(",")) {
    const [type = "", ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    quality.set(type, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const markdown = quality.get("text/markdown") ?? 0;
  return markdown > 0 && markdown >= (quality.get("text/html") ?? 0);
}

/**
 * The Markdown version of a page's path: `llms.txt` for the front page, the
 * `.md` file the build writes for a page, or null for a path that is not a
 * page (a file with an extension).
 */
export function markdownPath(pathname: string): string | null {
  if (pathname === "/") return "/llms.txt";
  const page = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const name = page.slice(page.lastIndexOf("/") + 1);
  return name.includes(".") ? null : `${page}.md`;
}
