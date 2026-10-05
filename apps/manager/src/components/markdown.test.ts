import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fenceCode, fenceLang, Markdown } from "./markdown";

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(Markdown, null, markdown));
}

describe("Markdown", () => {
  it("draws fenced code as one Kumo code block, without Markdown's closing newline", () => {
    const html = render("Run this:\n\n```bash\nnpm run migrate\n```\n");
    // Kumo's code block: a bordered box around one `pre`, with no `code` of Markdown's inside.
    expect(html).toMatch(
      /<div class="[^"]*border-kumo-fill[^"]*"><pre[^>]*>npm run migrate<\/pre><\/div>/,
    );
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).not.toContain("<code");
  });

  it("keeps inline code inline", () => {
    const html = render("Set `API_KEY` first.");
    expect(html).toMatch(/<code[^>]*>API_KEY<\/code>/);
    expect(html).not.toContain("<pre");
  });

  it("sets every heading level below the section it appears in", () => {
    const html = render("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six");
    expect(html).toMatch(/<h3[^>]*>One<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Two<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>Three<\/h4>/);
    expect(html).toMatch(/<h5[^>]*>Four<\/h5>/);
    expect(html).toMatch(/<h6[^>]*>Five<\/h6>/);
    expect(html).toMatch(/<h6[^>]*>Six<\/h6>/);
  });
});

describe("bare addresses", () => {
  /** Every link's href and text, in order. */
  function links(html: string): Array<[string, string]> {
    return [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [
      m[1] ?? "",
      (m[2] ?? "").replace(/<svg.*?<\/svg>/g, ""),
    ]);
  }

  it("links a bare https address like a Markdown link, in a new tab with the external icon", () => {
    const html = render(
      "Open https://openseo.appflare.dev and sign in. https://openseo.appflare.dev/api/health lists checks. The MCP server at https://openseo.appflare.dev/mcp, as the [guide](https://example.org/ops) says.",
    );
    expect(links(html)).toEqual([
      ["https://openseo.appflare.dev", "https://openseo.appflare.dev"],
      ["https://openseo.appflare.dev/api/health", "https://openseo.appflare.dev/api/health"],
      ["https://openseo.appflare.dev/mcp", "https://openseo.appflare.dev/mcp"],
      ["https://example.org/ops", "guide"],
    ]);
    // The same Kumo link as a Markdown one: new tab, no opener, the external icon.
    for (const tag of html.match(/<a [^>]*>/g) ?? []) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer"');
    }
    expect(html.match(/<svg/g)).toHaveLength(4);
  });

  it("leaves trailing punctuation out of the link", () => {
    expect(links(render("Add https://x.dev/api/gsc/oauth/callback."))).toEqual([
      ["https://x.dev/api/gsc/oauth/callback", "https://x.dev/api/gsc/oauth/callback"],
    ]);
    expect(links(render("Add https://x.dev/cb; then save, or https://x.dev/b, then go!"))).toEqual([
      ["https://x.dev/cb", "https://x.dev/cb"],
      ["https://x.dev/b", "https://x.dev/b"],
    ]);
    expect(links(render("(see https://x.dev/health)"))).toEqual([
      ["https://x.dev/health", "https://x.dev/health"],
    ]);
    // A parenthesis that belongs to the address stays.
    expect(links(render("https://en.wikipedia.org/wiki/Worker_(software)."))).toEqual([
      [
        "https://en.wikipedia.org/wiki/Worker_(software)",
        "https://en.wikipedia.org/wiki/Worker_(software)",
      ],
    ]);
    expect(render("Add https://x.dev/cb; then.")).toContain("</a>; then.");
  });

  it("keeps an address in inline code as code, to be pasted", () => {
    const html = render("Add `https://x.dev/api/gsc/oauth/callback` as a redirect URI.");
    expect(html).toMatch(/<code[^>]*>https:\/\/x\.dev\/api\/gsc\/oauth\/callback<\/code>/);
    expect(html).not.toContain("<a ");
    // And in a fenced block.
    expect(render("```\ncurl https://x.dev/health\n```")).not.toContain("<a ");
  });

  it("links only addresses written with http(s)://, not www names or email addresses", () => {
    const html = render("See www.example.org or write to admin@example.org.");
    expect(html).not.toContain("<a ");
    expect(html).toContain("www.example.org");
    expect(html).toContain("admin@example.org");
    // Written with character references, they are decoded before GFM sees them.
    expect(render("See www&#46;example.org or admin&#64;example.org.")).not.toContain("<a ");
    // An author's own links are kept as they are.
    expect(links(render("[Mail us](mailto:admin@example.org) or <https://x.dev>"))).toEqual([
      ["mailto:admin@example.org", "Mail us"],
      ["https://x.dev", "https://x.dev"],
    ]);
  });

  it("never makes a link of an unsafe scheme, and drops HTML", () => {
    const html = render("javascript:alert(1) and [x](javascript:alert(1)) <b>bold</b>");
    expect(html).not.toContain("javascript:alert(1)</a>");
    expect(html).not.toMatch(/href="javascript/);
    expect(html).not.toContain("<b>");
  });
});

describe("fenced code", () => {
  const pre = (className: unknown, text: string) => ({
    type: "element",
    tagName: "pre",
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className },
        children: [{ type: "text", value: text }],
      },
    ],
  });

  it("reads the code, dropping only the final newline", () => {
    expect(fenceCode(pre(undefined, "a\n\nb\n"))).toBe("a\n\nb");
    expect(fenceCode(undefined)).toBe("");
  });

  it("maps the fence's language to one Kumo knows, else none", () => {
    expect(fenceLang(pre(["language-sh"], ""))).toBe("bash");
    expect(fenceLang(pre(["language-JSON"], ""))).toBe("jsonc");
    expect(fenceLang(pre(["language-python"], ""))).toBeUndefined();
    expect(fenceLang(pre(undefined, ""))).toBeUndefined();
  });
});
