import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { readAddressStatus } from "./address-status.server";
import type { AddressStatus } from "./address-watch";

/**
 * For a page open at workers.dev while Appflare waits to move to its
 * domain: whether it moved yet (address-watch.ts). Unauthenticated, like the
 * sign-in page that may be the one open; one settings read.
 */
export const getAddressStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<AddressStatus> => readAddressStatus(env.DB),
);
