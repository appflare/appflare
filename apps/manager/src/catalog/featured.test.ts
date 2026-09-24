import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FeaturedItem } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { featured_dismissals, user } from "../db/schema";
import { featuredCard, pickFeatured, safeExternalUrl } from "./featured";
import { dismissedFeaturedIds, dismissFeaturedItem } from "./featured.server";

const INDEX_URL = "https://appflare.github.io/catalog/index.json";
const NOW = new Date("2026-10-15T00:00:00.000Z");

const item = (id: string, extra: Partial<FeaturedItem> = {}): FeaturedItem => ({
  id,
  title: `Item ${id}`,
  text: "Deploy faster.",
  sponsor: { name: "Acme", url: "https://acme.example" },
  link: { url: "https://acme.example/edge", label: "Learn more" },
  ...extra,
});

describe("pickFeatured", () => {
  it("shows the first active item the user has not hidden", () => {
    const items = [
      item("ended", { endsAt: "2026-10-01T00:00:00Z" }),
      item("hidden"),
      item("future", { startsAt: "2026-11-01T00:00:00Z" }),
      item("current"),
      item("next"),
    ];
    expect(pickFeatured(items, new Set(["hidden"]), NOW)?.id).toBe("current");
    expect(pickFeatured(items, new Set(["hidden", "current", "next"]), NOW)).toBeNull();
    expect(pickFeatured([], new Set(), NOW)).toBeNull();
  });
});

describe("featuredCard", () => {
  const names = (slug: string) => (slug === "cut" ? "Cut" : null);

  it("keeps an image on the catalog site and drops one hosted elsewhere", () => {
    const sha = "a".repeat(64);
    const hosted = featuredCard(
      item("a", {
        image: { url: "https://appflare.github.io/catalog/featured/a.png", sha256: sha, alt: "A" },
      }),
      INDEX_URL,
      names,
    );
    expect(hosted.image).toEqual({ src: `/api/catalog/media/${sha}`, alt: "A" });
    const tracked = featuredCard(
      item("b", { image: { url: "https://acme.example/pixel.png", sha256: sha, alt: "B" } }),
      INDEX_URL,
      names,
    );
    expect(tracked.image).toBeNull();
    expect(tracked.link?.url).toBe("https://acme.example/edge");
  });

  it("names a promoted app from the index", () => {
    const { link: _link, ...rest } = item("c");
    expect(featuredCard({ ...rest, slug: "cut" }, INDEX_URL, names).app).toEqual({
      slug: "cut",
      name: "Cut",
    });
    expect(featuredCard({ ...rest, slug: "gone" }, INDEX_URL, names).app).toBeNull();
  });

  it("links only to https URLs", () => {
    expect(safeExternalUrl("https://acme.example/?a=1")).toBe("https://acme.example/?a=1");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("http://acme.example")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe("featured dismissals", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const db = createDb(env.DB);
    for (const id of ["u1", "u2"]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.com`, role: "member" });
    }
  });

  it("are per user, idempotent, and removed with the user", async () => {
    const db = createDb(env.DB);
    await dismissFeaturedItem(db, "u1", "acme", NOW);
    await dismissFeaturedItem(db, "u1", "acme", NOW);
    expect([...(await dismissedFeaturedIds(db, "u1"))]).toEqual(["acme"]);
    expect((await dismissedFeaturedIds(db, "u2")).size).toBe(0);
    await env.DB.prepare("DELETE FROM user WHERE id = 'u1'").run();
    expect(await db.select().from(featured_dismissals)).toEqual([]);
  });
});
