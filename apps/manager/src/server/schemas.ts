import { z } from "zod";
import { ROLES } from "../auth/roles";

/** Client-safe input schemas shared by forms and server functions. */

export const MIN_PASSWORD_LENGTH = 12;

export const setupTokenInput = z.object({ token: z.string().max(1024) });

export const firstAdminInput = z.object({
  token: z.string().max(1024),
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
});
export type FirstAdminInput = z.infer<typeof firstAdminInput>;

export const addUserInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
});
export type AddUserInput = z.infer<typeof addUserInput>;
