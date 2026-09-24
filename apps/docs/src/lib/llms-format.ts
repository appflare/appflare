/**
 * Text formats for agents, kept free of the content pipeline so they can be
 * tested on their own: `llms.txt` (https://llmstxt.org) and the Markdown file
 * of each page.
 */

export interface LlmsLink {
  title: string;
  description?: string | undefined;
  /** Absolute URL. */
  url: string;
}

export interface LlmsSection {
  title: string;
  links: LlmsLink[];
}

export interface LlmsIndex {
  title: string;
  summary: string;
  sections: LlmsSection[];
  /** Links under the conventional "Optional" heading: material an agent may skip. */
  optional: LlmsLink[];
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

function formatLink({ title, description, url }: LlmsLink): string {
  const link = `- [${escapeLinkText(title)}](${url})`;
  return description ? `${link}: ${description}` : link;
}

/** `llms.txt`: an H1, a one-paragraph summary, then H2 sections of links. */
export function formatLlmsIndex({ title, summary, sections, optional }: LlmsIndex): string {
  const lines = [`# ${title}`, "", `> ${summary}`, ""];
  for (const section of [...sections, { title: "Optional", links: optional }]) {
    if (section.links.length === 0) continue;
    lines.push(`## ${section.title}`, "", ...section.links.map(formatLink), "");
  }
  return lines.join("\n");
}

/** One page as Markdown: its title, canonical URL, and summary, then its content. */
export function formatPageMarkdown({
  title,
  description,
  url,
  content,
}: {
  title: string;
  description?: string | undefined;
  url: string;
  content: string;
}): string {
  const head = [`# ${title}`, "", `URL: ${url}`, ""];
  if (description) head.push(`> ${description}`, "");
  return `${head.join("\n")}\n${content.trim()}\n`;
}
