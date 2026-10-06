import type { ReactNode } from "react";
import { repositoryUrl } from "../../lib/shared.ts";
import { CatalogLayout } from "../catalog/catalog-layout.tsx";

/**
 * The frame of the deploy page and its callback: what the page is, the
 * current step in one card, then what the hosted installer receives and
 * keeps, and the other ways to install. The frame is prerendered; the step
 * arrives once the page runs.
 */
export function DeployShell({
  rail,
  children,
  aside = true,
}: {
  rail?: ReactNode;
  children: ReactNode;
  /** The installer's terms and the other ways to install (not on the callback). */
  aside?: boolean;
}) {
  return (
    <CatalogLayout>
      <div className="mx-auto grid w-full max-w-2xl gap-6">
        <header className="grid gap-2">
          <h1 className="font-bold text-3xl tracking-tight">Install Appflare</h1>
          <p className="text-fd-muted-foreground text-lg">
            Into your own Cloudflare account, from this page. It takes a few minutes and nothing to
            install on your computer.
          </p>
        </header>
        {rail}
        <section
          aria-live="polite"
          className="grid min-h-40 content-start gap-4 rounded-2xl border border-fd-border bg-fd-card p-5 shadow-sm sm:p-6"
        >
          {children}
        </section>
        {aside && (
          <>
            <InstallerTerms />
            <OtherWays />
          </>
        )}
      </div>
    </CatalogLayout>
  );
}

const link = "font-medium text-fd-primary underline underline-offset-2";

/** What Appflare's hosted installer receives and keeps, in plain words. */
export function InstallerTerms() {
  return (
    <section aria-labelledby="installer-terms" className="grid gap-3 text-sm leading-relaxed">
      <h2 id="installer-terms" className="font-semibold text-base">
        What Appflare's installer receives and keeps
      </h2>
      <p>
        Cloudflare does not let a web page create Workers by itself, so the deploying is done by
        Appflare's installer, a small open-source service behind this page.
      </p>
      <p>
        With each request it receives a short-lived Cloudflare access token. While that token is
        valid it allows everything you allowed Appflare, more than deploying needs, so you are
        trusting the installer to run{" "}
        <a href={`${repositoryUrl}/tree/main/apps/installer`} className={link}>
          its published code
        </a>
        . It uses the token only to set up Appflare and does not store it. That does not cancel the
        token at Cloudflare, though. It stays valid until it expires on its own.
      </p>
      <p>
        It never receives the refresh token, which is what keeps Appflare connected afterwards. Your
        browser gives that to your new Appflare directly, and this page forgets it.
      </p>
      <p>
        Until Appflare's owner account exists, the installer keeps a record of the installation so
        you can continue or remove it: your Cloudflare account id, the name, the address, the
        Appflare release and what it created. No token, no password, nothing about your apps. The
        record is deleted when the owner account is created or when you remove the installation.
      </p>
      <p>
        This page runs no analytics and measures nothing.{" "}
        <a href="/privacy/" className={link}>
          Privacy
        </a>
      </p>
    </section>
  );
}

/** The ways to install without the hosted installer. */
export function OtherWays() {
  return (
    <section aria-labelledby="other-ways" className="grid gap-2 text-sm leading-relaxed">
      <h2 id="other-ways" className="font-semibold text-base">
        Other ways to install
      </h2>
      <p>
        Both install the same signed Appflare without Appflare's installer.{" "}
        <a href="/start/deploy-button/" className={link}>
          The Deploy to Cloudflare button
        </a>{" "}
        works from your browser through a copy in your GitHub or GitLab account.{" "}
        <a href="/start/install/" className={link}>
          From a terminal
        </a>
        , run <code className="rounded bg-fd-secondary px-1 py-0.5">npx create-appflare</code>.
      </p>
    </section>
  );
}
