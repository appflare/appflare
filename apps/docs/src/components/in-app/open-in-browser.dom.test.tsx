// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAnalytics, startAnalytics, track } from "../../analytics/analytics.ts";
import type { FlowState } from "../../install/flow.ts";
import { FlowPanel } from "../install/flow-panel.tsx";
import { InstallButton } from "../install-appflare.tsx";
import { InstallLink } from "./open-in-browser.tsx";
import { resetShareLinkCount, ShareLinkLine } from "./share-link.tsx";

vi.mock("../../analytics/analytics.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../analytics/analytics.ts")>()),
  track: vi.fn(),
}));
const posthog = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: posthog }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UA = {
  xIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.12",
  xAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 TwitterAndroid",
  unnamedIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

let container: HTMLDivElement;
let root: Root;
/** Whether the page let the last click on a link go through (nothing navigates in the test). */
let followed: boolean[] = [];
const keepHere = (event: MouseEvent) => {
  if (!(event.target instanceof Element) || event.target.closest("a") === null) return;
  followed.push(!event.defaultPrevented);
  event.preventDefault();
};
const writeText = vi.fn(async (_text: string) => {});

function setNavigator(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true, writable: true });
}

function browse(userAgent: string, path = "/apps/glance/") {
  setNavigator("userAgent", userAgent);
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    `https://appflare.dev${path}`,
  );
}

beforeEach(() => {
  followed = [];
  writeText.mockClear();
  vi.mocked(track).mockClear();
  resetShareLinkCount();
  setNavigator("clipboard", { writeText });
  container = document.createElement("div");
  document.body.appendChild(container);
  document.addEventListener("click", keepHere);
  root = createRoot(container);
});

