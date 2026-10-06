import { signingKeys } from "@appflare/schema";
import { handleRequest } from "./api";
import { ReleaseCache } from "./release/cache";

/** One per isolate: `POST release` answers from it for a few minutes. */
const releaseCache = new ReleaseCache();

/**
 * The hosted installer Worker. The docs Worker forwards `/api/install/*` to
 * this default entrypoint through a service binding, request unchanged.
 */
export default {
  fetch(request, env) {
    return handleRequest(request, env, {
      fetch: (input, init) => fetch(input, init),
      keys: signingKeys,
      releaseCache,
    });
  },
} satisfies ExportedHandler<Env>;
