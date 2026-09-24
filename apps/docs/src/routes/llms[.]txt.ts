import { createFileRoute } from "@tanstack/react-router";
import { llmsIndex } from "../lib/llms.ts";

/** `llms.txt`: the site's pages as a Markdown index (https://llmstxt.org). */
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(llmsIndex(), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