afterEach(() => {
  resetAnalytics();
  act(() => root.unmount());
  container.remove();
  document.removeEventListener("click", keepHere);
  for (const name of ["userAgent", "clipboard", "share"]) {
    delete (navigator as unknown as Record<string, unknown>)[name];
  }
});

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const link = (name: string) => {
  const found = [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no link ${name}`);
  return found;
};
const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

async function render(element: React.ReactNode) {
  act(() => root.render(element));
  await flush();
}

async function tap(element: HTMLElement) {
  act(() => element.click());
  await flush();
}

describe("Install Appflare in an app's own browser", () => {
  it("opens the sheet instead of the install, on an iPhone with the steps to leave X", async () => {
    browse(UA.xIphone, "/");
    await render(<InstallButton placement="home-hero-install" />);
    const install = link("Install Appflare");
    expect(install.getAttribute("aria-haspopup")).toBe("dialog");
    await tap(install);

    expect(followed).toEqual([false]);
    const sheet = dialog();
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(sheet?.getAttribute("aria-labelledby") ?? "");
    expect(text(title)).toBe("Open this in your browser");
    const description = document.getElementById(sheet?.getAttribute("aria-describedby") ?? "");
    expect(text(description)).toBe(
      "X's in-app browser may not be able to finish the Cloudflare sign-in.",
    );
    expect(text(sheet)).toContain("Tap ••• or the share icon");
    expect(text(sheet)).toContain("Choose Open in browser or Open in Safari");
    expect(sheet?.querySelector('a[href^="intent:"]')).toBeNull();
    // The focus is in the sheet, on its first action.
    expect(sheet?.contains(document.activeElement)).toBe(true);
    expect(text(document.activeElement)).toBe("Copy link");
    expect(track).toHaveBeenCalledWith("handoff_shown", {
      reason: "in_app_browser",
      app: "X",
      page: "/",
    });
  });

  it("copies the deploy page's address, says so, and counts it", async () => {
    browse(UA.xIphone, "/");
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    await tap(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith("https://appflare.dev/deploy/");
    expect(text(dialog())).toContain("Link copied");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Link copied");
    expect(track).toHaveBeenLastCalledWith("handoff_action", {
      action: "copy",
      reason: "in_app_browser",
      page: "/",
    });
  });

  it("shows the link to copy by hand where the clipboard is refused", async () => {
    browse(UA.xIphone, "/");
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    await tap(button("Copy link"));
    const field = dialog()?.querySelector("input");
    expect(field?.value).toBe("https://appflare.dev/deploy/");
    expect(field?.readOnly).toBe(true);
    expect(track).not.toHaveBeenCalledWith("handoff_action", expect.anything());
  });

  it("sends the page with the share sheet where there is one", async () => {
    browse(UA.xIphone, "/");
    const share = vi.fn(async (_data: ShareData) => {});
    setNavigator("share", share);
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    await tap(button("Send to my computer"));
    expect(share).toHaveBeenCalledWith({
      url: "https://appflare.dev/deploy/",
      title: "Install Appflare",
    });
    expect(track).toHaveBeenLastCalledWith("handoff_action", {
      action: "share",
      reason: "in_app_browser",
      page: "/",
    });
  });

  it("leaves Send to my computer out where the browser has no share sheet", async () => {
    browse(UA.xIphone, "/");
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    expect(() => button("Send to my computer")).toThrow();
  });

  it("hands the page to Chrome in one tap on Android", async () => {
    browse(UA.xAndroid, "/apps/glance/");
    await render(
      <InstallLink
        href="/install/glance/"
        handoffPath="/install/glance/"
        shareTitle="Install Glance"
      >
        Install
      </InstallLink>,
    );
    await tap(link("Install"));
    const open = link("Open in Chrome");
    expect(open.getAttribute("href")).toBe(
      "intent://appflare.dev/install/glance/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fappflare.dev%2Finstall%2Fglance%2F;end",
    );
    expect(document.activeElement).toBe(open);
    expect(text(dialog())).toContain("Use the menu (⋮) and choose Open in browser");
    await tap(open);
    expect(track).toHaveBeenLastCalledWith("handoff_action", {
      action: "open",
      reason: "in_app_browser",
      page: "/apps/glance/",
    });
  });

  it("lets the visitor go on installing here anyway, and counts it", async () => {
    browse(UA.xIphone, "/apps/glance/");
    await render(
      <InstallLink
        href="/install/glance/"
        handoffPath="/install/glance/"
        shareTitle="Install Glance"
      >
        Install
      </InstallLink>,
    );
    await tap(link("Install"));
    const anyway = link("Continue here anyway");
    expect(anyway.getAttribute("href")).toBe("/install/glance/");
    // Not the first thing the focus lands on.
    expect(document.activeElement).not.toBe(anyway);
    await tap(anyway);
    expect(followed).toEqual([false, true]);
    expect(track).toHaveBeenLastCalledWith("handoff_action", {
      action: "continue",
      reason: "in_app_browser",
      page: "/apps/glance/",
    });
  });

  it("says this in-app browser when the app does not name itself", async () => {
    browse(UA.unnamedIos);
    await render(<InstallButton placement="overview-primary" />);
    await tap(link("Install Appflare"));
    expect(text(dialog())).toContain(
      "This in-app browser may not be able to finish the Cloudflare sign-in.",
    );
    expect(track).toHaveBeenCalledWith("handoff_shown", {
      reason: "in_app_browser",
      app: null,
      page: "/apps/glance/",
    });
  });

  it("closes with Escape and with its close button", async () => {
    browse(UA.xIphone, "/");
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(dialog()).toBeNull();
    await tap(link("Install Appflare"));
    await tap(button("Close"));
    expect(dialog()).toBeNull();
  });
});

describe("Install Appflare in a real browser", () => {
  it.each([
    ["a computer", UA.chromeMac],
    ["a phone's browser", UA.safariIphone],
  ])("follows the link on %s, with no sheet", async (_name, userAgent) => {
    browse(userAgent, "/");
    await render(<InstallButton placement="home-hero-install" />);
    const install = link("Install Appflare");
    expect(install.getAttribute("aria-haspopup")).toBeNull();
    await tap(install);
    expect(followed).toEqual([true]);
    expect(dialog()).toBeNull();
    expect(track).not.toHaveBeenCalledWith("handoff_shown", expect.anything());
  });
});

describe("counting clicks", () => {
  const router = { subscribe: () => () => {} };
  const names = () => posthog.capture.mock.calls.map(([event]) => event as string);

  beforeEach(() => {
    posthog.capture.mockClear();
  });

  it("does not take the tap that opens the sheet for an install, but counts Continue here anyway", async () => {
    browse(UA.xIphone, "/");
    expect(startAnalytics(router)).toBe(true);
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    expect(dialog()).not.toBeNull();
    expect(names()).toEqual(["$pageview"]);

    await tap(link("Continue here anyway"));
    expect(names()).toEqual(["$pageview", "outbound_click", "install_button_clicked"]);
    expect(posthog.capture).toHaveBeenLastCalledWith("install_button_clicked", { path: "/" });
  });

  it("leaves a modified click to the browser, and counts it as an install", async () => {
    browse(UA.xIphone, "/");
    startAnalytics(router);
    await render(<InstallButton placement="home-hero-install" />);
    const install = link("Install Appflare");
    act(() => {
      install.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }),
      );
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(names()).toEqual(["$pageview", "outbound_click", "install_button_clicked"]);
  });

  it("counts the same link as an install where it is followed", async () => {
    browse(UA.safariIphone, "/");
    startAnalytics(router);
    await render(<InstallButton placement="home-hero-install" />);
    await tap(link("Install Appflare"));
    expect(names()).toEqual(["$pageview", "outbound_click", "install_button_clicked"]);
  });

  it("counts no visit for any link that opens a dialog", async () => {
    browse(UA.chromeMac, "/apps/glance/");
    startAnalytics(router);
    await render(
      <>
        <a href="https://github.com/glanceapp/glance/shot.png" aria-haspopup="dialog">
          Screenshot
        </a>
        <a href="https://github.com/glanceapp/glance">Source</a>
      </>,
    );
    await tap(link("Screenshot"));
    await tap(link("Source"));
    expect(posthog.capture.mock.calls.slice(1)).toEqual([
      ["outbound_click", { host: "github.com" }],
    ]);
  });
});

describe("the share line under an install button", () => {
  it("offers a phone's browser to share the page, counted once per page", async () => {
    browse(UA.safariIphone, "/apps/glance/");
    const share = vi.fn(async (_data: ShareData) => {});
    setNavigator("share", share);
    await render(
      <>
        <ShareLinkLine path="/install/glance/" title="Install Glance" />
        <ShareLinkLine path="/install/glance/" title="Install Glance" />
      </>,
    );
    expect(text(container)).toContain("Not at your computer? Share this link");
    expect(vi.mocked(track).mock.calls).toEqual([
      ["handoff_shown", { reason: "mobile", app: null, page: "/apps/glance/" }],
    ]);
    await tap(button("Share this link"));
    expect(share).toHaveBeenCalledWith({
      url: "https://appflare.dev/install/glance/",
      title: "Install Glance",
    });
    expect(track).toHaveBeenLastCalledWith("handoff_action", {
      action: "share",
      reason: "mobile",
      page: "/apps/glance/",
    });
  });

  it("copies the link where the phone has no share sheet", async () => {
    browse(UA.safariIphone, "/");
    await render(<ShareLinkLine path="/deploy/" title="Install Appflare" />);
    await tap(button("Copy this link"));
    expect(writeText).toHaveBeenCalledWith("https://appflare.dev/deploy/");
    expect(text(container)).toContain("Link copied");
  });

  it.each([
    ["a computer", UA.chromeMac],
    ["an app's own browser", UA.xIphone],
  ])("is not there on %s", async (_name, userAgent) => {
    browse(userAgent);
    await render(
      <>
        <ShareLinkLine path="/deploy/" title="Install Appflare" />
        <ShareLinkLine path="/deploy/" title="Install Appflare" reserve={false} />
      </>,
    );
    // Only the room the line keeps on a phone-sized screen, so that it
    // appearing on a phone's browser moves nothing: empty here.
    expect(container.children).toHaveLength(1);
    expect(text(container)).toBe("");
    expect(container.querySelector("button")).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it("keeps its room in the page as built, before it knows the browser", () => {
    const built = renderToString(<ShareLinkLine path="/deploy/" title="Install Appflare" />);
    expect(built).toMatch(/^<div class="[^"]*max-sm:min-h-11[^"]*"><\/div>$/);
    expect(renderToString(<ShareLinkLine path="/" title="x" reserve={false} />)).toBe("");
  });
});

describe("the install page's Get Appflare step", () => {
  const state: FlowState = {
    context: { page: "install", request: { kind: "app", slug: "glance" }, catalogApp: null },
    canRemember: true,
    view: { step: "get", intentSaved: true },
  };
  const apps = [{ slug: "glance", name: "Glance" }];

  it("sends an app's browser to the install page, not to 7 days it cannot use", async () => {
    browse(UA.xIphone, "/install/glance/");
    await render(<FlowPanel state={state} dispatch={() => {}} apps={apps} />);
    expect(text(container)).toContain(
      "X's in-app browser keeps Glance to itself, so open this link in your browser to continue there.",
    );
    expect(text(container)).not.toContain("7 days");
    await tap(link("Install Appflare"));
    await tap(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith("https://appflare.dev/install/glance/");
  });

  it("keeps the app for 7 days in a real browser, and goes to the deploy page with it", async () => {
    browse(UA.chromeMac, "/install/glance/");
    await render(<FlowPanel state={state} dispatch={() => {}} apps={apps} />);
    expect(text(container)).toContain(
      "This browser keeps Glance for 7 days, so you can continue installing it here then.",
    );
    await tap(link("Install Appflare"));
    expect(followed).toEqual([true]);
    expect(link("Install Appflare").getAttribute("href")).toBe("/deploy/?app=glance");
  });
});
