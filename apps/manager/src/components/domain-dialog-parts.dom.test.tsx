import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenPermissionsBanner } from "./domain-dialog-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(connection: "api_token" | "oauth", noZones = false) {
  act(() =>
    root.render(
      <TokenPermissionsBanner
        options={{ missing: ["Workers Routes: Edit"], noZones, connection }}
        accountId="acc1"
      />,
    ),
  );
}

describe("what to do when custom domains are not allowed", () => {
  it("tells an API token's admin to edit the token", () => {
    render("api_token");
    expect(container.textContent).toContain(
      "The Cloudflare token cannot manage custom domains yet",
    );
    expect(container.textContent).toContain("Create a new token");
  });

  it("tells a sign-in's admin to reconnect, in one line, without token words", () => {
    render("oauth");
    expect(container.textContent).toContain("Appflare cannot manage custom domains yet");
    const reconnect = container.querySelector("a");
    expect(reconnect?.textContent).toBe("Reconnect Cloudflare");
    expect(reconnect?.getAttribute("href")).toContain("reconnect=1");
    expect(container.textContent).not.toMatch(/\btoken\b/i);
    render("oauth", true);
    expect(container.textContent).toContain("Appflare cannot see any domain in this account");
  });
});
