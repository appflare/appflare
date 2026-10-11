import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "../components/not-found.tsx";
import { notFoundHead } from "../lib/meta.ts";

/**
 * Prerendered to `/404.html`, which Workers static assets serves, with status
 * 404, for every path that matches no file.
 */
export const Route = createFileRoute("/404")({
  head: () => notFoundHead,
  component: NotFound,
});
