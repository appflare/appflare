import type { Role } from "../auth/roles";

/**
 * The signed-in user as the UI sees it. Produced by `enterApp` (gate.functions.ts),
 * which also redirects to `/login` when there is no session.
 */
export interface Viewer {
  id: string;
  email: string;
  name: string;
  role: Role;
}
