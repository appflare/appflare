import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { NOT_FOUND_MODE } from "./router-not-found";

/**
 * Unknown addresses against a route tree of the manager's shape: the root, the
 * pathless signed-in layout (`/_app`, with a `beforeLoad` and a loader), and
 * pages under it with and without parameters. The real tree only builds
 * under TanStack Start's Vite plugin, so it is mirrored here.
 */

function tree() {
  const calls: string[] = [];
  const root = createRootRoute({});
  const app = createRoute({
    getParentRoute: () => root,
    id: "_app",
    beforeLoad: () => {
      calls.push("_app beforeLoad");
      return { viewer: { role: "admin" } };
    },
    loader: () => {
      calls.push("_app loader");
      return { apps: [] };
    },
  });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => app,
      path,
      loader: () => {
        calls.push(`${path} loader`);
        return {};
      },
    });
  const login = createRoute({ getParentRoute: () => root, path: "/login" });
  const routeTree = root.addChildren([
    login,
    app.addChildren([
      page("/"),
      page("/apps/$installId"),
      page("/catalog/"),
      page("/catalog/$slug"),
      page("/catalog/source/$buildId"),
      page("/jobs/$jobId"),
      page("/settings/"),
      page("/settings/account"),
    ]),
  ]);
  return { routeTree, calls };
}

async function load(
  path: string,
  options: { notFoundMode?: "root" | "fuzzy"; client?: boolean } = {},
) {
  const { routeTree, calls } = tree();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    notFoundMode: options.notFoundMode ?? NOT_FOUND_MODE,
    // The browser's code path (the manager renders as a single-page app).
    ...(options.client === true ? { isServer: false, origin: "http://localhost" } : {}),
  });
  await router.load();
  const matches = router.state.matches;
  return {
    calls,
    boundary: matches.find((m) => m._notFound === true)?.routeId ?? null,
    rendered: matches
      .filter((m) => m.status === "success" && m._notFound !== true)
      .map((m) => m.routeId),
  };
}

const UNKNOWN = [
  "/nonexistent",
  "/apps/i1/foo",
  "/apps/i1/foo/bar",
  "/catalog/a/b",
  "/catalog/source/b1/x",
  "/jobs/j1/x",
  "/settings/nope",
];

describe("unknown addresses", () => {
  for (const client of [false, true]) {
    it.each(UNKNOWN)(
      `%s is answered by the root route alone (${client ? "browser" : "server"})`,
      async (path) => {
        const r = await load(path, { client });
        expect(r.boundary).toBe("__root__");
        // Nothing below the root runs or renders: no session check, no page data.
        expect(r.calls).toEqual([]);
        expect(r.rendered).toEqual([]);
      },
    );
  }

  it("leaves known addresses to their pages", async () => {
    const r = await load("/apps/i1", { client: true });
    expect(r.boundary).toBeNull();
    expect(r.rendered).toEqual(["__root__", "/_app", "/_app/apps/$installId"]);
    expect(r.calls).toEqual(["_app beforeLoad", "_app loader", "/apps/$installId loader"]);
  });

  it("would otherwise answer from the signed-in layout", async () => {
    // TanStack Router's default: the deepest matching layout renders the
    // not-found view in its own outlet, so the layout itself renders.
    const r = await load("/apps/i1/foo", { notFoundMode: "fuzzy" });
    expect(r.boundary).toBe("/_app");
  });
});
