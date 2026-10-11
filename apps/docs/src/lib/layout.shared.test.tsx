import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { baseOptions, githubLink, logoScrollsToTop } from "./layout.shared.tsx";

describe("the GitHub link in the navigation bar", () => {
  it("is named by its label, with its icon hidden from screen readers", () => {
    if (githubLink.type !== "icon") throw new Error("expected an icon link");
    expect(githubLink.label).toBe("GitHub");
    const svg = renderToStaticMarkup(githubLink.icon);
    expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(svg).not.toContain('role="img"');
  });

  it("replaces Fumadocs' own, whose icon is an unnamed image", () => {
    const options = baseOptions();
    expect(options.githubUrl).toBeUndefined();
    expect(options.links).toContain(githubLink);
  });
});

describe("the logo in the navigation bar", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it("takes the front page back to its top, where its link would lead nowhere", () => {
    expect(logoScrollsToTop("/", plain)).toBe(true);
    expect(logoScrollsToTop("/apps/", plain)).toBe(false);
    expect(logoScrollsToTop("/start/overview/", plain)).toBe(false);
  });

  it("leaves a click with a modifier, or with another button, to the browser", () => {
    expect(logoScrollsToTop("/", { ...plain, metaKey: true })).toBe(false);
    expect(logoScrollsToTop("/", { ...plain, ctrlKey: true })).toBe(false);
    expect(logoScrollsToTop("/", { ...plain, button: 1 })).toBe(false);
    expect(logoScrollsToTop("/", { ...plain, defaultPrevented: true })).toBe(false);
  });

  it("is the site's own, not Fumadocs' plain link", () => {
    expect(typeof baseOptions().nav?.title).toBe("function");
  });
});
