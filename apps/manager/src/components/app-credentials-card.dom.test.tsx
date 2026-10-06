import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ replaceAppCredentials: vi.fn() }));
vi.mock("../installs/app-credentials.functions", () => ({
  replaceAppCredentials: server.replaceAppCredentials,
}));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));

const { AppCredentialsCard } = await import("./app-credentials-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TooltipProvider>
        <AppCredentialsCard
          installId="01J00000000000000000000000"
          appName="OpenSEO"
          secretNames={["API_KEY"]}
          tokenPermissions={[]}
          canEdit
        />
      </TooltipProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** The field labelled `label`. */
function field(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  const input = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field "${label}"`);
  return input;
}

/** Types into a field the way a paste does (the fields are uncontrolled). */
function type(label: string, value: string) {
  const input = field(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function storeButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Store on the sandbox Worker"),
  );
  if (button === undefined) throw new Error("no store button");
  return button;
}

async function submit() {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

async function storeToken() {
  type("New app token", "a-token");
  await submit();
}

describe("storing the app's token", () => {
  it("announces what was stored in a region that was on the page before it", async () => {
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    server.replaceAppCredentials.mockResolvedValue({ stored: ["the app token"] });
    await storeToken();
    expect(container.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain("Stored on the sandbox Worker: the app token.");
    expect(region?.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("announces a failure as an alert", async () => {
    server.replaceAppCredentials.mockRejectedValue(new Error("The sandbox Worker is busy."));
    await storeToken();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("The sandbox Worker is busy.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
});

describe("the values entered", () => {
  it("are sent from the fields, never put in the page's markup, and cleared once stored", async () => {
    expect(storeButton().disabled).toBe(true);
    type("New app token", "  pasted-app-token-0123  ");
    type("New value of API_KEY", "pasted-secret-4567");
    expect(storeButton().disabled).toBe(false);
    expect(container.innerHTML).not.toContain("pasted-app-token-0123");
    expect(container.innerHTML).not.toContain("pasted-secret-4567");
    server.replaceAppCredentials.mockResolvedValue({ stored: ["the app token", "API_KEY"] });
    await submit();
    expect(server.replaceAppCredentials).toHaveBeenCalledWith({
      data: {
        installId: "01J00000000000000000000000",
        appToken: "pasted-app-token-0123",
        secrets: { API_KEY: "pasted-secret-4567" },
      },
    });
    expect(container.innerHTML).not.toContain("pasted-app-token-0123");
    expect(container.innerHTML).not.toContain("pasted-secret-4567");
    expect(field("New app token").value).toBe("");
    expect(field("New value of API_KEY").value).toBe("");
    expect(storeButton().disabled).toBe(true);
  });

  it("send only the fields given a value, and nothing while every field is empty", async () => {
    type("New value of API_KEY", "only-the-secret");
    server.replaceAppCredentials.mockResolvedValue({ stored: ["API_KEY"] });
    await submit();
    expect(server.replaceAppCredentials).toHaveBeenCalledWith({
      data: { installId: "01J00000000000000000000000", secrets: { API_KEY: "only-the-secret" } },
    });
    server.replaceAppCredentials.mockClear();
    type("New app token", "   ");
    await submit();
    expect(server.replaceAppCredentials).not.toHaveBeenCalled();
  });

  it("stay in their fields when storing fails, to try again", async () => {
    type("New app token", "a-token");
    server.replaceAppCredentials.mockRejectedValue(new Error("The sandbox Worker is busy."));
    await submit();
    expect(field("New app token").value).toBe("a-token");
    expect(storeButton().disabled).toBe(false);
  });
});
