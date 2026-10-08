import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSkillMarkdown, agentSkillsIndex } from "./agent-skill-files.ts";
import { AGENT_SKILLS } from "./agent-skills.ts";

describe("the agent skills", () => {
  it("each have a SKILL.md with their name and description, then the instructions", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const markdown = agentSkillMarkdown(skill);
      expect(markdown.startsWith(`---\nname: ${skill.name}\ndescription: `)).toBe(true);
      expect(markdown).toContain("instructions for a coding agent");
    }
  });

  it("are listed in the index with the digest of the SKILL.md served", async () => {
    const index = await agentSkillsIndex();
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills.map((entry) => entry.name)).toEqual(AGENT_SKILLS.map((s) => s.name));
    for (const [i, skill] of AGENT_SKILLS.entries()) {
      const hex = createHash("sha256").update(agentSkillMarkdown(skill)).digest("hex");
      expect(index.skills[i]?.digest).toBe(`sha256:${hex}`);
    }
  });
});
