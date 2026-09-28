import { createContext, type ReactNode, useContext } from "react";
import { AppflareLoader } from "./appflare-loader";

/**
 * What shows while a page loads (the router's pending component). Inside the
 * signed-in shell only the page's place shows the loader, so the sidebar and
 * header stay put; before the shell exists (the first load, the sign-in and
 * setup pages, the SPA shell itself) the loader fills the window.
 */

const InShell = createContext(false);

/** Marks what it wraps as inside the signed-in shell. */
export function ShellContent({ children }: { children: ReactNode }) {
  return <InShell.Provider value={true}>{children}</InShell.Provider>;
}

/** Whether this is rendered inside the signed-in shell. */
export function useInShell(): boolean {
  return useContext(InShell);
}

export function PagePending() {
  return useInShell() ? (
    <div className="flex min-h-64 items-center justify-center py-16">
      <AppflareLoader />
    </div>
  ) : (
    <div className="flex min-h-dvh items-center justify-center">
      <AppflareLoader />
    </div>
  );
}
