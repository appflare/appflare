import { describe, expect, it } from "vitest";
import { assetHash, buildAssetsManifest } from "./asset-hash";

describe("assetHash", () => {
  it("matches wrangler's blake3(base64(contents)+ext).slice(0,32) known vectors", () => {
    // Cross-checked byte-for-byte against wrangler 4.136.2's own blake3-wasm.
    expect(assetHash("hello world\n", "hello.txt")).toBe("64e86c1f4ec071b997f1a6af69931db3");
    expect(assetHash(new Uint8Array(), "empty.png")).toBe("bad7c9a32d645d0eb45be765104af05c");
  });

  it("folds the extension into the hash", () => {
    expect(assetHash("hello world\n", "a.txt")).not.toBe(assetHash("hello world\n", "a.md"));
  });

  it("accepts string, Uint8Array and ArrayBuffer equivalently", () => {
    const bytes = new TextEncoder().encode("hello world\n");
    const expected = "64e86c1f4ec071b997f1a6af69931db3";
    expect(assetHash(bytes, "x.txt")).toBe(expected);
    expect(assetHash(bytes.buffer, "x.txt")).toBe(expected);
  });
});

describe("buildAssetsManifest", () => {
  it("keys files by a normalized (leading-slash) route", () => {
    const manifest = buildAssetsManifest([
      { route: "/index.html", hash: "h1", size: 10 },
      { route: "css/app.css", hash: "h2", size: 20 },
    ]);
    expect(manifest).toEqual({
      "/index.html": { hash: "h1", size: 10 },
      "/css/app.css": { hash: "h2", size: 20 },
    });
  });
});
