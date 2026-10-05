import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
import type { TakenWorkerNames } from "./worker-name-check";
import { takenWorkerNames } from "./worker-names.server";

/**
 * Admin only: the Worker names an install cannot take, for the install
 * form's live check of its Worker name. One list of the account's Workers;
 * the form asks once and checks every name it is given against the answer.
 */
export const listTakenWorkerNames = createServerFn({ method: "GET" })
  // "Install again": the failed install whose names its removal frees.
  .validator(z.object({ replaces: z.string().min(1).max(64).optional() }).optional())
  .handler(async ({ data }): Promise<TakenWorkerNames> => {
    await requireRole("admin");
    return takenWorkerNames(
      {
        db: env.DB,
        listAccountWorkers: async () =>
          (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id),
      },
      data?.replaces,
    );
  });
