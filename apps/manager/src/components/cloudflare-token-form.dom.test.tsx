import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifyTokenResult } from "../cloudflare/verify-token";

const server = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  rotateToken: vi.fn(),
  saveToken: vi.fn(),
  connectCloudflare: vi.fn(),
}));
vi.mock("../server/token.functions", () => ({
  verifyToken: server.verifyToken,
  rotateToken: server.rotateToken,
  saveToken: server.saveToken,
}));
vi.mock("../server/setup.functions", () => ({ connectCloudflare: server.connectCloudflare }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));

const { CloudflareTokenForm, SetupTokenForm } = await import("./cloudflare-token-form");

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
  vi.clearAllMocks();
});

/** Types into the token field the way a paste does (the field is uncontrolled). */
function pasteToken(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error("no token field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector("form");
  await act(async () => {
    form?.requestSubmit();
  });
}

function showRotate() {
  act(() =>
    root.render(
      <TooltipProvider>
        <CloudflareTokenForm mode="rotate" onSaved={() => {}} />
      </TooltipProvider>,
    ),
  );
}

const VERIFIED: VerifyTokenResult = {
  ok: true,
  tokenType: "account",
  accountId: "0123456789abcdef0123456789abcdef",
  accountName: "Acme",
  permissionsOk: true,
  missing: [],
};

describe("rotating the token", () => {
  it("announces a verified token in a region that was on the page before it", async () => {
    showRotate();
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    server.verifyToken.mockResolvedValue(VERIFIED);
    pasteToken("a-token");
    await submit();
    expect(container.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain("Token verified");
    expect(region?.textContent).toContain("Account API token for Acme");
    // The banner inside does not announce itself a second time.
    expect(region?.querySelector('[role="status"], [role="alert"]')).toBeNull();
  });

  it("announces a token that cannot manage Workers as an alert", async () => {
    showRotate();
    server.verifyToken.mockResolvedValue({ ...VERIFIED, permissionsOk: false });
    pasteToken("a-token");
    await submit();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts.map((a) => a.textContent)).toEqual([
      expect.stringContaining("This token cannot manage Workers"),
    ]);
  });

  it("announces a failed verification as an alert", async () => {
    showRotate();
    server.verifyToken.mockResolvedValue({ ok: false, error: "Invalid API token." });
    pasteToken("a-token");
    await submit();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Verification failed");
    expect(alerts[0]?.textContent).toContain("Invalid API token.");
  });
});

describe("a pasted token", () => {
  it("never reaches the page's markup, in rotation or in setup", async () => {
    const token = "pasted-token-0123456789";
    showRotate();
    server.verifyToken.mockResolvedValue(VERIFIED);
    pasteToken(token);
    await submit();
    expect(server.verifyToken).toHaveBeenCalledWith({ data: { token } });
    expect(container.innerHTML).not.toContain(token);

    act(() =>
      root.render(
        <TooltipProvider>
          <SetupTokenForm mode="first-run" onContinue={() => {}} />
        </TooltipProvider>,
      ),
    );
    server.connectCloudflare.mockRejectedValue(new Error("Cloudflare refused the token."));
    pasteToken(token);
    await submit();
    expect(server.connectCloudflare).toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(token);
  });
});

describe("the setup token step", () => {
  function showSetup() {
    act(() =>
      root.render(
        <TooltipProvider>
          <SetupTokenForm mode="first-run" onContinue={() => {}} />
        </TooltipProvider>,
      ),
    );
  }

  it("announces a refusal once, as an alert", async () => {
    showSetup();
    server.connectCloudflare.mockRejectedValue(new Error("Cloudflare refused the token."));
    pasteToken("a-token");
    await submit();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Cloudflare refused the token.");
    // No hand-made wrapper around a banner that has a role of its own.
    expect(alerts[0]?.querySelector('[role="alert"]')).toBeNull();
    expect(alerts[0]?.parentElement?.closest('[role="alert"]')).toBeNull();
  });

  it("announces the connected account in a region that was on the page before it", async () => {
    vi.useFakeTimers();
    try {
      showSetup();
      const region = container.querySelector('[role="status"]');
      expect(region).not.toBeNull();
      expect(region?.textContent).toBe("");
      server.connectCloudflare.mockResolvedValue({
        accountId: "0123456789abcdef0123456789abcdef",
        accountName: "Acme",
        workerName: "appflare",
        missing: [],
      });
      pasteToken("a-token");
      await submit();
      expect(container.querySelector('[role="status"]')).toBe(region);
      expect(region?.textContent).toContain("Connected to Acme");
    } finally {
      vi.useRealTimers();
    }
  });
});
