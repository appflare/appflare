import { z } from "zod";
import { MAX_RETURN_PATH_LENGTH } from "../components/internal-path";

/**
 * Client-safe input of the server functions for Appflare's address. The
 * hostname is checked on the server against the zone (`checkHostnameInZone`),
 * as the dialog checks it while the admin types.
 */

/** The page to open at the new address once signed in there; checked again at sign-in. */
const returnTo = z.string().max(MAX_RETURN_PATH_LENGTH).optional();

export const moveAddressInput = z.object({
  zoneId: z.string().min(1).max(64),
  hostname: z.string().min(1).max(300),
  /** The admin ticked "replace the existing DNS records" after being warned. */
  overrideExistingDnsRecord: z.boolean().optional(),
  returnTo,
});
export type MoveAddressInput = z.infer<typeof moveAddressInput>;

export const revertAddressInput = z.object({ returnTo });
export type RevertAddressInput = z.infer<typeof revertAddressInput>;
