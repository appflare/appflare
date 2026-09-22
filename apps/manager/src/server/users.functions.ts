import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { hasRole, type Role } from "../auth/roles";
import { generateTemporaryPassword } from "../auth/temporary-password";
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
    await requireRole("admin");
    const temporaryPassword = generateTemporaryPassword();
    try {
      const { user } = await currentAuth().api.createUser({
        body: { email: data.email, name: data.name, role: data.role, password: temporaryPassword },
        headers: getRequest().headers,
      });
      return { user: toRow(user), temporaryPassword };
    } catch (error) {
      throw new Error(authErrorMessage(error, "Could not create the user."));
    }
  });
