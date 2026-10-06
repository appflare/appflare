import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployPolicy,
  inlineScripts,
  scriptHash,
  TOKEN_ENDPOINT,
  writeDeployHeaders,
} from "./deploy-headers.ts";

const page = (body: string) =>
  `<!DOCTYPE html><html><head><script>theme()</script><link rel="modulepreload" href="/assets/a.js"/></head><body>${body}<script type="module" async="" src="/assets/index.js"></script><script data-tsr-stream-part="">self.$_TSR={}</script></body></html>`;

describe("inlineScripts", () => {
  it("finds the inline scripts and skips the ones loaded from a file", () => {
    expect(inlineScripts(page("<p>x</p>"))).toEqual(["theme()", "self.$_TSR={}"]);
  });
});

describe("scriptHash", () => {
  const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

  it("hashes the script as the browser parses it: NUL becomes U+FFFD, CR and CRLF become LF", () => {
    // The router's hydration data separates match ids with NUL.
    expect(scriptHash('{i:"__root__\0"}')).toBe(sha('{i:"__root__�"}'));
    expect(scriptHash("a\r\nb\rc")).toBe(sha("a\nb\nc"));
    expect(scriptHash("plain()")).toBe(sha("plain()"));
  });
});

describe("deployPolicy", () => {
  const policy = deployPolicy([scriptHash("a"), scriptHash("b"), scriptHash("a")]);
  const directives = new Map(
    policy.split("; ").map((d) => {
      const [name = "", ...values] = d.split(" ");
      return [name, values] as const;
    }),
  );

  it("allows scripts from the site and the hashed inline scripts only", () => {
    const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    expect(directives.get("script-src")).toEqual(["'self'", ...[sha("a"), sha("b")].sort()]);
    expect(directives.get("script-src")).not.toContain("'unsafe-inline'");
    expect(directives.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("lets the page reach only itself, the token endpoint and https addresses", () => {
    expect(directives.get("connect-src")).toEqual(["'self'", TOKEN_ENDPOINT, "https:"]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
  });

  it("cannot be framed, has no base URL to hijack and sends forms only to itself", () => {
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
  });
});

describe("writeDeployHeaders", () => {
  it("appends one rule per deploy page, for its exact path, hashing that page's scripts", async () => {
    const out = await mkdtemp(join(tmpdir(), "deploy-headers-"));
    await mkdir(join(out, "deploy"));
    await writeFile(join(out, "deploy/index.html"), page("deploy"));
    await writeFile(
      join(out, "deploy/callback.html"),
      page("<script>document.currentScript.remove()</script>"),
    );
    await writeFile(join(out, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    const policies = await writeDeployHeaders(out);
    const headers = await readFile(join(out, "_headers"), "utf8");
    expect(headers.startsWith("/*\n  X-Frame-Options: DENY\n")).toBe(true);
    // Exact paths: a missing page under /deploy/ keeps the site's own headers.
    expect(headers).not.toContain("/deploy/*");
    expect(headers).toContain("\n/deploy/\n  Content-Security-Policy: default-src 'none'; ");
    expect(headers).toContain(
      "\n/deploy/callback\n  Content-Security-Policy: default-src 'none'; ",
    );
    expect(headers.split("  Referrer-Policy: no-referrer\n")).toHaveLength(3);
    const callbackScript = scriptHash("document.currentScript.remove()");
    expect(policies["/deploy/callback"]).toContain(callbackScript);
    expect(policies["/deploy/"]).not.toContain(callbackScript);
    expect(policies["/deploy/"]).toContain(scriptHash("theme()"));
    // The deploy page posts nowhere but itself; the callback returns a
    // reconnect to the manager's own address.
    expect(policies["/deploy/"]).toContain("form-action 'self';");
    expect(policies["/deploy/callback"]).toContain(
      "form-action https: http://localhost:* http://127.0.0.1:*;",
    );
    for (const line of headers.split("\n")) expect(line.length).toBeLessThan(2000);
  });

  it("fails when a deploy page was not built", async () => {
    const out = await mkdtemp(join(tmpdir(), "deploy-headers-"));
    await expect(writeDeployHeaders(out)).rejects.toThrow();
  });
});
