import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { testApp } from "../../catalog/test-app.ts";
import { AppGrid } from "./tiles.tsx";

const apps = [testApp({ slug: "cut" }), testApp({ slug: "glance", name: "Glance" })];
const items = (html: string) => [...html.matchAll(/<li class="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("AppGrid", () => {
  it("draws a long list's tiles only near the screen, keeping each one in the page", () => {
    const html = renderToStaticMarkup(<AppGrid apps={apps} long />);
    for (const item of items(html)) {
      expect(item).toContain("[content-visibility:auto]");
      expect(item).toContain("[contain-intrinsic-block-size:auto_12rem]");
    }
    expect(html).toContain('href="/apps/glance/"');
  });

  it("draws a short list whole", () => {
    const html = renderToStaticMarkup(<AppGrid apps={apps} />);
    expect(items(html)).toHaveLength(2);
    for (const item of items(html)) expect(item).not.toContain("content-visibility");
  });
});
