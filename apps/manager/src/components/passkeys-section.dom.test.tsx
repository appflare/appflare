import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PasskeyRow } from "../server/passkeys.functions";

/** "Your passkeys", with the server call standing in. */
vi.mock("../server/passkeys.functions", () => ({ removePasskey: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { PasskeysSection } = await import("./passkeys-section");

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

const base = { provider: null, synced: true, createdAt: "2026-09-20T10:00:00.000Z" };

describe("the passkeys list", () => {
  it("names the address a passkey works at when Appflare has since moved", () => {
    const passkeys: PasskeyRow[] = [
      { id: "p1", name: "Laptop", ...base, worksAt: null },
      { id: "p2", name: "Phone", ...base, worksAt: "appflare.ada.workers.dev" },
    ];
    act(() => root.render(<PasskeysSection passkeys={passkeys} />));
    const rows = [...container.querySelectorAll("tbody tr")].map(
      (tr) => tr.querySelector("td")?.textContent,
    );
    expect(rows).toEqual(["Laptop", "PhoneWorks at appflare.ada.workers.dev"]);
  });
});

describe("passkeys before Appflare moves to its domain", () => {
  it("offers no passkey at workers.dev, and says when instead", () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = () => {};
    act(() => root.render(<PasskeysSection passkeys={[]} afterMove="appflare.example.com" />));
    expect(container.textContent).toContain(
      "Add passkeys after Appflare moves to appflare.example.com.",
    );
    expect(container.textContent).not.toContain("No passkeys yet");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    act(() => root.render(<PasskeysSection passkeys={[]} />));
    expect(container.textContent).toContain("Add passkey");
  });
});
