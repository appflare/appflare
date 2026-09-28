import { describe, expect, it } from "vitest";
import headersFile from "../public/_headers?raw";

/**
 * The static assets' `_headers` file (copied into the build's client
 * directory, and sent with every deploy as the assets' header rules).
 */

/** The rules as Cloudflare reads them: a path, then its indented `Name: value` lines. */
function rules(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = new Map();
      out.set(line, current);
      continue;
    }
    const colon = line.indexOf(":");
    current?.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

describe("static asset headers", () => {
  it("lets browsers keep the content-hashed build files for a year", () => {
    const parsed = rules(headersFile);
    expect(parsed.get("/assets/*")?.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("leaves the page itself and everything else to be revalidated", () => {
    expect([...rules(headersFile).keys()]).toEqual(["/assets/*"]);
  });
});
