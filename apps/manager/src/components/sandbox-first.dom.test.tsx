import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardUrl } from "../cloudflare/dashboard-links";
import {
  NO_CONTAINERS_PERMISSION_REASON,
  needsWorkersPaidReason,
  r2NotEnabledReason,
} from "../sandbox/preflight";
import { SANDBOX_CAPABILITY_HREF } from "../sandbox/readiness";
import { ErrorMessageBanner, MessageText, messageHasLinks } from "./message-text";
import { SANDBOX_CAPABILITY_LINK_LABEL, SandboxMissingBanner } from "./sandbox-first";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "0123456789abcdef0123456789abcdef";

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

function links(): Array<{ text: string; href: string | null; target: string | null }> {
  return [...container.querySelectorAll("a")].map((a) => ({
    text: a.textContent ?? "",
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
  }));
}

describe("the banner saying why sandbox builds cannot be turned on", () => {
  it("links the account's Workers plans page instead of printing its address", () => {
    act(() =>
      root.render(
        <SandboxMissingBanner
          title="Sandbox builds are off, and Appflare cannot turn them on"
          missing={needsWorkersPaidReason(ACCOUNT)}
        />,
      ),
    );
    expect(links()).toEqual([
      {
        text: "Workers plans",
        href: dashboardUrl(ACCOUNT, "workers/plans"),
        target: "_blank",
      },
      { text: SANDBOX_CAPABILITY_LINK_LABEL, href: SANDBOX_CAPABILITY_HREF, target: null },
    ]);
    expect(container.textContent).not.toContain("https://");
    expect(container.textContent).toContain("Upgrade the account at Workers plans.");
  });

  it("links R2 in the dashboard, inside the parentheses", () => {
    act(() =>
      root.render(<SandboxMissingBanner title="Off" missing={r2NotEnabledReason(ACCOUNT)} />),
    );
    expect(links()[0]).toEqual({
      text: "R2 in the dashboard",
      href: dashboardUrl(ACCOUNT, "r2/overview"),
      target: "_blank",
    });
    expect(container.textContent).toContain("once to enable it (R2 in the dashboard).");
  });

  it("shows a reason without an address as text", () => {
    act(() =>
      root.render(<SandboxMissingBanner title="Off" missing={NO_CONTAINERS_PERMISSION_REASON} />),
    );
    expect(links().map((l) => l.text)).toEqual([SANDBOX_CAPABILITY_LINK_LABEL]);
    expect(container.textContent).toContain(NO_CONTAINERS_PERMISSION_REASON);
  });
});

