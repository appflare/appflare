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

export const userIdInput = z.object({ userId: z.string().min(1).max(255) });
export type UserIdInput = z.infer<typeof userIdInput>;

export const changeUserRoleInput = z.object({
  userId: z.string().min(1).max(255),
  role: z.enum(ROLES),
});
export type ChangeUserRoleInput = z.infer<typeof changeUserRoleInput>;

/**
 * A pasted Cloudflare API token. Only shape is checked here; Cloudflare decides
 * validity. The value is never echoed back.
 */
export const cfTokenInput = z.object({
  token: z
    .string()
    .trim()
    .min(1, "Paste the API token.")
    .max(512, "That is too long to be a Cloudflare API token.")
    .regex(/^[\x21-\x7e]+$/, "The token contains spaces or unexpected characters."),
});
export type CfTokenInput = z.infer<typeof cfTokenInput>;

/** The label a user gives a passkey so they can tell several apart later. */
export const passkeyNameInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the passkey a name.")
    .max(100, "Use at most 100 characters."),
});
export type PasskeyNameInput = z.infer<typeof passkeyNameInput>;

export const removePasskeyInput = z.object({ id: z.string().min(1).max(255) });
export type RemovePasskeyInput = z.infer<typeof removePasskeyInput>;
