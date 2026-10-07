import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { siteCatalog } from "../../catalog/data.ts";
import { installLink } from "../../lib/install-links.ts";
import { landingData } from "../../lib/landing.ts";
import { LandingContent } from "./landing-page.tsx";

const data = landingData(siteCatalog);
const html = renderToStaticMarkup(<LandingContent data={data} />);

describe("the front page", () => {
  it("leads with Install Appflare, the deploy page, twice", () => {
    const installs = [
      ...html.matchAll(/<a[^>]*href="(https:\/\/link\.appflare\.dev\/deploy\?[^"]*)"[^>]*>/g),
    ];
    expect(installs).toHaveLength(2);
    expect(html.indexOf(installLink("home-hero-install").replaceAll("&", "&amp;"))).toBeLessThan(
      html.indexOf('<img src="/screenshots/landing-home.png"'),
    );
    expect(installs[0]?.[1]).not.toBe(installs[1]?.[1]);
  });

  it("keeps Cloudflare's Deploy button as a quiet second way, after each Install button", () => {
    const deploy = installLink("home-hero-cloudflare", true).replaceAll("&", "&amp;");
    expect(html).toContain(deploy);
    expect(html.indexOf(deploy)).toBeGreaterThan(html.indexOf("home-hero-install"));
    expect(html).toContain("Cloudflare&#x27;s Deploy button");
    expect(html).not.toContain("deploy.workers.cloudflare.com/button");
  });

  it("links to the documentation where it starts", () => {
    expect(html).toMatch(/<a[^>]*href="\/start\/overview\/"[^>]*>Read the docs<\/a>/);
  });

  it("offers no prompt for a coding agent", () => {
    expect(html).not.toContain("Copy prompt");
    expect(html).not.toContain("/agent/");
    expect(html).not.toMatch(/with an agent/i);
  });

  it("points at the button with a drawing that loads nothing and that screen readers skip", () => {
    const svg = /<svg[^>]*viewBox="0 0 250 120"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    expect(svg).not.toBe("");
    expect(svg).toMatch(/aria-hidden="true"/);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).not.toMatch(/<text\b|<image\b|<style\b|font-family/);
  });

  it("shows the whole manager, sidebar included, as the hero", () => {
    expect(html).toMatch(
      /<img[^>]*src="\/screenshots\/landing-home.png"[^>]*width="2880"[^>]*height="1800"/,
    );
  });

  it("names automatic updates, for apps and for Appflare itself", () => {
    expect(html).toContain("Automatic updates");
    expect(html).toContain('href="/guides/updates/#automatic-updates"');
    expect(html).toContain("Appflare can update itself the same way");
  });

  it("quotes the catalog's own numbers and links each app shown", () => {
    expect(html).toContain(`${data.apps} apps, ready to install`);
    for (const app of data.showcase) expect(html).toContain(`href="/apps/${app.slug}/"`);
  });

  it("has a footer of its own that links to the privacy page", () => {
    const footer = html.slice(html.lastIndexOf("<footer"));
    expect(footer).toContain('href="/privacy/"');
    expect(footer).toContain("not affiliated with");
  });
});

describe("landingData", () => {
  it("counts the catalog and picks apps with an icon, the most stars first", () => {
    expect(data.apps).toBe(siteCatalog.apps.length);
    expect(data.categories).toBe(siteCatalog.categories.length);
    expect(data.freePlan).toBe(siteCatalog.apps.filter((app) => app.plan === "free").length);
    const stars = data.showcase.map(
      (shown) => siteCatalog.apps.find((app) => app.slug === shown.slug)?.popularity?.stars ?? 0,
    );
    expect(stars).toEqual([...stars].sort((a, b) => b - a));
    expect(data.showcase.every((app) => app.icon !== "")).toBe(true);
  });

  it("shows at most the number it is asked for", () => {
    expect(landingData(siteCatalog, 2).showcase.length).toBeLessThanOrEqual(2);
  });
});
