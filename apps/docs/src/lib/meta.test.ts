import { describe, expect, it } from "vitest";
import { appPageDescription, appPageTitle } from "../catalog/app-page.ts";
import { siteCatalog } from "../catalog/data.ts";
import { Route as PageRoute } from "../routes/$.tsx";
import { Route as AppRoute } from "../routes/apps/$slug.tsx";
import { Route as FrontRoute } from "../routes/index.tsx";
import { Route as InstallRoute } from "../routes/install/$slug.tsx";
import { pageHead } from "./meta.ts";
import { SITE_URL } from "./shared.ts";

type Meta = Array<Record<string, string>>;

/** The content of the meta tag with this `property` or `name`. */
function tag(meta: Meta, key: string): string | undefined {
  return meta.find((entry) => entry.property === key || entry.name === key)?.content;
}

/**
 * A route's `<head>` meta tags for a URL, from its own loader and head, the
 * way the prerenderer gets them.
 */
async function headOf(
  // biome-ignore lint/suspicious/noExplicitAny: each route's options have their own generic types
  route: { options: any },
  params: Record<string, string>,
): Promise<Meta> {
  const loaderData = await route.options.loader({ params });
  return route.options.head({ loaderData, params }).meta as Meta;
}

function expectCard(meta: Meta, image: string) {
  expect(tag(meta, "og:image")).toBe(image);
  expect(tag(meta, "twitter:image")).toBe(image);
  expect(tag(meta, "og:image:width")).toBe("1200");
  expect(tag(meta, "og:image:height")).toBe("630");
  expect(tag(meta, "og:image:type")).toBe("image/png");
  expect(tag(meta, "twitter:card")).toBe("summary_large_image");
  expect(tag(meta, "og:image:alt")).toBe(tag(meta, "og:title"));
}

describe("pageHead", () => {
  it("writes the title, description, URL and image for every network", () => {
    const { meta, links } = pageHead({
      title: "FAQ | Appflare",
      description: "Answers.",
      url: `${SITE_URL}/faq/`,
      image: `${SITE_URL}/og/faq/image.png`,
    });
    expect(tag(meta, "og:title")).toBe("FAQ | Appflare");
    expect(tag(meta, "twitter:title")).toBe("FAQ | Appflare");
    expect(tag(meta, "og:description")).toBe("Answers.");
    expect(tag(meta, "twitter:description")).toBe("Answers.");
    expect(tag(meta, "og:url")).toBe(`${SITE_URL}/faq/`);
    expect(tag(meta, "og:site_name")).toBe("Appflare");
    expectCard(meta, `${SITE_URL}/og/faq/image.png`);
    expect(links).toEqual([{ rel: "canonical", href: `${SITE_URL}/faq/` }]);
  });
});

describe("the pages' OpenGraph tags", () => {
  const app = siteCatalog.apps[0];
  if (app === undefined) throw new Error("The fixture has no apps");

  it("give the front page the site's card", async () => {
    const meta = await headOf(FrontRoute, {});
    expect(tag(meta, "og:url")).toBe(`${SITE_URL}/`);
    expectCard(meta, `${SITE_URL}/og/appflare-launch.png`);
  });

  it("give a docs page its own card and address", async () => {
    const meta = await headOf(PageRoute, { _splat: "start/install/" });
    expect(tag(meta, "og:url")).toBe(`${SITE_URL}/start/install/`);
    expect(tag(meta, "og:title")).toMatch(/\| Appflare$/);
    expect(tag(meta, "og:description")).toBeTruthy();
    expectCard(meta, `${SITE_URL}/og/start/install/image.png`);
  });

  it("give an app page the app's card", async () => {
    const meta = await headOf(AppRoute, { slug: app.slug });
    expect(tag(meta, "og:url")).toBe(`${SITE_URL}/apps/${app.slug}/`);
    expect(tag(meta, "og:description")).toBe(appPageDescription(app));
    expect(tag(meta, "og:title")).toBe(appPageTitle(app, "Appflare"));
    expectCard(meta, `${SITE_URL}/og/apps/${app.slug}/image.png`);
  });

  it("give an install page its own card", async () => {
    const meta = await headOf(InstallRoute, { slug: app.slug });
    expect(tag(meta, "og:url")).toBe(`${SITE_URL}/install/${app.slug}/`);
    expectCard(meta, `${SITE_URL}/og/install/${app.slug}/image.png`);
  });
});
