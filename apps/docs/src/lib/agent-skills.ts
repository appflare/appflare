import type { AgentPromptKind } from "./agent-prompts.ts";

/**
 * The agent instructions in `public/agent/`, published as Agent Skills
 * (https://agentskills.io) with a discovery index at
 * `/.well-known/agent-skills/index.json` (the Agent Skills Discovery RFC,
 * https://github.com/cloudflare/agent-skills-discovery-rfc). Each skill is the
 * instructions file under a `SKILL.md` front matter, so an agent that finds the
 * site can install it without anyone copying a prompt.
 *
 * This module only names the skills, so the Vite config can load it; their
 * files are worked out in `agent-skill-files.ts`.
 */

export const AGENT_SKILLS_PATH = "/.well-known/agent-skills/";

export const agentSkillsIndexPath = `${AGENT_SKILLS_PATH}index.json`;

export interface AgentSkill {
  /** The skill's name: lowercase letters, digits and hyphens. */
  name: string;
  /** What the skill does and when to use it, for the front matter and the index. */
  description: string;
  kind: AgentPromptKind;
}

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "install-appflare",
    description:
      "Install Appflare, a self-hosted app manager for Cloudflare, into the user's own Cloudflare account with the installer. Use when the user asks to install or set up Appflare.",
    kind: "install",
  },
  {
    name: "add-app-to-appflare-catalog",
    description:
      "Add an app to the Appflare catalog: write its catalog manifest, check it with the catalog's tooling, and open the pull request. Use when the user asks to list or submit an app to Appflare.",
    kind: "submit",
  },
];

export function findAgentSkill(name: string): AgentSkill | undefined {
  return AGENT_SKILLS.find((skill) => skill.name === name);
}

/** Where a skill's `SKILL.md` is served. */
export function agentSkillPath(name: string): string {
  return `${AGENT_SKILLS_PATH}${name}/SKILL.md`;
}
