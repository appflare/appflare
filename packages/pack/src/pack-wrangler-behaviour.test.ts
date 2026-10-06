import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.ts";
import { pack } from "./pack.ts";
import { UnknownWranglerKeyError, UnsupportedSectionError } from "./wrangler-config.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "hello");

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-wrangler-"));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/**
 * The hello fixture copied to `<parent>/checkout/<subdir>`, its wrangler
 * config merged with `extra` and its catalog manifest (at the checkout root,
 * naming that config) edited by `catalog`.
 */
function checkout(
  extra: Record<string, unknown>,
  options: { subdir?: string; catalog?: (manifest: Record<string, unknown>) => void } = {},
): { dir: string; configDir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  const subdir = options.subdir ?? ".";
  const configDir = path.join(dir, subdir);
  cpSync(FIXTURE, configDir, { recursive: true });
  const configPath = path.join(configDir, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, ...extra }));
  const manifest = parseJsonc(
    readFileSync(path.join(configDir, "appflare.jsonc"), "utf8"),
  ) as Record<string, unknown> & { install: Record<string, unknown> };
  manifest.install.wranglerConfig = path.posix.join(subdir, "wrangler.jsonc");
  options.catalog?.(manifest);
  const manifestPath = path.join(dir, "appflare.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { dir, configDir, manifest: manifestPath };
}

function packed(c: { dir: string; manifest: string }) {
  return pack({
    checkoutDir: c.dir,
    manifestPath: c.manifest,
    outDir: path.join(parent, "out"),
    install: false,
  });
}

describe("module types follow the config's module rules, as wrangler uploads them", () => {
  it("types a module by the rule that matched it, not by its extension", async () => {
    const c = checkout({
      rules: [
        // Text for SVGs, and the default Text rule (txt, html, sql) still applies...
        { type: "Text", globs: ["**/*.svg"], fallthrough: true },
        // ...but a Data rule comes first for .txt, so wrangler uploads notes as bytes.
        { type: "Data", globs: ["**/*.txt"] },
      ],
    });
    writeFileSync(path.join(c.configDir, "src", "logo.svg"), "<svg/>");
    writeFileSync(path.join(c.configDir, "src", "notes.txt"), "notes");
    writeFileSync(path.join(c.configDir, "src", "page.html"), "<p>hi</p>");
    writeFileSync(
      path.join(c.configDir, "src", "index.ts"),
      'import logo from "./logo.svg";\nimport notes from "./notes.txt";\nimport page from "./page.html";\n' +
        "export default { fetch: () => new Response(logo + page + new Uint8Array(notes).length) };\n",
    );
    const res = await packed(c);
    const types = res.manifest.worker.modules.map((m) => [
      m.name.replace(/^[0-9a-f]{40}-/, "<hash>-"),
      m.type,
    ]);
    expect(types[0]).toEqual(["index.js", "esm"]);
    expect(types.slice(1).sort()).toEqual([
      ["<hash>-logo.svg", "text"],
      ["<hash>-notes.txt", "data"],
      ["<hash>-page.html", "text"],
    ]);
    // The name is the one the bundle imports, without wrangler's leading "./".
    const svg = res.manifest.worker.modules.find((m) => m.name.endsWith("-logo.svg"));
    expect(svg?.path).toBe(`worker/${svg?.name}`);
  }, 120_000);
});

