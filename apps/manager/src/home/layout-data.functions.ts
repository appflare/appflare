import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "../server/auth.server";
import type { LayoutData } from "./layout-data";
import { readLayoutData } from "./layout-data.server";

/** Any signed-in user: what every signed-in page shows around itself (see `readLayoutData`). */
export const getLayoutData = createServerFn({ method: "GET" }).handler(
  async (): Promise<LayoutData> => readLayoutData(await requireSession()),
);
