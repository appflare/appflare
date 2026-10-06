import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recovery = vi.hoisted(() => ({
  sendPasswordResetLink: vi.fn(async () => ({ email: "grace@example.com" })),
  issuePasswordRecoveryCode: vi.fn(async () => ({ email: "grace@example.com", code: "ABCD-1234" })),
}));
vi.mock("../server/recovery.functions", () => recovery);

const { ResetPasswordDialog } = await import("./reset-password-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = { id: "u2", name: "Grace", email: "grace@example.com" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  recovery.sendPasswordResetLink.mockClear();
  recovery.issuePasswordRecoveryCode.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(open: boolean, emailReset: boolean) {
  act(() =>
    root.render(
      <ResetPasswordDialog
        user={user}
        emailReset={emailReset}
        open={open}
        onOpenChange={() => {}}
      />,
    ),
  );
}

function primary(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (button === undefined) throw new Error(`no "${name}" button`);
  return button;
}

describe("the reset password dialog, mounted before it opens", () => {
  it("offers only a recovery code once reset emails were turned off on the same page", async () => {
    render(false, true);
    render(false, false);
    render(true, false);
    expect(document.body.textContent).not.toContain("Send reset link");
    await act(async () => primary("Show recovery code").click());
    expect(recovery.sendPasswordResetLink).not.toHaveBeenCalled();
    expect(recovery.issuePasswordRecoveryCode).toHaveBeenCalledOnce();
  });

  it("starts clean each time it opens", async () => {
    render(true, true);
    await act(async () => primary("Send reset link").click());
    expect(document.body.textContent).toContain("Reset link sent");
    render(false, true);
    render(true, true);
    expect(document.body.textContent).not.toContain("Reset link sent");
    expect(primary("Send reset link")).toBeDefined();
  });

  it('reads "sent" from a status region that was in the dialog before it', async () => {
    render(true, true);
    const region = document.querySelector('[role="dialog"] [role="status"]');
    expect(region?.textContent).toBe("");
    await act(async () => primary("Send reset link").click());
    expect(document.querySelector('[role="dialog"] [role="status"]')).toBe(region);
    expect(region?.textContent).toContain("Reset link sent");
    expect(region?.querySelector('[role="status"]')).toBeNull();
  });
});
