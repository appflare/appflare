import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../server/users.functions";

/** The users settings' Users table, with the server calls standing in. */
vi.mock("../server/users.functions", () => ({
  addUser: vi.fn(),
  changeUserRole: vi.fn(),
  deleteUser: vi.fn(),
  transferOwnership: vi.fn(),
}));
vi.mock("../server/recovery.functions", () => ({
  issuePasswordRecoveryCode: vi.fn(),
  sendPasswordResetLink: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: async () => {} }) }));

const { UsersSection } = await import("./users-section");

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
