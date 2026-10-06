import { describe, expect, it } from "vitest";
import { agentInstructionsUrl } from "./lib/agent-prompts.ts";
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
    const text = await docsLlms.page(page("start", "install"));
    expect(text).toContain(
      "> **Nothing to install on your computer**\n>\n> Two ways work entirely in your browser.",
    );
  });

  it("writes Cards as a list of links", async () => {
    const text = await docsLlms.page(page("start", "overview"));
    expect(text).toContain(
      "- [Run the installer](/start/install/): Run `npx create-appflare` in a terminal on your computer.",
    );
  });

  it("writes an agent prompt as the address of the instructions it points at", async () => {
    const install = await docsLlms.page(page("start", "install"));
    expect(install).toContain(`its instructions are at ${agentInstructionsUrl("install")}.`);
    const submit = await docsLlms.page(page("catalog", "submit"));
    expect(submit).toContain(`its instructions are at ${agentInstructionsUrl("submit")}.`);
    expect(install).not.toContain("Copy prompt");
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
