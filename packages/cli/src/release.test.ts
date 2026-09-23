import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadAsset,
  findManagerRelease,
  mayReceiveToken,
  pickLatestManagerRelease,
  type Release,
  releaseApiUrl,
  selectReleaseAssets,
} from "./release.ts";

const asset = (name: string, size = 3) => ({
  name,
  url: `https://api.github.com/repos/appflare/appflare/releases/assets/${name}`,
  size,
});
let nextId = 1;
const release = (tag: string, extra: Partial<Release> = {}): Release => {
  const version = tag.replace(/^manager@/, "");
  return {
    id: nextId++,
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [asset(`appflare-${version}.zip`), asset("manifest.json"), asset("manifest.sig")],
    ...extra,
  };
};

describe("release selection", () => {
  it("builds the API URLs", () => {
    expect(releaseApiUrl()).toBe(
      "https://api.github.com/repos/appflare/appflare/releases?per_page=100",
    );
    expect(releaseApiUrl("0.2.0")).toBe(
      "https://api.github.com/repos/appflare/appflare/releases/tags/manager%400.2.0",
    );
  });

  it("picks the newest published manager release", () => {
    const picked = pickLatestManagerRelease([
      release("@appflare/cli@0.3.0"),
      release("manager@0.3.0", { draft: true }),
      release("manager@0.3.0-rc.1", { prerelease: true }),
      release("manager@0.2.0"),
      release("manager@0.1.0"),
    ]);
    expect(picked.tag_name).toBe("manager@0.2.0");
  });

  it("fails when there is no manager release", () => {
    expect(() => pickLatestManagerRelease([release("other@1.0.0")])).toThrow(
      "no published manager release",
    );
  });

  it("selects the three assets by name", () => {
    const selected = selectReleaseAssets({
      ...release("manager@0.2.0"),
      assets: [asset("notes.txt"), ...release("manager@0.2.0").assets],
    });
    expect(selected.version).toBe("0.2.0");
    expect(selected.zip.name).toBe("appflare-0.2.0.zip");
    expect(selected.manifest.name).toBe("manifest.json");
    expect(selected.signature.name).toBe("manifest.sig");
  });

  it("fails when an asset is missing", () => {
    const r = release("manager@0.2.0");
    r.assets = r.assets.filter((a) => a.name !== "manifest.sig");
    expect(() => selectReleaseAssets(r)).toThrow("has no manifest.sig asset");
  });

  it("looks up a pinned version and reports a missing one", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return url.endsWith("0.2.0")
        ? Response.json(release("manager@0.2.0"))
        : new Response("not found", { status: 404 });
    };
    expect((await findManagerRelease(fetchFn, {}, "0.2.0")).tag).toBe("manager@0.2.0");
    await expect(findManagerRelease(fetchFn, {}, "9.9.9")).rejects.toThrow(
      "no manager release manager@9.9.9",
    );
    await expect(findManagerRelease(fetchFn, {}, "9.9.9")).rejects.toThrow("may be private");
  });

  it("explains a 404 on the release list as a possibly private repository", async () => {
    const fetchFn = async () => new Response("Not Found", { status: 404 });
    await expect(findManagerRelease(fetchFn, {})).rejects.toThrow(
      /GitHub answered 404 for the releases of appflare\/appflare\. The repository appflare\/appflare may be private.*GITHUB_TOKEN=\$\(gh auth token\) npx create-appflare/,
    );
    await expect(findManagerRelease(fetchFn, { GITHUB_TOKEN: "t" })).rejects.toThrow(
      "GITHUB_TOKEN is set; check that it can read appflare/appflare",
    );
  });

  it("fetches the assets by release id when a fresh release lists none", async () => {
    const fresh = release("manager@0.3.0", { assets: [] });
    const full = release("manager@0.3.0").assets;
    const urls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
      return url.includes(`/releases/${fresh.id}/assets`)
        ? Response.json(full)
        : Response.json([fresh, release("manager@0.2.0")]);
    };
    const warnings: string[] = [];
    const picked = await findManagerRelease(fetchFn, { GITHUB_TOKEN: "t" }, undefined, (m) =>
      warnings.push(m),
    );
    expect(picked.tag).toBe("manager@0.3.0");
    expect(urls[1]).toBe(
      `https://api.github.com/repos/appflare/appflare/releases/${fresh.id}/assets?per_page=100`,
    );
    expect(warnings).toEqual([]);
  });

  it("falls back to the previous complete release, with a warning", async () => {
    const fresh = release("manager@0.3.0", { assets: [asset("manifest.json")] });
    const fetchFn = async (url: string, _init?: RequestInit) =>
      url.includes("/assets")
        ? Response.json([asset("manifest.json")])
        : Response.json([
            release("@appflare/cli@0.4.0"),
            release("manager@0.4.0", { draft: true }),
            fresh,
            release("manager@0.3.1-rc.1", { prerelease: true }),
            release("other@0.2.5"),
            release("manager@0.2.0"),
          ]);
    const warnings: string[] = [];
    const urls: string[] = [];
    const picked = await findManagerRelease(
      async (url, init) => {
        urls.push(url);
        return fetchFn(url, init);
      },
      {},
      undefined,
      (m) => warnings.push(m),
    );
    expect(picked.tag).toBe("manager@0.2.0");
    // Only the incomplete manager@0.3.0 had its assets fetched; the draft, the
    // pre-release, and the other tags were never considered.
    expect(urls).toEqual([
      "https://api.github.com/repos/appflare/appflare/releases?per_page=100",
      `https://api.github.com/repos/appflare/appflare/releases/${fresh.id}/assets?per_page=100`,
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("manager@0.3.0 is still being published");
    expect(warnings[0]).toContain("installing manager@0.2.0 instead");
  });

  it("fails when no release is complete, and when a pinned one is incomplete", async () => {
    const empty = release("manager@0.3.0", { assets: [] });
    const fetchFn = async (url: string) =>
      url.includes("/assets")
        ? Response.json([])
        : url.includes("/tags/")
          ? Response.json(empty)
          : Response.json([empty]);
    await expect(findManagerRelease(fetchFn, {})).rejects.toThrow("still being published");
    await expect(findManagerRelease(fetchFn, {}, "0.3.0")).rejects.toThrow(
      "release manager@0.3.0 has no appflare-0.3.0.zip asset",
    );
  });

  it("sends GITHUB_TOKEN only when set", async () => {
    const seen: (string | null)[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json([release("manager@0.1.0")]);
    };
    await findManagerRelease(fetchFn, {});
    await findManagerRelease(fetchFn, { GITHUB_TOKEN: "t0ken" });
    expect(seen).toEqual([null, "Bearer t0ken"]);
  });
});

