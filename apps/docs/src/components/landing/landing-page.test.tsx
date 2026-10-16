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

  it("serves each screenshot as smaller WebP copies, the hero first of all", () => {
    const shots = [...html.matchAll(/<img[^>]*src="\/screenshots\/[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(shots.length).toBeGreaterThan(0);
    for (const shot of shots) {
      // Built, the copies are `/assets/<name>-<hash>.webp`; in a test, imagetools' own addresses.
      expect(shot).toMatch(/srcSet="[^" ]+ \d+w, [^"]+"/);
      expect(shot).toMatch(/sizes="[^"]+"/);
    }
    const hero = shots.find((shot) => shot.includes("landing-home.png"));
    expect(hero).toMatch(/loading="eager"/);
    expect(hero).toMatch(/fetchPriority="high"/);
  });

  it("opens the hero larger, in the lightbox, rather than leaving it a dead click", () => {
    const link = /<a[^>]*href="\/screenshots\/landing-home.png"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(link?.[0]).toMatch(/aria-haspopup="dialog"/);
    expect(link?.[1]).toMatch(/<img[^>]*src="\/screenshots\/landing-home.png"[^>]*alt="Appflare/);
    expect(link?.[1]).toContain("Opens it larger.");
  });

  it("links each app icon under How it works to the app's page", () => {
    const step = html.slice(html.indexOf("Install an app"), html.indexOf("Keep it updated"));
    const icons = [...step.matchAll(/<a[^>]*href="(\/apps\/[^"]+)"[^>]*aria-label="([^"]+)"/g)];
    expect(icons.map((m) => m[1])).toEqual(
      data.showcase.slice(0, 6).map((app) => `/apps/${app.slug}/`),
    );
    expect(icons.map((m) => m[2])).toEqual(data.showcase.slice(0, 6).map((app) => app.name));
  });

  it("names automatic updates, for apps and for Appflare itself", () => {
    expect(html).toContain("Automatic updates");
    expect(html).toContain('href="/guides/updates/#automatic-updates"');
    expect(html).toContain("Appflare can update itself the same way");
  });

  it("says what Appflare does when an app runs up the bill, with the guide and a picture", () => {
    const card = /<a[^>]*href="\/guides\/spend-protection\/"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1];
    expect(card).toContain("Spend protection");
    expect(card).toContain("Automatic pausing is off by default");
    expect(card).toContain("estimates at Cloudflare&#x27;s list prices");
    expect(card).toMatch(
      /<img[^>]*src="\/screenshots\/landing-spend.png"[^>]*width="1672"[^>]*height="1060"/,
    );
  });

  it("quotes the catalog's own numbers and links each app shown", () => {
    expect(html).toContain(`${data.apps} apps, ready to install`);
    for (const app of data.showcase) expect(html).toContain(`href="/apps/${app.slug}/"`);
  });

  it("shows what people said on X, each post linking to itself, and loads nothing from X", () => {
    const section = html.slice(
      html.indexOf('aria-label="What people are saying"'),
      html.indexOf("How it works"),
    );
    const posts = [...section.matchAll(/href="(https:\/\/x\.com\/[^/]+\/status\/\d+)"/g)];
    expect(posts.length).toBeGreaterThan(1);
    expect(new Set(posts.map((post) => post[1])).size).toBe(posts.length);
    expect(html).not.toMatch(/twimg\.com|pbs\.twimg/);
  });

  it("puts one post in front and gives a face button to every post", () => {
    const section = html.slice(html.indexOf('aria-label="What people are saying"'));
    const articles = [...section.matchAll(/<article[^>]*>/g)].map((m) => m[0]);
    expect(articles.filter((tag) => !tag.includes('aria-hidden="true"'))).toHaveLength(1);
    expect([...section.matchAll(/aria-label="Show [^"]+&#x27;s post"/g)].length).toBe(
      articles.length,
    );
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
