import type { InstallForm } from "./install-form.ts";
import type { SiteApp } from "./site-catalog.ts";

/** An app as the pages get it, for tests that should not depend on the checked-in fixture. */
export function testApp(overrides: Partial<SiteApp> = {}): SiteApp {
  const slug = overrides.slug ?? "cut";
  return {
    slug,
    name: "Cut",
    pitch: "Short links on your own domain",
    summary: "A link shortener on Workers and KV.",
    features: [],
    alternativeTo: [],
    version: "1.0.0",
    plan: "free",
    tier: "artifact",
    requires: [],
    services: [],
    accessIfProtected: false,
    lastVerified: null,
    addedAt: "2026-01-01T00:00:00Z",
    authors: [],
    maintainers: [],
    categories: [],
    license: { expression: "MIT", note: null },
    icon: null,
    cover: null,
    screenshots: [],
    repo: `acme/${slug}`,
    homepage: `https://github.com/acme/${slug}`,
    popularity: null,
    installForm: null,
    ...overrides,
  };
}

/** An install form that asks for nothing, with `overrides`. */
export function testForm(overrides: Partial<InstallForm> = {}): InstallForm {
  return {
    asks: [],
    databases: [],
    emailDomain: false,
    generated: [],
    optional: 0,
    access: "offered",
    publicPaths: [],
    postInstallSteps: 0,
    ...overrides,
  };
}
