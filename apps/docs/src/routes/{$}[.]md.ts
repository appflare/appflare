import { createFileRoute, notFound } from "@tanstack/react-router";
import { slugsFromMarkdownPath } from "../lib/shared.ts";
import { docsLlms, source } from "../lib/source.ts";

/** Each page as Markdown (`/start/install.md`), for agents and the "Copy Markdown" button. */
export const Route = createFileRoute("/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const page = source.getPage(slugsFromMarkdownPath(`${params._splat ?? ""}.md`));
        if (!page) throw notFound();
        return new Response(await docsLlms.page(page), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
