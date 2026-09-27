import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireRole } from "../server/auth.server";
import { dismissDeployCopyCleanup } from "./deploy-copy.server";

/**
 * "Done" on Home's "Clean up the deploy copy" row: hides it for every admin
 * of this manager. The row itself comes with the signed-in layout's data
 * (`getLayoutData`).
 */
export const dismissDeployCopy = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    await requireRole("admin");
    await dismissDeployCopyCleanup(env);
  },
);
