import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BANNER_ICON,
  bannerMessage,
  ErrorMessageBanner,
  MessageBanner,
  SuccessBanner,
} from "./message-text";

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

function live(): Array<{ role: string | null; text: string }> {
  return [...container.querySelectorAll("[role=alert], [role=status]")].map((el) => ({
    role: el.getAttribute("role"),
    text: el.textContent ?? "",
  }));
}

/** The Phosphor icon a banner draws, by the path it starts with. */
function iconPath(): string | null {
  return container.querySelector("svg path")?.getAttribute("d") ?? null;
}

function pathOf(icon: ReactElement): string | null {
  const probe = document.createElement("div");
  const probeRoot = createRoot(probe);
  act(() => probeRoot.render(icon));
  const d = probe.querySelector("svg path")?.getAttribute("d") ?? null;
  act(() => probeRoot.unmount());
  return d;
}

describe("message banners are announced as they appear", () => {
  it("announces an error as one alert, with the error icon", () => {
    act(() => root.render(<ErrorMessageBanner message="The token was refused." />));
    expect(live()).toEqual([{ role: "alert", text: "The token was refused." }]);
    expect(iconPath()).toBe(pathOf(BANNER_ICON.error));
  });

  it("announces a new error when the message changes in place", () => {
    act(() => root.render(<ErrorMessageBanner message="First try failed." />));
    act(() => root.render(<ErrorMessageBanner message="Second try failed." />));
    expect(live()).toEqual([{ role: "alert", text: "Second try failed." }]);
  });

  it("announces any other variant politely, with that variant's icon", () => {
    for (const variant of ["alert", "default", "secondary"] as const) {
      act(() => root.render(<MessageBanner message="Heads up." variant={variant} />));
      expect(live()).toEqual([{ role: "status", text: "Heads up." }]);
      expect(iconPath()).toBe(pathOf(BANNER_ICON[variant]));
    }
  });

  it("keeps an icon the caller chose", () => {
    act(() =>
      root.render(<MessageBanner message="Mail" variant="default" icon={<span data-mine />} />),
    );
    expect(container.querySelector("[data-mine]")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("puts a message with a link in the description, opening in a new tab when asked", () => {
    act(() =>
      root.render(
        <ErrorMessageBanner
          message="Missing a permission: https://dash.cloudflare.com/profile/api-tokens"
          newTab
        />,
      ),
    );
    const alert = container.querySelector("[role=alert]");
    expect(alert?.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });
});

describe("the success banner", () => {
  it("is the neutral banner with a green check, announced politely", () => {
    act(() =>
      root.render(<SuccessBanner title="Token rotated" description="Appflare redeploys." />),
    );
    expect(live()).toEqual([{ role: "status", text: "Token rotatedAppflare redeploys." }]);
    const banner = container.querySelector("[role=status]");
    const icon = banner?.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("text-kumo-success");
  });

  it("takes a message string through bannerMessage", () => {
    act(() => root.render(<SuccessBanner {...bannerMessage("Access is on.")} />));
    expect(live()).toEqual([{ role: "status", text: "Access is on." }]);
  });
});
