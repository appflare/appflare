import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { siteCatalog } from "../../catalog/data.ts";
import { agentPrompt } from "../../lib/agent-prompts.ts";
import { landingData } from "../../lib/landing.ts";
import { DEPLOY_URL } from "../install/flow-panel.tsx";
import { LandingContent } from "./landing-page.tsx";

const data = landingData(siteCatalog);
const html = renderToStaticMarkup(<LandingContent data={data} />);

describe("the front page", () => {
  it("leads with the Deploy to Cloudflare button, twice", () => {
    const deploy = `href="${DEPLOY_URL.replaceAll("&", "&amp;")}"`;
    expect(html.split(deploy).length - 1).toBe(2);
    // The hero's button comes before the screenshot.
    expect(html.indexOf(deploy)).toBeLessThan(
      html.indexOf('<img src="/screenshots/landing-home.png"'),
    );
  });

  it("links to the documentation where it starts", () => {
    expect(html).toMatch(/<a[^>]*href="\/start\/overview\/"[^>]*>Read the docs<\/a>/);
  });

  it("offers the install prompt for an agent under the button", () => {
    expect(html).toContain("Or set it up with an agent:");
    expect(html).toContain(`title="${agentPrompt("install")}"`);
    expect(html.indexOf("Copy prompt")).toBeGreaterThan(
      html.indexOf(DEPLOY_URL.split("?")[0] ?? ""),
    );
  });

  it("points at the button with a drawing that loads nothing and that screen readers skip", () => {
    const svg = /<svg[^>]*viewBox="0 0 184 62"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
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
