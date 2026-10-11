import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { baseOptions, githubLink } from "./layout.shared.tsx";

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
