import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../server/users.functions";

/** The users settings' Users table, with the server calls standing in. */
const server = vi.hoisted(() => ({
  changeUserRole: vi.fn(async (_: unknown) => ({
    accessPolicy: "off" as const,
    appAccessPolicy: "off" as const,
  })),
  deleteUser: vi.fn(async (_: unknown) => ({
    accessPolicy: "off" as const,
    appAccessPolicy: "off" as const,
  })),
  transferOwnership: vi.fn(async (_: unknown) => {}),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../server/users.functions", () => ({
  addUser: vi.fn(),
  changeUserRole: server.changeUserRole,
  deleteUser: server.deleteUser,
  transferOwnership: server.transferOwnership,
}));
vi.mock("../server/recovery.functions", () => ({
  issuePasswordRecoveryCode: vi.fn(),
  sendPasswordResetLink: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: server.invalidate }) }));

const { UsersSection } = await import("./users-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.invalidate.mockReset();
  server.deleteUser.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const created = "2026-09-20T10:00:00.000Z";
const USERS: UserRow[] = [
  {
    id: "u1",
    email: "ada@example.com",
    name: "Ada",
    role: "admin",
    isOwner: true,
    createdAt: created,
  },
  {
    id: "u2",
    email: "grace@example.com",
    name: "Grace",
    role: "admin",
    isOwner: false,
    createdAt: created,
  },
  {
    id: "u3",
    email: "alan@example.com",
    name: "Alan",
    role: "member",
    isOwner: false,
    createdAt: created,
  },
];

describe("the users table", () => {
  it("shows each role once, worded as the account menu words it", () => {
    act(() =>
      root.render(
        <Toasty>
          <UsersSection users={USERS} viewerId="u1" viewerIsOwner emailReset={false} />
        </Toasty>,
      ),
    );
    const roles = [...container.querySelectorAll("tbody tr")].map(
      (tr) => tr.querySelectorAll("td")[2]?.textContent,
    );
    expect(roles).toEqual(["Owner", "Admin", "Member"]);
  });
});

/** The table as the owner (Ada) sees it, or as `viewerId` does. */
function tableOf(users: UserRow[], viewerId = "u1") {
  const viewerIsOwner = users.find((u) => u.id === viewerId)?.isOwner ?? false;
  return (
    <Toasty>
      <UsersSection
        users={users}
        viewerId={viewerId}
        viewerIsOwner={viewerIsOwner}
        emailReset={false}
      />
    </Toasty>
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name,
  );
  if (found === undefined) throw new Error(`no "${name}" button`);
  return found;
}

/** Opens a row's menu and picks `item` from it. */
async function pick(email: string, item: string) {
  const trigger = button(`Actions for ${email}`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await settle();
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === item,
  );
  if (found === undefined) throw new Error(`no "${item}" in the menu`);
  await act(async () => found.click());
  await settle();
}

/** Types the email the open confirmation asks for, then presses its action. */
async function confirm(typed: string, action: string) {
  const input = document.querySelector<HTMLInputElement>('[role="alertdialog"] input');
  if (input === null) throw new Error("no confirmation input");
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, typed);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(action).click());
  await settle();
}

describe("the focus after a row's dialog", () => {
  it("goes back to the menu's button when the reset password dialog closes", async () => {
    act(() => root.render(tableOf(USERS)));
    await pick("grace@example.com", "Reset password");
    expect(document.body.textContent).toContain("Reset Grace's password");
    await act(async () => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(button("Actions for grace@example.com"));
  });

  it("goes back to the menu's button after a role change", async () => {
    act(() => root.render(tableOf(USERS)));
    await pick("alan@example.com", "Make admin");
    await act(async () => button("Make admin").click());
    await settle();
    expect(server.changeUserRole).toHaveBeenCalledWith({
      data: { userId: "u3", role: "admin" },
    });
    expect(document.activeElement).toBe(button("Actions for alan@example.com"));
  });

  it("goes back to the menu's button when a deletion is cancelled", async () => {
    act(() => root.render(tableOf(USERS)));
    await pick("alan@example.com", "Delete user");
    await act(async () => button("Cancel").click());
    await settle();
    expect(server.deleteUser).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("Actions for alan@example.com"));
  });

  it("moves to Add user once a deleted user's row is gone", async () => {
    act(() => root.render(tableOf(USERS)));
    // The list comes back without them before the dialog closes.
    server.invalidate.mockImplementationOnce(async () => {
      root.render(tableOf(USERS.filter((u) => u.id !== "u3")));
    });
    await pick("alan@example.com", "Delete user");
    await confirm("alan@example.com", "Delete user");
    expect(server.deleteUser).toHaveBeenCalledWith({ data: { userId: "u3" } });
    expect(document.body.textContent).not.toContain("alan@example.com");
    expect(document.activeElement).toBe(button("Add user"));
  });

  it("moves to Add user after a deletion even when another row's dialog was used before", async () => {
    act(() => root.render(tableOf(USERS)));
    // Another row's menu button is then the last one the dialogs saw that is still on the page.
    await pick("grace@example.com", "Reset password");
    await act(async () => button("Cancel").click());
    await settle();
    server.invalidate.mockImplementationOnce(async () => {
      root.render(tableOf(USERS.filter((u) => u.id !== "u3")));
    });
    await pick("alan@example.com", "Delete user");
    await confirm("alan@example.com", "Delete user");
    expect(document.activeElement).toBe(button("Add user"));
  });

  it("waits for the list without the deleted user when it comes after the dialog closed", async () => {
    act(() => root.render(tableOf(USERS)));
    await pick("alan@example.com", "Delete user");
    await confirm("alan@example.com", "Delete user");
    act(() => root.render(tableOf(USERS.filter((u) => u.id !== "u3"))));
    await settle();
    expect(document.activeElement).toBe(button("Add user"));
  });

  it("moves to Add user when a transfer leaves the new owner's row without a menu", async () => {
    act(() => root.render(tableOf(USERS)));
    const after = USERS.map((u) => ({ ...u, isOwner: u.id === "u2" }));
    server.invalidate.mockImplementationOnce(async () => {
      root.render(tableOf(after));
    });
    await pick("grace@example.com", "Transfer ownership");
    await confirm("grace@example.com", "Transfer ownership");
    expect(document.querySelector('[aria-label="Actions for grace@example.com"]')).toBeNull();
    expect(document.activeElement).toBe(button("Add user"));
  });
});
