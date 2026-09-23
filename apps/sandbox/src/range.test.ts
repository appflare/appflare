import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { parseRange, serveBuildObject } from "./range";

// BUILDS is a local R2 bucket simulated by Miniflare.

const KEY = "builds/i1/1.2.3/widget-1.2.3.zip";
const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

afterEach(() => reset());

function get(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://sandbox/${path}`, { method, headers });
}

describe("parseRange", () => {
  it("parses closed, open, and suffix ranges and clamps the end", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=95-500", 100)).toEqual({ offset: 95, length: 5 });
    expect(parseRange("bytes=-10", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-500", 100)).toEqual({ offset: 0, length: 100 });
  });

  it("ignores what it may ignore and refuses what cannot be satisfied", () => {
    for (const header of ["items=0-1", "bytes=0-1,5-6", "bytes=-", "bytes=9-3", "nonsense"]) {
      expect(parseRange(header, 100)).toBe("ignore");
    }
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });
});

describe("serveBuildObject", () => {
  it("answers a Range request with 206 and exactly those bytes", async () => {
    await env.BUILDS.put(KEY, BYTES);
    const response = await serveBuildObject(get(KEY, { range: "bytes=10-19" }), env.BUILDS);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it("answers a plain GET with the whole object and a HEAD with headers only", async () => {
    await env.BUILDS.put("builds/i1/1.2.3/manifest.json", '{"format":1}');
    const whole = await serveBuildObject(get("builds/i1/1.2.3/manifest.json"), env.BUILDS);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("application/json");
    expect(await whole.text()).toBe('{"format":1}');

    await env.BUILDS.put(KEY, BYTES);
    const head = await serveBuildObject(get(KEY, { range: "bytes=0-3" }, "HEAD"), env.BUILDS);
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.body).toBeNull();
  });

  it("answers 416 for a range past the end", async () => {
    await env.BUILDS.put(KEY, BYTES);
    const response = await serveBuildObject(get(KEY, { range: "bytes=100-" }), env.BUILDS);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
  });

  it("serves nothing to a request from the internet (one that carries cf)", async () => {
    await env.BUILDS.put(KEY, BYTES);
    const fromInternet = new Request(`https://sandbox/${KEY}`, {
      cf: { country: "US" },
    } as RequestInit<RequestInitCfProperties>);
    expect((await serveBuildObject(fromInternet, env.BUILDS)).status).toBe(404);
  });

  it("serves nothing outside builds/, whatever the bucket holds", async () => {
    await env.BUILDS.put("secret.txt", "no");
    await env.BUILDS.put("builds/../secret.txt", "no");
    for (const path of [
      "secret.txt",
      "builds/..%2Fsecret.txt",
      "builds/%2e%2e/secret.txt",
      "builds//x",
      "builds/",
    ]) {
      const response = await serveBuildObject(get(path), env.BUILDS);
      expect(response.status, path).toBe(404);
    }
    // URL parsing folds `builds/../secret.txt` to `/secret.txt`, which is refused too.
    expect((await serveBuildObject(get("builds/../secret.txt"), env.BUILDS)).status).toBe(404);
  });

  it("answers 404 for a missing object and 405 for other methods", async () => {
    expect((await serveBuildObject(get("builds/i1/none.zip"), env.BUILDS)).status).toBe(404);
    const post = await serveBuildObject(get(KEY, {}, "POST"), env.BUILDS);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("is what the Worker's fetch handler serves", async () => {
    await env.BUILDS.put(KEY, BYTES);
    const response = await exports.default.fetch(
      new Request(`https://sandbox/${KEY}`, { headers: { range: "bytes=98-99" } }),
    );
    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([98, 99]);
  });
});
