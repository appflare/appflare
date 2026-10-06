import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionView, RECONNECT_COPY } from "../cloudflare/connection-view";
import type { ReconnectOutcome } from "../cloudflare/reconnect-outcome";
import type { TokenStatus } from "../server/token.functions";
import type { SavedToken } from "./cloudflare-token-form";

/**
 * Your account's Cloudflare connection, with the token form and the sign-in
 * start standing in, so nothing here talks to Cloudflare: the form is a
 * button that reports a saved token.
 */
let saved: SavedToken = { accountId: "a1", workerName: "appflare", replacedAuthorization: false };
vi.mock("./cloudflare-token-form", () => ({
  CloudflareTokenForm: ({ onSaved }: { onSaved: (saved: SavedToken) => Promise<void> }) => (
    <button type="button" onClick={() => void onSaved(saved)}>
      Save the new token
    </button>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));
const startCloudflareReconnect = vi.fn();
vi.mock("../cloudflare/reconnect.functions", () => ({ startCloudflareReconnect }));

const { CloudflareTokenCard } = await import("./cloudflare-token-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  startCloudflareReconnect.mockReset();
  saved = { accountId: "a1", workerName: "appflare", replacedAuthorization: false };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(within: HTMLElement, label: string): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

function hasButton(within: HTMLElement, label: string): boolean {
  return [...within.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
}

const API_TOKEN: ConnectionView = {
  kind: "api_token",
  state: "connected",
  problem: null,
  problemAt: null,
  connectedSince: "2026-09-28T09:00:00.000Z",
  ready: true,
  oauth: null,
};

const OAUTH: ConnectionView = {
  kind: "oauth",
  state: "connected",
  problem: null,
  problemAt: null,
  connectedSince: "2026-09-28T09:00:00.000Z",
  ready: true,
  oauth: {
    clientId: "b99863433175d812f9595af56dd1b71d",
    scopes: ["workers-scripts.write"],
    missingScopes: [],
    renewedAt: "2026-10-01T09:00:00.000Z",
  },
};

function status(connection: ConnectionView): TokenStatus {
  return {
    configured: true,
    accountId: "a1",
    accountName: "Acme",
    workerName: "appflare",
    verifiedAt: null,
    hasSecret: true,
    connection,
  };
}

function render(
  connection: ConnectionView,
  props: {
    canRotate?: boolean;
    outcome?: ReconnectOutcome | null;
    startOpen?: boolean;
    managerUrl?: string;
  } = {},
) {
  act(() =>
    root.render(
      <TooltipProvider>
        <CloudflareTokenCard
          status={status(connection)}
          canRotate={props.canRotate ?? true}
          outcome={props.outcome ?? null}
          startOpen={props.startOpen ?? false}
          managerUrl={props.managerUrl ?? null}
        />
      </TooltipProvider>,
    ),
  );
}

function dialog(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error("no dialog");
  return found;
}

async function chooseWay(label: string) {
  const radio = [...dialog().querySelectorAll("label")].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  if (radio === undefined) throw new Error(`no choice "${label}"`);
  await act(async () => radio.click());
  await settle();
}

describe("CloudflareTokenCard", () => {
  it("shows the account and how Appflare connects; the rest under Details", async () => {
    render(API_TOKEN);
    expect(container.textContent).toContain("Connected withAn API token");
    expect(container.textContent).not.toContain("Working.");
    render(OAUTH, { managerUrl: "https://appflare.example.com" });
    expect(container.textContent).toContain("Connected withCloudflare sign-in");
    expect(container.textContent).not.toContain("appflare.dev");
    await act(async () => button(container, "Details").click());
    await settle();
    expect(container.textContent).toContain("Appflare renews its access by itself.");
    expect(container.textContent).toContain("b99863433175d812f9595af56dd1b71d");
    expect(container.querySelector('a[href^="https://appflare.dev/my/"]')).not.toBeNull();
    // Each permission by its name, why Appflare holds it one more click away.
    expect(container.textContent).toContain("Permissions (1)");
    await act(async () => button(container, "Workers Scripts").click());
    await settle();
    expect(container.textContent).toContain("Workers Scripts lets Appflare install, update");
  });

  it("says why a connection needs reconnecting under Details, in one line above", async () => {
    render({
      ...OAUTH,
      state: "needs_reconnect",
      ready: false,
      problem: "Cloudflare no longer accepts this connection: it was withdrawn in Cloudflare.",
    });
    expect(container.textContent).toContain(RECONNECT_COPY.title);
    expect(container.textContent).toContain(RECONNECT_COPY.adminLine);
    expect(container.textContent).not.toContain("withdrawn");
    await act(async () => button(container, "Details").click());
    await settle();
    expect(container.textContent).toContain("it was withdrawn in Cloudflare");
  });

  it("announces a new token in a status that was there with the form", async () => {
    render(API_TOKEN);
    await act(async () => button(container, "Change how Appflare connects").click());
    await settle();
    await chooseWay("Use a new API token");
    const region = dialog().querySelector('[role="status"]');
    expect(region?.textContent).toBe("");

    await act(async () => button(dialog(), "Save the new token").click());
    await settle();
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toContain("Token saved");
    expect(region?.textContent).toContain('Appflare redeploys "appflare" to use it.');
    expect(dialog().querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("says the token replaced Cloudflare sign-in when it did", async () => {
    saved = { accountId: "a1", workerName: "appflare", replacedAuthorization: true };
    render(OAUTH);
    await act(async () => button(container, "Change how Appflare connects").click());
    await settle();
    await chooseWay("Use an API token");
    await act(async () => button(dialog(), "Save the new token").click());
    await settle();
    expect(dialog().textContent).toContain("Connected with the API token");
    expect(dialog().textContent).toContain("withdrew its Cloudflare sign-in");
  });

  it("offers Reconnect Cloudflare while the connection needs it, and sends the tab to Cloudflare", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      origin: "https://appflare.example.com",
      host: "appflare.example.com",
      assign,
    });
    startCloudflareReconnect.mockResolvedValue({
      url: "https://dash.cloudflare.com/oauth2/auth?client_id=x",
      origin: "https://appflare.example.com",
    });
    render({ ...OAUTH, state: "needs_reconnect", ready: false });
    expect(container.textContent).toContain("Your apps keep running.");
    await act(async () => button(container, "Reconnect Cloudflare").click());
    await settle();
    // Exactly two ways.
    expect(dialog().querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(dialog().textContent).toContain(
      "Approve on Cloudflare, then confirm appflare.example.com on appflare.dev to come back.",
    );
    await act(async () => button(dialog(), "Continue to Cloudflare").click());
    await settle();
    expect(startCloudflareReconnect).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/auth?client_id=x");
  });

  it("shows why a start was refused, and stays", async () => {
    startCloudflareReconnect.mockRejectedValue(new Error("Only administrators can do this."));
    render(API_TOKEN, { startOpen: true });
    await settle();
    await act(async () => button(dialog(), "Continue to Cloudflare").click());
    await settle();
    expect(dialog().textContent).toContain("Only administrators can do this.");
  });

  it("shows how a sign-in ended, with Start again when that can help", async () => {
    render(API_TOKEN, { outcome: "missing-permissions" });
    expect(container.textContent).toContain("Some permissions were not granted");
    await act(async () => button(container, "Start again").click());
    await settle();
    expect(dialog().textContent).toContain("Sign in with Cloudflare");
    render(OAUTH, { outcome: "connected" });
    expect(container.textContent).toContain("Connected with Cloudflare sign-in");
  });

  it("offers members no way to change the connection", () => {
    render({ ...OAUTH, state: "needs_reconnect", ready: false }, { canRotate: false });
    expect(hasButton(container, "Reconnect Cloudflare")).toBe(false);
    expect(container.textContent).toContain(RECONNECT_COPY.memberLine);
    render(API_TOKEN, { canRotate: false, outcome: "expired" });
    expect(hasButton(container, "Change how Appflare connects")).toBe(false);
    expect(hasButton(container, "Start again")).toBe(false);
  });
});
