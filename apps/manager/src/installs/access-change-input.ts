import { z } from "zod";

/** Client-safe input of the server function that turns an app's Cloudflare Access protection on or off. */
export const startAccessChangeInput = z.object({
  installId: z.string().min(1).max(64),
  access: z.enum(["on", "off"]),
});
export type StartAccessChangeInput = z.infer<typeof startAccessChangeInput>;

/** Client-safe input of the server function that makes a protected app's newly listed public paths public. */
export const makePublicPathsInput = z.object({
  installId: z.string().min(1).max(64),
  /** The paths the card showed as waiting: only these are accepted. */
  paths: z.array(z.string().min(1).max(200)).min(1).max(20),
});
export type MakePublicPathsInput = z.infer<typeof makePublicPathsInput>;
