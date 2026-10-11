import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import { DefaultNotFound } from "@fumadocs/base-ui/layouts/home/not-found";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { appsSearchPath, missingAppWords, suggestAppUrl } from "../catalog/urls.ts";
import { baseOptions } from "../lib/layout.shared.tsx";

/**
 * The page for an address the site does not have. One page (`404.html`)
 * answers every such address, so what it says about the address is worked
 * out once it runs in the browser: for a missing app's page, it offers to
 * search the catalog for the app and to ask for it.
 */
export function NotFound() {
  const { pathname } = useLocation();
  const [running, setRunning] = useState(false);
  useEffect(() => setRunning(true), []);
  const words = running ? missingAppWords(pathname) : null;
  return (
    <HomeLayout {...baseOptions()}>
      {words === null ? <DefaultNotFound /> : <MissingApp words={words} />}
    </HomeLayout>
  );
}

/** For `/apps/<slug>/` with no such app: search for its words, or ask for it. */
export function MissingApp({ words }: { words: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="font-bold text-6xl text-fd-muted-foreground">404</h1>
      <h2 className="font-semibold text-2xl">No app has this address</h2>
      <p className="max-w-md text-fd-muted-foreground">
        The app may be in the catalog under another name, or not be in it yet.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <a
          href={appsSearchPath(words)}
          className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
        >
          <MagnifyingGlassIcon aria-hidden="true" className="size-4" />
          Search apps for “{words}”
        </a>
        <a href={suggestAppUrl(words)} className={buttonVariants({ variant: "secondary" })}>
          Suggest an app
        </a>
      </div>
    </div>
  );
}
