import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPTS,
  type AgentPromptKind,
  agentInstructionsUrl,
  agentPrompt,
} from "./agent-prompts.ts";
import { SITE_URL } from "./shared.ts";
import { source } from "./source.ts";

const kinds = Object.keys(AGENT_PROMPTS) as AgentPromptKind[];
const publicFile = (path: string) => new URL(`../../public${path}`, import.meta.url);

describe("the prompts for coding agents", () => {
  it.each(kinds)("%s: two sentences that name the instructions on the public address", (kind) => {
    const prompt = agentPrompt(kind);
    expect(agentInstructionsUrl(kind)).toBe(`${SITE_URL}/agent/${kind}.md`);
    expect(prompt).toContain(` ${agentInstructionsUrl(kind)} `);
    expect(prompt).toMatch(/follow it exactly\.$/);
    expect(prompt.split(/\.\s/).length).toBe(2);
  });

  it("the install prompt reads as the site shows it", () => {
    expect(agentPrompt("install")).toBe(
      "Install Appflare into my Cloudflare account. Read https://appflare.dev/agent/install.md and follow it exactly.",
    );
  });

  it.each(kinds)("%s: belongs to a docs page that exists", (kind) => {
    const slugs = AGENT_PROMPTS[kind].page.split("/").filter(Boolean);
    expect(source.getPage(slugs)).toBeDefined();
  });
});

describe("the instructions the prompts point at", () => {
  it.each(kinds)("%s: are a file the site serves as it is", (kind) => {
    expect(existsSync(publicFile(AGENT_PROMPTS[kind].path))).toBe(true);
  });

  it.each(kinds)("%s: are plain Markdown with numbered steps, for an agent", (kind) => {
    const text = readFileSync(publicFile(AGENT_PROMPTS[kind].path), "utf8");
    expect(text).toMatch(/^# .+\n/);
    expect(text).toContain("\n## Rules for the whole session\n");
    expect(text).toContain("\n## Steps\n\n1. ");
    expect(text).toMatch(/\n2\. /);
    // No page chrome, components or HTML outside code.
    const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    expect(prose).not.toMatch(/<\/?[A-Za-z][\w-]*[\s/>]/);
    expect(text).not.toContain("Copy prompt");
  });

  it("tell the agent never to take secrets in the chat", () => {
    const install = readFileSync(publicFile(AGENT_PROMPTS.install.path), "utf8");
    expect(install).toContain("never accept one in the chat");
    expect(install).toContain("never run `npx create-appflare`");
  });
});
