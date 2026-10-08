import { describe, expect, it } from "vitest";
import worker, { type Env, type Fetcher } from "./index.ts";

function recorder(name: string, files: Record<string, string> = {}): Fetcher & { seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    async fetch(request) {
      seen.push(request);
      const { pathname } = new URL(request.url);
      const file = files[pathname];
      if (file !== undefined) {
        return new Response(file, { headers: { "Content-Type": "text/plain" } });
      }
      // A file the build did not write; a page (no extension) is always there.
      if (/\.\w+$/.test(pathname)) return new Response("not found", { status: 404 });
      return new Response(name, { headers: { "Content-Type": "text/html" } });
    },
  };
}

function env(
  files: Record<string, string> = {},
): Env & { ASSETS: { seen: Request[] }; INSTALLER: { seen: Request[] } } {
  return { ASSETS: recorder("assets", files), INSTALLER: recorder("installer") };
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
      const bindings = env({ "/api/search.json": "assets" });
      const response = await worker.fetch(new Request(`https://appflare.dev${path}`), bindings);
      expect(await response.text(), path).toBe("assets");
      expect(bindings.INSTALLER.seen, path).toEqual([]);
    }
  });

  it("answers a page asked for as Markdown with the page's Markdown", async () => {
    const files = { "/start/install.md": "# Install", "/llms.txt": "# Appflare" };
    for (const [path, body] of [
      ["/start/install/", "# Install"],
      ["/start/install", "# Install"],
      ["/", "# Appflare"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://appflare.dev${path}`, { headers: { Accept: "text/markdown" } }),
        env(files),
      );
      expect(await response.text(), path).toBe(body);
      expect(response.headers.get("Content-Type"), path).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("Vary"), path).toBe("Accept");
    }
  });

  it("answers HTML to a browser, and to a page without Markdown", async () => {
    const files = { "/start/install.md": "# Install" };
    for (const [path, accept] of [
      ["/start/install/", "text/html,application/xhtml+xml,*/*;q=0.8"],
      ["/apps/counterscale/", "text/markdown"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://appflare.dev${path}`, { headers: { Accept: accept } }),
        env(files),
      );
      expect(await response.text(), path).toBe("assets");
      expect(response.headers.get("Content-Type"), path).toBe("text/html");
      expect(response.headers.get("Vary"), path).toBe("Accept");
    }
  });
});
