import type * as PageTree from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";
import { pageUrl } from "./shared.ts";
import { source } from "./source.ts";

/** The sidebar as `---Group---` headings and page URLs, in order. */
function sidebar(): string[] {
  const out: string[] = [];
  const visit = (nodes: PageTree.Node[]) => {
    for (const node of nodes) {
      if (node.type === "separator") out.push(`---${String(node.name)}---`);
      else if (node.type === "page") {
        const page = source.getNodePage(node);
        if (page) out.push(pageUrl(page.slugs));
      } else {
        if (node.index) visit([node.index]);
        visit(node.children);
      }
    }
  };
  visit(source.getPageTree().children);
  return out;
}

describe("the docs sidebar", () => {
  const items = sidebar();

  it("starts at the overview", () => {
    expect(items.slice(0, 2)).toEqual(["---Getting started---", "/start/overview/"]);
  });

  it("ends with an Advanced group holding custom catalogs", () => {
    const advanced = items.lastIndexOf("---Advanced---");
    const groups = items.filter((item) => item.startsWith("---"));
    expect(groups.at(-1)).toBe("---Advanced---");
    expect(items.slice(advanced)).toContain("/guides/custom-catalogs/");
    expect(items.indexOf("/guides/custom-catalogs/")).toBeGreaterThan(advanced);
  });

  it("lists no page for the agent prompts, which are buttons on their pages now", () => {
    expect(items.filter((item) => item.includes("with-an-agent"))).toEqual([]);
  });

  it("leaves out the privacy page, which is still a page", () => {
    expect(items).not.toContain("/privacy/");
    expect(source.getPage(["privacy"])).toBeDefined();
  });
});
