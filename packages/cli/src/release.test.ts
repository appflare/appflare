import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadAsset,
  findManagerRelease,
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
const release = (tag: string, extra: Partial<Release> = {}): Release => {
  const version = tag.replace(/^manager@/, "");
  return {
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
      await expect(downloadAsset(fetchFn, {}, asset("manifest.json", 4), dest)).rejects.toThrow(
        "is 3 bytes, expected 4",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
