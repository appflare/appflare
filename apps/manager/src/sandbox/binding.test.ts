import {
  SANDBOX_FEATURE_ASSETS_ONLY,
  SANDBOX_FEATURE_D1_BASELINE,
  SANDBOX_FEATURE_D1_SEED,
  SANDBOX_FEATURE_INSTALL_DIRS,
  SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE,
} from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  assetsOnlyBuildFailure,
  assetsOnlyRefusal,
  d1BaselineRefusal,
  d1SeedRefusal,
  wranglerConfigInlineRefusal,
} from "./binding";

describe("assetsOnlyRefusal", () => {
  const old = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_INSTALL_DIRS] };
  const current = { sandboxVersion: "0.1.7", features: [SANDBOX_FEATURE_ASSETS_ONLY] };
  const plain = { install: {}, secrets: [{ name: "KEY", multiline: false }] };
  const installsNothing = { install: { installDirs: [] }, secrets: [] };
  const pemKey = { install: {}, secrets: [{ name: "PRIVATE_KEY", multiline: true }] };

  it("refuses an entry that installs nothing on a sandbox Worker whose schema refuses it", () => {
    expect(assetsOnlyRefusal(old, installsNothing, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app that installs no packages (install.installDirs is empty); to update it, update it",
    );
  });

  it("refuses a multi-line secret on a sandbox Worker that would build it as one line", () => {
    expect(assetsOnlyRefusal(old, pemKey, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app with a multi-line secret (multiline) and would build it as a one-line secret; to update it, update it",
    );
  });

  it("builds both on a sandbox Worker with the feature, and any other entry anywhere", () => {
    expect(assetsOnlyRefusal(current, installsNothing, "update it")).toBeNull();
    expect(assetsOnlyRefusal(current, pemKey, "update it")).toBeNull();
    expect(assetsOnlyRefusal(old, plain, "update it")).toBeNull();
    const installsRoot = { install: { installDirs: [{ path: "." }] }, secrets: [] };
    expect(assetsOnlyRefusal(old, installsRoot, "update it")).toBeNull();
    expect(assetsOnlyRefusal(old, undefined, "update it")).toBeNull();
  });
});

describe("assetsOnlyBuildFailure", () => {
  const refusedByPacker =
    "appflare-pack failed: wrangler config wrangler.jsonc has no `main` entrypoint";
  const old = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_INSTALL_DIRS] };

  it("explains a static site an outdated sandbox Worker's packer refused", () => {
    expect(assetsOnlyBuildFailure(old, refusedByPacker, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app that is static files only (its wrangler config has no main); to update it, update it",
    );
  });

  it("leaves every other failure, and any failure of a current sandbox Worker, as it is", () => {
    expect(assetsOnlyBuildFailure(old, "pnpm install failed", "update it")).toBeNull();
    const current = { sandboxVersion: "0.1.7", features: [SANDBOX_FEATURE_ASSETS_ONLY] };
    expect(assetsOnlyBuildFailure(current, refusedByPacker, "update it")).toBeNull();
  });
});

describe("d1SeedRefusal", () => {
  const seeded = { resources: { d1: { DB: { seed: { statements: [] } } } } };

  it("refuses an entry with a seed on a sandbox Worker that would build it without one", () => {
    expect(d1SeedRefusal({ sandboxVersion: "0.1.5", features: [] }, seeded, "update it")).toBe(
      "the sandbox Worker 0.1.5 cannot build an app that seeds its database (resources.d1 seed) and would build it without the seed; to update it, update it",
    );
  });

  it("builds it on a sandbox Worker that keeps seeds, and any entry without one anywhere", () => {
    const current = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_D1_SEED] };
    expect(d1SeedRefusal(current, seeded, "update it")).toBeNull();
    const old = { sandboxVersion: "0.1.5", features: [] };
    expect(d1SeedRefusal(old, { resources: { d1: { DB: {} } } }, "update it")).toBeNull();
    expect(d1SeedRefusal(old, undefined, "update it")).toBeNull();
  });
});

describe("d1BaselineRefusal", () => {
  const withBaseline = { resources: { d1: { DB: { baseline: "schema.sql" } } } };
  const old = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_D1_SEED] };

  it("refuses an entry with a baseline on a sandbox Worker that would build it without one", () => {
    expect(d1BaselineRefusal(old, withBaseline, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app with a D1 baseline (resources.d1 baseline) and would build it without one; to update it, update it",
    );
  });

  it("builds it on a sandbox Worker that keeps baselines, and any entry without one anywhere", () => {
    const current = { sandboxVersion: "0.1.7", features: [SANDBOX_FEATURE_D1_BASELINE] };
    expect(d1BaselineRefusal(current, withBaseline, "update it")).toBeNull();
    expect(d1BaselineRefusal(old, { resources: { d1: { DB: {} } } }, "update it")).toBeNull();
    expect(d1BaselineRefusal(old, undefined, "update it")).toBeNull();
  });
});

describe("wranglerConfigInlineRefusal", () => {
  const old = { sandboxVersion: "0.1.6", features: [] };
  const inline = { install: { wranglerConfigInline: { compatibility_date: "2026-01-01" } } };

  it("refuses an inline config on a sandbox Worker that predates it", () => {
    expect(wranglerConfigInlineRefusal(old, inline, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app whose wrangler config the catalog carries (install.wranglerConfigInline) and would find no config to build from; to update it, update it",
    );
    expect(
      wranglerConfigInlineRefusal(
        old,
        { install: { workers: [{}, { wranglerConfigInline: {} }] } },
        "update it",
      ),
    ).not.toBeNull();
  });

  it("allows it on a current sandbox Worker, and anything else on an old one", () => {
    const current = { sandboxVersion: "0.1.7", features: [SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE] };
    expect(wranglerConfigInlineRefusal(current, inline, "update it")).toBeNull();
    expect(wranglerConfigInlineRefusal(old, { install: {} }, "update it")).toBeNull();
    expect(wranglerConfigInlineRefusal(old, undefined, "update it")).toBeNull();
  });
});