describe("the config's build.command", () => {
  it("runs in the config's own directory, as the app runs wrangler", async () => {
    const c = checkout(
      { main: "dist/index.js", build: { command: "node build.mjs" } },
      { subdir: "apps/api" },
    );
    // Only apps/api has build.mjs; it writes dist/index.js where it runs.
    writeFileSync(
      path.join(c.configDir, "build.mjs"),
      'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\n' +
        'writeFileSync("dist/index.js", "export default { fetch: () => new Response(\\"built\\") };\\n");\n',
    );
    const res = await packed(c);
    expect(existsSync(path.join(c.configDir, "dist", "index.js"))).toBe(true);
    expect(existsSync(path.join(c.dir, "dist"))).toBe(false);
    expect(res.manifest.worker.mainModule).toBe("index.js");
    expect(res.manifest.worker.modules.map((m) => m.name)).toEqual(["index.js"]);
  }, 120_000);

  it("still lets an entry drop it and build with its own command from the checkout root", async () => {
    const c = checkout(
      { main: "dist/index.js", build: { command: "node build.mjs" } },
      {
        subdir: "apps/api",
        catalog: (m) => {
          const install = m.install as Record<string, unknown>;
          install.configPatch = { build: null };
          install.buildCommand = "node apps/api/build.mjs apps/api";
        },
      },
    );
    mkdirSync(c.configDir, { recursive: true });
    writeFileSync(
      path.join(c.configDir, "build.mjs"),
      'import { mkdirSync, writeFileSync } from "node:fs";\nimport path from "node:path";\n' +
        'const out = path.join(process.argv[2] ?? ".", "dist");\nmkdirSync(out, { recursive: true });\n' +
        'writeFileSync(path.join(out, "index.js"), "export default { fetch: () => new Response(\\"built\\") };\\n");\n',
    );
    const res = await packed(c);
    expect(res.manifest.worker.modules.map((m) => m.name)).toEqual(["index.js"]);
  }, 120_000);
});

describe("keys the packer does not know", () => {
  it("refuses a config with keys wrangler does not know, naming them, and writes nothing", async () => {
    const c = checkout({ k2: [{ binding: "STREAM" }], analytics: { binding: "SQL" } });
    await expect(packed(c)).rejects.toThrow(UnknownWranglerKeyError);
    await expect(packed(c)).rejects.toThrow(
      /the wrangler config wrangler\.jsonc sets "k2" and "analytics", which the packer does not know/,
    );
    expect(existsSync(path.join(parent, "out"))).toBe(false);
  }, 120_000);

  it("packs without one the entry's config patch drops, and only such a one", async () => {
    // An upstream config's [email] table: no wrangler key, which wrangler drops with a warning.
    const email = { email: { action: "process" } };
    const patched = (configPatch: Record<string, unknown>) =>
      checkout(email, {
        catalog: (m) => {
          (m.install as Record<string, unknown>).configPatch = configPatch;
        },
      });
    await expect(packed(checkout(email))).rejects.toThrow(
      /sets "email", which the packer does not know.*config patch \{ "email": null \}/,
    );
    const res = await packed(patched({ email: null }));
    expect(res.manifest.worker.modules[0]?.name).toBe("index.js");
    rmSync(path.join(parent, "checkout"), { recursive: true, force: true });
    await expect(packed(patched({ email: null, observability: null }))).rejects.toThrow(
      /it drops observability, which the packer knows and does not refuse/,
    );
    rmSync(path.join(parent, "checkout"), { recursive: true, force: true });
    await expect(packed(patched({ email: null, emial: null }))).rejects.toThrow(
      /it drops emial, which the config does not set/,
    );
  }, 120_000);
});

describe("mTLS certificates", () => {
  const certs = { mtls_certificates: [{ binding: "CERT", certificate_id: "0199" }] };

  it("refuses them, naming the config patch that drops them", async () => {
    await expect(packed(checkout(certs))).rejects.toThrow(UnsupportedSectionError);
    await expect(packed(checkout(certs))).rejects.toThrow(/\{ "mtls_certificates": null \}/);
  }, 120_000);

  it("packs the app without them once the entry's config patch drops them", async () => {
    const c = checkout(certs, {
      catalog: (m) => {
        (m.install as Record<string, unknown>).configPatch = { mtls_certificates: null };
      },
    });
    const res = await packed(c);
    expect(res.manifest.worker.bindings.map((b) => b.type)).not.toContain("mtls_certificate");
  }, 120_000);
});