describe("dashboard addresses in messages", () => {
  const message = `Upgrade the account at ${dashboardUrl(ACCOUNT, "workers/plans")}.`;

  it("link with the whole address as their text, unless the message is Appflare's own wording", () => {
    act(() => root.render(<MessageText message={message} />));
    expect(links()).toEqual([
      {
        text: dashboardUrl(ACCOUNT, "workers/plans"),
        href: dashboardUrl(ACCOUNT, "workers/plans"),
        target: "_blank",
      },
    ]);
    // The sentence reads as it was written, its full stop outside the link.
    expect(container.textContent).toBe(message);
  });

  it("show where an address a build printed really goes, such as a pre-filled API token page", () => {
    const tokenPage =
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&name=deploy";
    const zeroTrust = `https://one.dash.cloudflare.com/${ACCOUNT}/access/apps`;
    act(() =>
      root.render(
        <MessageText
          message={`Build failed: create a token at ${tokenPage}, then check (${zeroTrust}).`}
        />,
      ),
    );
    expect(links()).toEqual([
      { text: tokenPage, href: tokenPage, target: "_blank" },
      { text: zeroTrust, href: zeroTrust, target: "_blank" },
    ]);
    expect(container.textContent).toBe(
      `Build failed: create a token at ${tokenPage}, then check (${zeroTrust}).`,
    );
  });

  it("show the address in an error banner too", () => {
    act(() => root.render(<ErrorMessageBanner message={message} />));
    expect(links().map((l) => l.text)).toEqual([dashboardUrl(ACCOUNT, "workers/plans")]);
  });

  it("link only Cloudflare's dashboard, never another site", () => {
    const other =
      "See https://dash.cloudflare.com.example.com/x, https://dash.cloudflare.com@example.com/x, http://dash.cloudflare.com/x and https://example.com/workers/plans.";
    for (const mode of ["full", "short"] as const) {
      act(() => root.render(<MessageText message={other} dashboardLinks={mode} />));
      expect(links()).toEqual([]);
      expect(container.textContent).toBe(other);
    }
  });

  it("stay text in upper case or with a port, which Appflare never writes", () => {
    const other =
      "HTTPS://DASH.CLOUDFLARE.COM/x https://Dash.Cloudflare.com/x https://dash.cloudflare.com:443/x";
    act(() => root.render(<MessageText message={other} />));
    expect(links()).toEqual([]);
    expect(messageHasLinks(other)).toBe(false);
  });

  it("end before a quote, a bracket, a backtick or the punctuation that ends a sentence", () => {
    const address = "https://dash.cloudflare.com/x/y?z=1";
    for (const [before, after] of [
      ['{"url":"', '"}'],
      ["'", "'"],
      ["<", ">"],
      ["`", "`"],
      ["(", ")."],
      ["Open ", "!"],
      ["Open ", "?"],
      ["Open ", "...;"],
    ]) {
      act(() => root.render(<MessageText message={`${before}${address}${after}`} />));
      expect(links(), `${before}…${after}`).toEqual([
        { text: address, href: address, target: "_blank" },
      ]);
      expect(container.textContent).toBe(`${before}${address}${after}`);
    }
  });

  it("link the address inside a Markdown link to another site, and nothing else of it", () => {
    act(() =>
      root.render(<MessageText message="See [the plans](https://dash.cloudflare.com/x)." />),
    );
    expect(links()).toEqual([
      {
        text: "https://dash.cloudflare.com/x",
        href: "https://dash.cloudflare.com/x",
        target: "_blank",
      },
    ]);
    expect(container.textContent).toBe("See [the plans](https://dash.cloudflare.com/x).");
  });

  it("are counted as links, so a banner puts the message where links show", () => {
    expect(messageHasLinks(message)).toBe(true);
    expect(messageHasLinks("Open https://one.dash.cloudflare.com/ now.")).toBe(true);
    expect(messageHasLinks("See [GitHub access](/settings/building#github-access).")).toBe(true);
    expect(messageHasLinks("Nothing to open at https://example.com/x.")).toBe(false);
  });

  it("show a short label only for the exact pages Appflare's own wording names", () => {
    act(() =>
      root.render(
        <MessageText
          message={`Upgrade at ${dashboardUrl(null, "workers/plans")} or ${dashboardUrl(ACCOUNT, "r2/overview")}.`}
          dashboardLinks="short"
        />,
      ),
    );
    expect(links().map((l) => l.text)).toEqual(["Workers plans", "R2 in the dashboard"]);
  });

  it("show any other address in full even in Appflare's wording, such as one an app's name carries", () => {
    const crafted =
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%5D&n=/workers/plans";
    const near = `${dashboardUrl(ACCOUNT, "workers/plans")}/more`;
    act(() =>
      root.render(
        <SandboxMissingBanner title="Off" missing={`X ${crafted} cannot be built. See ${near}.`} />,
      ),
    );
    expect(links().slice(0, 2)).toEqual([
      { text: crafted, href: crafted, target: "_blank" },
      { text: near, href: near, target: "_blank" },
    ]);
  });

  it("cost one pass over a long log line", () => {
    // Dots that do not end the line: a pattern that tries every length of
    // the address takes 1.5 s on 30 KB of this, and grows with its square.
    const long = `https://dash.cloudflare.com/${".".repeat(200_000)}x`;
    const line = `${long} then https://dash.cloudflare.com/${".".repeat(1000)}`;
    const started = performance.now();
    expect(messageHasLinks(line)).toBe(true);
    act(() => root.render(<MessageText message={line} />));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(links().map((l) => l.href)).toEqual([long, "https://dash.cloudflare.com/"]);
    expect(container.textContent).toBe(line);
  });
});
