import { signingKeys } from "@appflare/schema";
import { handleRequest } from "./api";

/**
 * The hosted installer Worker. The docs Worker forwards `/api/install/*` to
 * this default entrypoint through a service binding, request unchanged.
 */
export default {
  fetch(request, env) {
    return handleRequest(request, env, {
      fetch: (input, init) => fetch(input, init),
      keys: signingKeys,
    });
  },
} satisfies ExportedHandler<Env>;
