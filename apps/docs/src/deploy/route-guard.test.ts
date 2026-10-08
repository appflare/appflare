import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

// Opened at an app's install page, then sent to the deploy page by the router.
vi.mock("./arrival.ts", () => ({ openedAt: "/install/open-seo/" }));

const { requireDeployDocument } = await import("./route-guard.ts");

/** The redirect's options, as the router reads them. */
function thrown(run: () => void): { to?: unknown; href?: unknown; reloadDocument?: unknown } {
  try {
    run();
  } catch (error) {
    if (isRedirect(error)) return error.options as Record<string, unknown>;
    throw error;
  }
  throw new Error("no redirect");
}

describe("requireDeployDocument", () => {
  it("reloads the deploy page with its app, by href alone", () => {
    const options = thrown(() => requireDeployDocument("/deploy/", "?app=open-seo"));
    // With `to` set the router would rebuild the address from it and drop `?app=`.
    expect(options.to).toBeUndefined();
    expect(options.href).toBe("/deploy/?app=open-seo");
    expect(options.reloadDocument).toBe(true);
  });

  it("keeps nothing else of the query, and no app that is not one", () => {
    for (const search of ["", "?app=Open-SEO", "?app=a&app=b", "?utm_source=x"]) {
      const options = thrown(() => requireDeployDocument("/deploy/", search));
      expect(options.to).toBe("/deploy/");
      expect(options.href).toBeUndefined();
    }
    const kept = thrown(() => requireDeployDocument("/deploy/", "?utm_source=x&app=cut"));
    expect(kept.href).toBe("/deploy/?app=cut");
  });

  it("never carries an app to the callback", () => {
    const options = thrown(() => requireDeployDocument("/deploy/callback/", "?app=open-seo"));
    expect(options.to).toBe("/deploy/callback/");
    expect(options.href).toBeUndefined();
  });
});
