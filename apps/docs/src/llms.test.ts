import { describe, expect, it } from "vitest";
import { agentInstructionsUrl } from "./lib/agent-prompts.ts";
import { installLink } from "./lib/install-links.ts";
import { llmsIndex } from "./lib/llms.ts";
import { docsLlms, source } from "./lib/source.ts";

function page(...slugs: string[]) {
  const found = source.getPage(slugs);
  if (!found) throw new Error(`no page ${slugs.join("/")}`);
  return found;
}

describe("Markdown for agents", () => {
  it("contains no JSX from the site's components", async () => {
    const full = await docsLlms.full();
    expect(full).not.toMatch(/<\/?(Callout|Cards|Card|AgentPrompt)\b/);
  });

  it("leaves out MDX comments, which are notes for editors", async () => {
    const full = await docsLlms.full();
    expect(full).not.toContain("{/*");
  });

  it("writes a Callout as a blockquote led by its title", async () => {
    const text = await docsLlms.page(page("guides", "builds"));
    expect(text).toContain(
      "> **No sandbox tier apps in the catalog yet**\n>\n> The manager and the sandbox Worker",
    );
    expect(text).not.toContain("<Callout");
  });

  it("writes Cards as a list of links", async () => {
    const text = await docsLlms.page(page("start", "overview"));
    expect(text).toContain(
      `- [Install from your browser](${installLink("overview-install-card")}): The recommended way.`,
    );
  });

  it("keeps the command line's steps, folded on the page, in the text agents read", async () => {
    const install = await docsLlms.page(page("start", "install"));
    expect(install).toContain("npx create-appflare");
    expect(install).toContain("Cloudflare lets\naccount admins block public OAuth apps");
  });

  it("points no page at the instructions for coding agents", async () => {
    const full = await docsLlms.full();
    expect(full).not.toContain("its instructions are at");
    expect(full).not.toContain(agentInstructionsUrl("install"));
    expect(full).not.toContain("Copy prompt");
  });

  it("lists every page in llms.txt, linked to its Markdown file, those the sidebar leaves out too", () => {
    const index = llmsIndex();
    for (const { slugs } of source.getPages()) {
      expect(index).toContain(`/${slugs.join("/")}.md)`);
    }
    expect(index).toContain("/privacy.md)");
  });

  it("lists the instructions for coding agents first in llms.txt", () => {
    const index = llmsIndex();
    const first = index.indexOf("## ");
    expect(index.slice(first)).toMatch(/^## Instructions for coding agents\n/);
    expect(index).toContain(`(${agentInstructionsUrl("install")})`);
    expect(index).toContain(`(${agentInstructionsUrl("submit")})`);
  });
});
