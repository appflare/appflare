import { describe, expect, it } from "vitest";
import type { FlowPage, FlowState } from "../install/flow.ts";
import { installLinkEvent, registeredEvent } from "./flow-events.ts";

const origin = "https://appflare.example.com";
const appPage: FlowPage = {
  page: "install",
  request: { kind: "app", slug: "2fa" },
  catalogApp: null,
};
const repoPage: FlowPage = {
  page: "install",
  request: { kind: "repo", repo: "owner/repo" },
  catalogApp: null,
};

function at(context: FlowPage, view: FlowState["view"]): FlowState {
  return { context, canRemember: true, view };
}

describe("installLinkEvent", () => {
  it("says an app link went on to the visitor's Appflare, without its address", () => {
    const event = installLinkEvent(
      at(appPage, { step: "opening", origin, target: `${origin}/install/2fa`, remembered: true }),
      true,
    );
    expect(event).toEqual({
      kind: "app",
      slug: "2fa",
      repo: null,
      has_manager: true,
      target: "manager",
    });
    expect(JSON.stringify(event)).not.toContain("example.com");
  });

  it("says a repository link found no Appflare", () => {
    expect(installLinkEvent(at(repoPage, { step: "ask" }), false)).toEqual({
      kind: "repo",
      slug: null,
      repo: "owner/repo",
      has_manager: false,
      target: "no-manager",
    });
  });

  it("sends nothing for a link that names nothing, or for /my/", () => {
    const invalid: FlowPage = { page: "install", request: null, catalogApp: null };
    expect(installLinkEvent(at(invalid, { step: "invalid" }), false)).toBeNull();
    expect(
      installLinkEvent(at({ page: "my" }, { step: "none", forgotten: false }), false),
    ).toBeNull();
  });
});

describe("registeredEvent", () => {
  it("records that /my/ remembered an Appflare, and nothing about it", () => {
    const saved = at({ page: "my" }, { step: "saved", origin, intent: null, justRemembered: true });
    const event = registeredEvent({ type: "remember" }, saved);
    expect(event).toEqual({ has_manager: true, page: "my" });
    expect(JSON.stringify(event)).not.toContain("example.com");
  });

  it("records a Remember on an install page", () => {
    const opening = at(appPage, { step: "opening", origin, target: origin, remembered: true });
    expect(registeredEvent({ type: "remember" }, opening)).toEqual({
      has_manager: true,
      page: "install",
    });
  });

  it("ignores Just this once, a browser that kept nothing, and other clicks", () => {
    const once = at(appPage, { step: "opening", origin, target: origin, remembered: false });
    expect(registeredEvent({ type: "remember" }, once)).toBeNull();
    expect(registeredEvent({ type: "once" }, once)).toBeNull();
    const refused = at({ page: "my" }, { step: "cannot-remember", origin });
    expect(registeredEvent({ type: "remember" }, refused)).toBeNull();
  });
});
