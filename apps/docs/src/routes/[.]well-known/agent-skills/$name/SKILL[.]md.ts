import { createFileRoute, notFound } from "@tanstack/react-router";
import { agentSkillMarkdown } from "../../../../lib/agent-skill-files.ts";
import { findAgentSkill } from "../../../../lib/agent-skills.ts";

/** `/.well-known/agent-skills/<name>/SKILL.md`: one agent skill. */
export const Route = createFileRoute("/.well-known/agent-skills/$name/SKILL.md")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const skill = findAgentSkill(params.name);
        if (!skill) throw notFound();
        return new Response(agentSkillMarkdown(skill), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
