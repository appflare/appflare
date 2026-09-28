import { describe, expect, it } from "vitest";
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
    expect(full).not.toMatch(/<\/?(Callout|Cards|Card|Prompt)\b/);
  });

  it("leaves out MDX comments, which are notes for editors", async () => {
    const full = await docsLlms.full();
    expect(full).not.toContain("{/*");
  });

  it("writes a Callout as a blockquote led by its title", async () => {
    const text = await docsLlms.page(page("start", "install"));
    expect(text).toContain("> **Not on npm yet**\n>\n> The installer is not published to npm yet");
  });

  it("writes Cards as a list of links", async () => {
    const text = await docsLlms.page(page());
    expect(text).toContain(
      "- [Install Appflare](/start/install/): The three ways to install, the installer, and the setup wizard.",
    );
  });

  it("keeps a Prompt as its fenced code block", async () => {
    const text = await docsLlms.page(page("start", "install-with-an-agent"));
    expect(text).toMatch(/```text title="Prompt"\nHelp me install Appflare/);
  });

  it("lists every page in llms.txt, linked to its Markdown file", () => {
    const index = llmsIndex();
    for (const { slugs } of source.getPages()) {
      const path = slugs.length === 0 ? "index" : slugs.join("/");
      expect(index).toContain(`/${path}.md)`);
    }
  });
});
