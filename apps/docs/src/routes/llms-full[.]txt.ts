import { createFileRoute } from "@tanstack/react-router";
import { docsLlms } from "../lib/source.ts";

/** `llms-full.txt`: every page's Markdown in one file. */
export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(await docsLlms.full(), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
