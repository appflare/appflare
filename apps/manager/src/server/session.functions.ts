import { createServerFn } from "@tanstack/react-start";
import { hasRole, type Role } from "../auth/roles";
import { requireSession } from "./auth.server";

export interface Viewer {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** The signed-in user. Redirects to `/login` when there is no session. */
export const getViewer = createServerFn({ method: "GET" }).handler(async (): Promise<Viewer> => {
  const { user } = await requireSession();
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: hasRole(user.role, "admin") ? "admin" : "member",
  };
});
