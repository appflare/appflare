import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { siteCatalog } from "../catalog/data.ts";
import { Route } from "../routes/og/$.ts";
import { pngSize } from "./png-size.ts";

/** Requests `/og/<splat>` from the route, as the build does. */
async function get(splat: string): Promise<Response> {
  const handlers = Route.options.server?.handlers;
  const GET = typeof handlers === "object" && handlers !== null ? handlers.GET : undefined;
  if (typeof GET !== "function") throw new Error("The OpenGraph route has no GET handler");
  // The handler reads only the splat; the rest of the context is the framework's.
  // biome-ignore lint/suspicious/noExplicitAny: the full handler context is not needed here
  return (GET as (context: any) => Promise<Response>)({ params: { _splat: splat } });
}

const app = siteCatalog.apps[0];
const category = siteCatalog.categories[0];

describe("the OpenGraph image route", () => {
  if (app === undefined || category === undefined) throw new Error("The fixture has no apps");

  const kinds = {
    "the site": "image.png",
    "a docs page": "start/install/image.png",
    "the apps page": "apps/image.png",
    "an app": `apps/${app.slug}/image.png`,
    "an install page": `install/${app.slug}/image.png`,
    "a category": `categories/${category.id}/image.png`,
  };
  for (const [kind, splat] of Object.entries(kinds)) {
    it(`draws ${kind} as a 1200x630 PNG`, async () => {
      const response = await get(splat);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual({
        width: 1200,
        height: 630,
      });
    });
  }

  it("is not found for a path that names no page", async () => {
    for (const splat of [
      "apps/no-such-app/image.png",
      "start/install/other.png",
      "nowhere/image.png",
    ]) {
      const error = await get(splat).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(isNotFound(error)).toBe(true);
    }
  });
});
