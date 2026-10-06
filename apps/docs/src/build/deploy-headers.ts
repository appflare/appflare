import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Response headers for the deploy page and its OAuth callback, written into
 * the built `_headers` once the pages are prerendered.
 *
 * Those pages hold Cloudflare tokens in the browser, so they get a strict
 * Content-Security-Policy: scripts only from the site itself, plus the few
 * inline scripts the framework writes into every page (the theme switch,
 * scroll restoration and the router's hydration data), each allowed by its
 * SHA-256 rather than by allowing inline script. Those scripts are fixed when
 * the page is built, so the hashes are read from the built pages. Requests
 * may go to the site itself (the hosted installer's API), Cloudflare's
 * OAuth token endpoint, and any https address, since the new Appflare's
 * address is chosen at run time. No frames, no plugins, no referrer.
 *
 * Each page gets its own rule for its exact path, so a missing page under
 * /deploy/ is answered with the site's ordinary 404 and headers. Forms on the
 * deploy page go nowhere but the site itself; the callback posts a manager's
 * Reconnect Cloudflare back to that manager, at an https address (or a local
 * one while developing).
 *
 * The rule for every page (`/*`) also sets `frame-ancestors 'none'`;
 * Workers static assets joins both values with a comma, which browsers
 * enforce as two policies, both applying.
 */

export interface DeployPage {
  /** The path the rule matches, exactly. */
  path: string;
  /** The prerendered file, relative to the client output. */
  file: string;
  /** Where its forms may be sent. */
  formAction: string;
}

export const DEPLOY_PAGES: readonly DeployPage[] = [
  { path: "/deploy/", file: "deploy/index.html", formAction: "'self'" },
  {
    path: "/deploy/callback",
    file: "deploy/callback.html",
    formAction: "https: http://localhost:* http://127.0.0.1:*",
  },
];

/** Cloudflare's OAuth token endpoint, where the browser exchanges and renews. */
export const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";

/** Every inline script's content in `html` (not the ones with a `src`). */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attributes = "", body = ""] = match;
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (body.length === 0) continue;
    scripts.push(body);
  }
  return scripts;
}

/**
 * The text a browser hashes for an inline script: what the HTML parser
 * makes of the bytes in the file. It turns CR and CRLF into LF, and a NUL
 * in script data into U+FFFD. The router's hydration data contains NULs
 * (its match ids use them as separators), so hashing the file's bytes as
 * they are would allow a script the browser never sees.
 */
export function parsedScriptText(body: string): string {
  return body.replace(/\r\n?/g, "\n").replaceAll("\0", "�");
}

/** The CSP source for one inline script, as it is in the file. */
export function scriptHash(body: string): string {
  const text = parsedScriptText(body);
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** The policy for a deploy page, given the hashes of its inline scripts. */
export function deployPolicy(hashes: readonly string[], formAction = "'self'"): string {
  return [
    "default-src 'none'",
    ["script-src 'self'", ...[...new Set(hashes)].sort()].join(" "),
    // Inline style attributes come from the UI library; they cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${TOKEN_ENDPOINT} https:`,
    "manifest-src 'self'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The `_headers` rule for one deploy page. */
export function deployHeadersRule(path: string, policy: string): string {
  return [
    "",
    "# Written by the build, with the hashes of the page's inline scripts:",
    "# see src/build/deploy-headers.ts.",
    path,
    `  Content-Security-Policy: ${policy}`,
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "",
  ].join("\n");
}

/** Appends each deploy page's rule to `_headers` in `outDir`, from the pages built there. */
export async function writeDeployHeaders(outDir: string): Promise<Record<string, string>> {
  const policies: Record<string, string> = {};
  let rules = "";
  for (const page of DEPLOY_PAGES) {
    const html = await readFile(resolve(outDir, page.file), "utf8");
    const policy = deployPolicy(inlineScripts(html).map(scriptHash), page.formAction);
    policies[page.path] = policy;
    rules += deployHeadersRule(page.path, policy);
  }
  await appendFile(resolve(outDir, "_headers"), rules);
  return policies;
}

/** The build step: after prerendering, before deploying. Fails the build if a page is missing. */
export function deployHeaders(): Plugin {
  return {
    name: "appflare-deploy-headers",
    apply: "build",
    enforce: "post",
    buildApp: {
      order: "post",
      async handler(viteBuilder) {
        const client = viteBuilder.environments.client;
        if (!client) throw new Error('Vite\'s "client" environment is missing');
        const outDir = resolve(viteBuilder.config.root, client.config.build.outDir);
        await writeDeployHeaders(outDir);
        viteBuilder.config.logger.info("Wrote the deploy pages' Content-Security-Policy");
      },
    },
  };
}
