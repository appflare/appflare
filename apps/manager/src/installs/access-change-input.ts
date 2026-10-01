import { z } from "zod";

/** Client-safe input of the server function that turns an app's Cloudflare Access protection on or off. */
export const startAccessChangeInput = z.object({
  installId: z.string().min(1).max(64),
  access: z.enum(["on", "off"]),
});
export type StartAccessChangeInput = z.infer<typeof startAccessChangeInput>;
