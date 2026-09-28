import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowPage, FlowState, FlowView } from "../../install/flow.ts";
import { DEPLOY_BUTTON_IMAGE, DEPLOY_URL, FlowPanel } from "./flow-panel.tsx";

const origin = "https://appflare.example.com";
const apps = [{ slug: "2fa", name: "2FA" }];
const installPage: FlowPage = {
  page: "install",
  request: { kind: "app", slug: "2fa" },
  catalogApp: null,
};

function render(
  view: FlowView,
  context: FlowPage = installPage,
  canRemember = true,
  forwarding = true,
) {
  const state: FlowState = { context, canRemember, view };
  return renderToStaticMarkup(
    <FlowPanel state={state} dispatch={() => {}} apps={apps} forwarding={forwarding} />,
  );
}

describe("FlowPanel", () => {
  it("shows where a remembered visitor is going, with the link and Change", () => {
    const html = render({
      step: "opening",
      origin,
      target: `${origin}/install/2fa`,
      remembered: true,
    });
    expect(html).toContain("Opening in your Appflare at");
    expect(html).toMatch(new RegExp(`<strong[^>]*>${origin.replaceAll(".", "\\.")}</strong>`));
    // The full address of the page is there on demand, not in the sentence.
    const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(details).toContain("<summary");
    expect(details).toContain(`href="${origin}/install/2fa"`);
    expect(html.split("/install/2fa").length - 1).toBe(2);
    expect(html).toContain(">Change<");
  });

  it("waits for a click when the visitor came back", () => {
    const html = render(
      { step: "opening", origin, target: `${origin}/install/2fa`, remembered: true },
      installPage,
      true,
      false,
    );
    expect(html).toContain("Your Appflare is at");
    expect(html).toContain(">Open in your Appflare<");
  });

  it("asks a first-time visitor, and says when nothing can be remembered", () => {
    const html = render({ step: "ask" });
    expect(html).toContain("Do you have Appflare?");
    expect(html).toContain("Enter its address");
    expect(html).toContain("Get Appflare");
    expect(html).toContain("opens 2FA in your");
    expect(html).not.toContain("does not let this site remember");
    expect(render({ step: "ask" }, installPage, false)).toContain(
      "does not let this site remember your Appflare",
    );
  });

  it("offers the Deploy button first, then the installer, then the way back", () => {
    const html = render({ step: "get", intentSaved: true });
    const deploy = html.indexOf(DEPLOY_URL);
    const installer = html.indexOf("build the installer from a checkout");
    expect(deploy).toBeGreaterThan(-1);
    expect(installer).toBeGreaterThan(deploy);
    expect(html).not.toContain("npx create-appflare");
    expect(html).toContain(`src="${DEPLOY_BUTTON_IMAGE}"`);
    expect(html).toContain("Your account › Use this Appflare on appflare.dev");
    expect(html).toContain("keeps 2FA for 7 days");
  });

  it("shows an address error next to the field", () => {
    const html = render({
      step: "enter",
      value: "javascript:x",
      error: "That is not a web address.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value="javascript:x"');
  });

  it("asks before remembering, naming the address it replaces", () => {
    const html = render({ step: "remember", origin, replaces: "https://old.example.com" });
    expect(html).toMatch(
      new RegExp(`Remember <strong[^>]*>${origin.replaceAll(".", "\\.")}</strong>`),
    );
    expect(html).toContain("https://old.example.com");
    expect(html).toContain("Just this once");
    const my = render({ step: "remember", origin, replaces: null }, { page: "my" });
    expect(my).toContain(">Cancel<");
    expect(my).not.toContain("Just this once");
  });

  it("says a link is not valid and points to the apps", () => {
    const html = render({ step: "invalid" });
    expect(html).toContain("This link is not valid");
    expect(html).toContain('href="/apps/"');
  });

  it("offers the catalog's app before a build from the repository", () => {
    const html = render(
      { step: "in-catalog", app: { slug: "2fa", name: "2FA" } },
      { page: "install", request: { kind: "repo", repo: "wuzf/2fa" }, catalogApp: null },
    );
    expect(html).toContain('href="/install/2fa/"');
    expect(html).toContain("Build from the repository");
    expect(html).toContain("Workers Paid");
  });

  it("on /my/, continues a saved install and can forget the Appflare", () => {
    const html = render(
      {
        step: "saved",
        origin,
        intent: { kind: "app", slug: "2fa", savedAt: "2026-09-28T12:00:00.000Z" },
        justRemembered: true,
      },
      { page: "my" },
    );
    expect(html).toContain("Appflare remembered");
    expect(html).toContain('href="/install/2fa/"');
    expect(html).toContain("Continue installing 2FA");
    expect(html).toContain("Forget this Appflare");
    const repo = render(
      {
        step: "saved",
        origin,
        intent: { kind: "repo", repo: "o/r", savedAt: "2026-09-28T12:00:00.000Z" },
        justRemembered: false,
      },
      { page: "my" },
    );
    expect(repo).toContain('href="/install/?repo=o/r"');
  });

  it("on /my/, says an address cannot be remembered", () => {
    const html = render({ step: "cannot-remember", origin }, { page: "my" }, false);
    expect(html).toContain("This browser cannot remember your Appflare");
    expect(html).toContain(origin);
  });
});
