import { describe, expect, it } from "vitest";
import {
  appCrop,
  type CardApp,
  DASHBOARD,
  docsCrop,
  firstSentence,
  OG_HEIGHT,
  type OgCard,
  renderOgCard,
  windowFor,
} from "./cards.tsx";
import type { OgPicture } from "./picture.ts";
import { pngSize } from "./png-size.ts";
import {
  SOCIAL_HEIGHT,
  SOCIAL_WIDTH,
  type SocialPreview,
  socialPreviewElement,
} from "./social.tsx";

const icon = `data:image/svg+xml;base64,${Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10' fill='#1a73e8'/></svg>",
).toString("base64")}`;

/** A 1x1 PNG, drawn as if it were a screenshot of the given size. */
const shot = (width: number, height: number): OgPicture => ({
  src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  width,
  height,
});

const withIcon: CardApp = { name: "Veet", pitch: "Talk face to face in your browser", icon };
const withoutIcon: CardApp = { name: "mailflare", pitch: "Email on your own domain", icon: null };

const cards: OgCard[] = [
  {
    kind: "site",
    title: "The app manager for your own Cloudflare account",
    description: "Hi.",
    dashboard: shot(2352, 1384),
  },
  { kind: "site", title: "The app manager", description: "Hi.", dashboard: null },
  {
    kind: "docs",
    section: "Getting started",
    title: "Install Appflare",
    description: "The three ways to install. And more.",
    path: "/start/install/",
    screenshot: { path: "/screenshots/users-list.png", picture: shot(2352, 1524) },
  },
  {
    kind: "docs",
    section: null,
    title: "Rotate the auth secret or remove Appflare, and a title that runs on",
    path: "/faq/",
    screenshot: { path: DASHBOARD, picture: shot(2352, 1384) },
  },
  { kind: "docs", section: null, title: "FAQ", path: "/faq/", screenshot: null },
  {
    kind: "app",
    app: withIcon,
    categories: ["Chat", "Productivity"],
    path: "/apps/veet/",
    screenshot: shot(1600, 900),
  },
  { kind: "app", app: withoutIcon, categories: [], path: "/apps/mailflare/", screenshot: null },
  { kind: "install", app: withIcon, path: "/install/veet/", screenshot: shot(1600, 900) },
  { kind: "install", app: withoutIcon, path: "/install/mailflare/", screenshot: null },
  ...[1, 3, 12].map(
    (n): OgCard => ({
      kind: "category",
      title: "Email",
      description: `${n} apps.`,
      apps: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? withIcon : withoutIcon)),
      path: "/categories/email/",
    }),
  ),
  {
    kind: "apps",
    title: "12 apps for your Cloudflare account",
    description: "Apps.",
    apps: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? withIcon : withoutIcon)),
    path: "/apps/",
  },
];

describe("renderOgCard", () => {
  cards.forEach((card, i) => {
    const name = "title" in card ? card.title : card.app.name;
    it(`draws the ${card.kind} card for "${name}" (#${i}) as a 1200x630 PNG`, async () => {
      const response = renderOgCard(card);
      expect(response.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    });
  });

  it("draws the same bytes every time, so the build is reproducible", async () => {
    const card = cards[5] as OgCard;
    const first = new Uint8Array(await renderOgCard(card).arrayBuffer());
    const second = new Uint8Array(await renderOgCard(card).arrayBuffer());
    expect(second).toEqual(first);
  });
});

describe("firstSentence", () => {
  it("keeps the first sentence of a description", () => {
    expect(firstSentence("The three ways to install. And more.")).toBe(
      "The three ways to install.",
    );
    expect(firstSentence("  One line, no stop  ")).toBe("One line, no stop");
    expect(firstSentence("Use workers.dev or a domain. Then go.")).toBe(
      "Use workers.dev or a domain.",
    );
    expect(firstSentence("")).toBe("");
  });
});

describe("the screenshot window", () => {
  it("shows a docs screenshot at a reading size, widening a narrow one", () => {
    expect(docsCrop(shot(2352, 1384))).toEqual({ scale: 0.62, x: 0, y: 0 });
    const phone = docsCrop(shot(780, 1540));
    expect(phone.scale).toBeGreaterThan(0.62);
    expect(phone.scale).toBeLessThanOrEqual(1);
  });

  it("fits an app's screenshot to the window's width, never past its own size", () => {
    expect(appCrop(shot(1280, 800)).scale).toBe(0.5);
    expect(appCrop(shot(400, 800)).scale).toBe(1);
  });

  it("runs a tall crop off the bottom edge and centres a short one", () => {
    const tall = shot(2352, 2596);
    const running = windowFor(tall, docsCrop(tall));
    expect(running.top + running.height).toBeGreaterThan(OG_HEIGHT);
    const short = shot(2112, 404);
    const placed = windowFor(short, docsCrop(short));
    expect(placed.height).toBe(Math.round(404 * 0.62) + 41);
    expect(placed.top * 2 + placed.height).toBeCloseTo(OG_HEIGHT, -1);
  });
});

describe("socialPreviewElement", () => {
  const previews: SocialPreview[] = [
    { repo: "appflare", screenshot: shot(2352, 1384) },
    { repo: "catalog", apps: [withIcon, withoutIcon], count: 2 },
    { repo: "deploy" },
  ];
  for (const preview of previews) {
    it(`draws the ${preview.repo} repository's preview at GitHub's 1280x640`, async () => {
      const { render } = await import("takumi-js");
      const bytes = await render(socialPreviewElement(preview), {
        width: SOCIAL_WIDTH,
        height: SOCIAL_HEIGHT,
        format: "png",
      });
      expect(pngSize(new Uint8Array(bytes))).toEqual({ width: 1280, height: 640 });
    });
  }
});
