import { describe, expect, it } from "vitest";
import { type CardApp, type OgCard, renderOgCard } from "./cards.tsx";
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

const withIcon: CardApp = { name: "Veet", pitch: "Talk face to face in your browser", icon };
const withoutIcon: CardApp = { name: "mailflare", pitch: "Email on your own domain", icon: null };

const cards: OgCard[] = [
  { kind: "site", title: "The app manager for your own Cloudflare account", description: "Hi." },
  {
    kind: "docs",
    section: "Getting started",
    title: "Install Appflare",
    description: "The three ways to install.",
    path: "/start/install/",
  },
  { kind: "docs", section: null, title: "FAQ", path: "/faq/" },
  { kind: "app", app: withIcon, categories: ["Chat", "Productivity"], path: "/apps/veet/" },
  { kind: "app", app: withoutIcon, categories: [], path: "/apps/mailflare/" },
  { kind: "install", app: withIcon, path: "/install/veet/" },
  { kind: "install", app: withoutIcon, path: "/install/mailflare/" },
  {
    kind: "category",
    id: "email",
    title: "Email apps",
    description: "2 apps.",
    apps: [withIcon, withoutIcon],
    path: "/categories/email/",
  },
  {
    kind: "category",
    id: "a-category-without-an-icon",
    title: "New apps",
    description: "1 app.",
    apps: [withoutIcon],
    path: "/categories/a-category-without-an-icon/",
  },
  {
    kind: "apps",
    title: "12 apps, ready to install",
    description: "Apps.",
    apps: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? withIcon : withoutIcon)),
    path: "/apps/",
  },
];

describe("renderOgCard", () => {
  for (const card of cards) {
    const name = "title" in card ? card.title : card.app.name;
    it(`draws the ${card.kind} card for "${name}" as a 1200x630 PNG`, async () => {
      const response = renderOgCard(card);
      expect(response.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    });
  }
});

describe("socialPreviewElement", () => {
  const previews: SocialPreview[] = [
    { repo: "appflare", screenshot: icon },
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
