import { SITE_URL } from "./shared.ts";

/**
 * The prompts a visitor copies into a coding agent. Each is two sentences
 * that name one Markdown file on this site; the file holds the steps, so the
 * prompt stays short enough to read before pasting, and the steps can change
 * without anyone copying a new prompt. The files live in `public/agent/` and
 * are served as they are.
 */
export const AGENT_PROMPTS = {
  install: {
    /** Where the instructions are served, on this site. */
    path: "/agent/install.md",
    /** The page the prompt belongs to, which replaced a page of its own. */
    page: "/start/install/",
    text: (url: string) =>
      `Install Appflare into my Cloudflare account. Read ${url} and follow it exactly.`,
  },
  submit: {
    path: "/agent/submit.md",
    page: "/catalog/submit/",
    text: (url: string) =>
      `Add an app to the Appflare catalog and open the pull request. Read ${url} and follow it exactly.`,
  },
} as const satisfies Record<
  string,
  { path: `/agent/${string}.md`; page: string; text: (url: string) => string }
>;

export type AgentPromptKind = keyof typeof AGENT_PROMPTS;

/** The absolute URL of a prompt's instructions, on the public address. */
export function agentInstructionsUrl(kind: AgentPromptKind): string {
  return `${SITE_URL}${AGENT_PROMPTS[kind].path}`;
}

/** The text the copy button puts on the clipboard. */
export function agentPrompt(kind: AgentPromptKind): string {
  return AGENT_PROMPTS[kind].text(agentInstructionsUrl(kind));
}
