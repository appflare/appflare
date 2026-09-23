import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { hasRole, type Role } from "../auth/roles";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { syncAccessAfterAdminChange } from "./access.server";
import { currentAuth, requireRole } from "./auth.server";
import { addUserInput } from "./schemas";
import { authErrorMessage } from "./users.server";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** ISO 8601 */
  createdAt: string;
}

function toRow(u: {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  createdAt: Date;
}): UserRow {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: hasRole(u.role, "admin") ? "admin" : "member",
    createdAt: new Date(u.createdAt).toISOString(),
  };
}

/** Admin only: every manager user (settings, "Users"). */
export const listUsers = createServerFn({ method: "GET" }).handler(async (): Promise<UserRow[]> => {
  await requireRole("admin");
  const result = await currentAuth().api.listUsers({
    query: { limit: 500, sortBy: "createdAt", sortDirection: "asc" },
    headers: getRequest().headers,
  });
  return result.users.map(toRow);
});

/**
 * Admin only: creates a user with a random temporary password, returned once so
 * the dialog can show it. The password is never stored in plain
 * text or logged.
 */
export const addUser = createServerFn({ method: "POST" })
  .validator(addUserInput)
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    const temporaryPassword = generateTemporaryPassword();
    let created: UserRow;
    try {
      const { user } = await currentAuth().api.createUser({
        body: { email: data.email, name: data.name, role: data.role, password: temporaryPassword },
        headers: getRequest().headers,
      });
      created = toRow(user);
    } catch (error) {
      throw new Error(authErrorMessage(error, "Could not create the user."));
    }
    // With Cloudflare Access protection on, a new admin must also be in its
    // allow policy, or Access keeps them out before they reach the sign-in page.
    const accessPolicy =
      created.role === "admin" ? await syncAccessAfterAdminChange(session.user.email) : "off";
    return { user: created, temporaryPassword, accessPolicy };
  });
