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
