import { RouterProvider } from "@tanstack/react-router";
import { hydrateStart } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { settled } from "./lib/hydration.ts";

// The browser's entry: TanStack Start's own, except that the router finishes
// loading what it shows before React hydrates the page (see `settled`).
hydrateStart()
  .then(settled)
  .then((router) =>
    startTransition(() => {
      hydrateRoot(
        document,
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>,
      );
    }),
  );
