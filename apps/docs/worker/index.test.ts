import { describe, expect, it } from "vitest";
import worker, { type Env, type Fetcher } from "./index.ts";

function recorder(name: string): Fetcher & { seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    async fetch(request) {
      seen.push(request);
      return new Response(name);
    },
  };
}

function env(): Env & { ASSETS: { seen: Request[] }; INSTALLER: { seen: Request[] } } {
  return { ASSETS: recorder("assets"), INSTALLER: recorder("installer") };
}

describe("the site's Worker", () => {
  it("hands /api/install/* to the installer, the request itself, unchanged", async () => {
    const bindings = env();
    const request = new Request("https://appflare.dev/api/install/accounts", {
      method: "POST",
      headers: { authorization: "Bearer access-token-value", "content-type": "application/json" },
      body: "{}",
    });
    const response = await worker.fetch(request, bindings);
    expect(await response.text()).toBe("installer");
    expect(bindings.INSTALLER.seen).toEqual([request]);
    expect(bindings.ASSETS.seen).toEqual([]);
  });

  it("serves everything else from the static files", async () => {
    for (const path of ["/", "/deploy/", "/api/search.json", "/api/install", "/api/installer/x"]) {
      const bindings = env();
      const response = await worker.fetch(new Request(`https://appflare.dev${path}`), bindings);
      expect(await response.text(), path).toBe("assets");
      expect(bindings.INSTALLER.seen, path).toEqual([]);
    }
  });
});
