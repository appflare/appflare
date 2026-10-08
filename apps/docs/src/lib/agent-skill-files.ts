import installInstructions from "../../public/agent/install.md?raw";
import submitInstructions from "../../public/agent/submit.md?raw";
import type { AgentPromptKind } from "./agent-prompts.ts";
import { AGENT_SKILLS, type AgentSkill, agentSkillPath } from "./agent-skills.ts";
import { SITE_URL } from "./shared.ts";

/** The files of the agent skills named in `agent-skills.ts`: each `SKILL.md` and the index. */

const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const INSTRUCTIONS: Record<AgentPromptKind, string> = {
  install: installInstructions,
  submit: submitInstructions,
};

/** A skill's `SKILL.md`: the front matter, then its instructions file as it is. */
export function agentSkillMarkdown(skill: AgentSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    INSTRUCTIONS[skill.kind],
  ].join("\n");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The discovery index: each skill with its address and the digest of its `SKILL.md`. */
export async function agentSkillsIndex() {
  return {
    $schema: DISCOVERY_SCHEMA,
    skills: await Promise.all(
      AGENT_SKILLS.map(async (skill) => ({
        name: skill.name,
        type: "skill-md",
        description: skill.description,
        url: `${SITE_URL}${agentSkillPath(skill.name)}`,
        digest: `sha256:${await sha256(agentSkillMarkdown(skill))}`,
      })),
    ),
  };
}