describe("mayReceiveToken", () => {
  it("allows only https://api.github.com", () => {
    expect(mayReceiveToken("https://api.github.com/repos/a/b/releases/assets/1")).toBe(true);
    for (const url of [
      "http://api.github.com/x",
      "https://api.github.com.evil.example/x",
      "https://evil.example/api.github.com",
      "https://api.github.com:8443/x",
      "https://objects.githubusercontent.com/x",
      "not a url",
    ]) {
      expect(mayReceiveToken(url)).toBe(false);
    }
  });

  it("does not send the token to an asset URL on another host", async () => {
    const seen: (string | null)[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("abc");
    };
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-cli-dl-"));
    try {
      const dest = path.join(dir, "f");
      await downloadAsset(fetchFn, { GITHUB_TOKEN: "t" }, asset("manifest.json"), dest);
      await downloadAsset(
        fetchFn,
        { GITHUB_TOKEN: "t" },
        { name: "manifest.json", url: "https://evil.example/manifest.json", size: 3 },
        dest,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual(["Bearer t", null]);
  });
});

describe("downloadAsset", () => {
  it("writes the body and checks the size", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-cli-dl-"));
    try {
      const fetchFn = async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("accept")).toBe("application/octet-stream");
        return new Response("abc");
      };
      const dest = path.join(dir, "manifest.json");
      await downloadAsset(fetchFn, {}, asset("manifest.json", 3), dest);
      expect(readFileSync(dest, "utf8")).toBe("abc");
      const denied = async () => new Response("Not Found", { status: 404 });
      await expect(downloadAsset(denied, {}, asset("manifest.json", 3), dest)).rejects.toThrow(
        "may be private",
      );
      await expect(downloadAsset(fetchFn, {}, asset("manifest.json", 4), dest)).rejects.toThrow(
        "is 3 bytes, expected 4",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
