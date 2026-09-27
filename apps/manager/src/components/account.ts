import type { Viewer } from "../server/session.functions";
import { settingsLink } from "./settings-links";

/** The signed-in user as the sidebar's account menu shows them. Client-safe. */
export type AccountViewer = Pick<Viewer, "name" | "email" | "role" | "isOwner">;

/** The name to show: the user's name, or their email when the name is empty. */
export function accountName(viewer: AccountViewer): string {
  const name = viewer.name.trim();
  return name.length > 0 ? name : viewer.email;
}

/** The letter on the menu's trigger: the first letter of the shown name, upper case. */
export function accountInitial(viewer: AccountViewer): string {
  const first = Array.from(accountName(viewer).trim())[0] ?? "?";
  return first.toLocaleUpperCase();
}

/** "Owner" for the manager's owner (always an admin), else "Admin" or "Member". */
export function accountRoleLabel(viewer: AccountViewer): string {
  if (viewer.isOwner) return "Owner";
  return viewer.role === "admin" ? "Admin" : "Member";
}

/** Where the menu's links go: the Users and sign-in page, and its passkeys section. */
export const ACCOUNT_LINKS = {
  users: settingsLink("users"),
  passkeys: settingsLink("users", "passkeys"),
} as const;
