import { createFileRoute } from "@tanstack/react-router";
import { agentSkillsIndex } from "../../../lib/agent-skill-files.ts";

/** `/.well-known/agent-skills/index.json`: the Agent Skills discovery index. */
export const Route = createFileRoute("/.well-known/agent-skills/index.json")({
  server: {
    handlers: {
      GET: async () =>
        new Response(`${JSON.stringify(await agentSkillsIndex(), null, 2)}\n`, {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    },
  },
});
