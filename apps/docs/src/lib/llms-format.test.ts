import { describe, expect, it } from "vitest";
import { formatLlmsIndex, formatPageMarkdown } from "./llms-format.ts";

describe("formatLlmsIndex", () => {
  it("escapes link syntax in descriptions as well as titles", () => {
    const text = formatLlmsIndex({
      title: "Appflare",
      summary: "An app manager.",
      sections: [
        {
          title: "Apps",
          links: [
            {
              title: "Cut",
              description: "See [here](https://evil.example)",
              url: "https://d/cut/",
            },
          ],
        },
      ],
      optional: [],
    });
    expect(text).toContain("- [Cut](https://d/cut/): See \\[here\\](https://evil.example)");
  });

  it("writes the llms.txt layout: title, summary, sections of links, then Optional", () => {
    const text = formatLlmsIndex({
      title: "Appflare",
      summary: "An app manager.",
      sections: [
        {
          title: "Getting started",
          links: [
            { title: "Install [beta]", description: "The installer.", url: "https://d/install.md" },
            { title: "FAQ", url: "https://d/faq.md" },
          ],
        },
        { title: "Empty", links: [] },
      ],
      optional: [{ title: "Full text", url: "https://d/llms-full.txt" }],
    });
    expect(text).toBe(
      [
        "# Appflare",
        "",
        "> An app manager.",
        "",
        "## Getting started",
        "",
        "- [Install \\[beta\\]](https://d/install.md): The installer.",
        "- [FAQ](https://d/faq.md)",
        "",
        "## Optional",
        "",
        "- [Full text](https://d/llms-full.txt)",
        "",
      ].join("\n"),
    );
  });
});

describe("formatPageMarkdown", () => {
  it("puts the title, URL, and summary before the content", () => {
    expect(
      formatPageMarkdown({
        title: "FAQ",
        description: "Questions.",
        url: "https://d/faq/",
        content: "\n## One\n\nText.\n\n",
      }),
    ).toBe("# FAQ\n\nURL: https://d/faq/\n\n> Questions.\n\n## One\n\nText.\n");
  });

  it("leaves out a missing summary", () => {
    expect(formatPageMarkdown({ title: "FAQ", url: "https://d/faq/", content: "Text." })).toBe(
      "# FAQ\n\nURL: https://d/faq/\n\nText.\n",
    );
  });
});
