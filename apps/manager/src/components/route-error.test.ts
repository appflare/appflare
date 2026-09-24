import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACCESS_DENIED_MESSAGE, isAccessDenied } from "../access/denied";
import { RouteError } from "./route-error";

/** What TanStack Start's client throws for a server function call Access refused. */
const refused = new Error(
  JSON.stringify({ code: "access_denied", error: "Sign in with Cloudflare Access. …" }),
);

function render(error: unknown): string {
  return renderToStaticMarkup(
    createElement(RouteError, { error: error as Error, reset: () => {} }),
  );
}

describe("isAccessDenied", () => {
  it("recognises only the Access refusal", () => {
    expect(isAccessDenied(refused)).toBe(true);
    expect(isAccessDenied(new Error(JSON.stringify({ code: "other" })))).toBe(false);
    expect(isAccessDenied(new Error("Setup is already complete."))).toBe(false);
    expect(isAccessDenied({ code: "access_denied" })).toBe(false);
  });
});

describe("RouteError", () => {
  it("explains an Access refusal and offers a reload instead of the raw error", () => {
    const html = render(refused);
    expect(html).toContain(ACCESS_DENIED_MESSAGE);
    expect(html).toMatch(/<button[^>]*>.*Reload.*<\/button>/);
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("Something went wrong");
  });

  it("keeps showing other errors as before", () => {
    expect(render(new Error("The catalog is unreachable."))).toContain(
      "The catalog is unreachable.",
    );
    expect(render("nope")).toContain("Unexpected error.");
  });
});
