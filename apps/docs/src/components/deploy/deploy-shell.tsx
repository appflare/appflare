import { CLOUD_ORANGE, CLOUD_PATH, INK_PATHS, VIEW_BOX } from "@appflare/brand/logo-paths";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Link } from "@cloudflare/kumo/components/link";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Text } from "@cloudflare/kumo/components/text";
import type { ReactNode } from "react";
import { repositoryUrl, siteName } from "../../lib/shared.ts";
import { Appearance } from "./appearance.tsx";

/**
 * The frame of the deploy page and its callback, drawn like the screens
 * Appflare itself shows before sign-in: the logo, one card with the step
 * meter, a title and one line under it, then (on the deploy page) what the
 * installer receives and the other ways to install, both folded away, and a
 * footer. Kumo throughout; the colours follow the site's light or dark
 * choice, which the footer can change.
 */

/** Black on light surfaces, white on dark ones; the cloud stays orange. */
const INK = "light-dark(#000, #fff)";

/** The full Appflare logo, leading to the site's front page. */
function LogoLink() {
  const height = 28;
  const width = Math.round((height * VIEW_BOX.width * 100) / VIEW_BOX.height) / 100;
  return (
    <a
      href="/"
      className="inline-flex min-h-11 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-kumo-focus focus-visible:outline-offset-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`${siteName} home`}
      >
        <g style={{ fill: INK }}>
          {INK_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path fill={CLOUD_ORANGE} d={CLOUD_PATH} />
      </svg>
    </a>
  );
}

export function DeployLayout({
  children,
  aside = true,
}: {
  children: ReactNode;
  /** The installer's terms and the other ways to install (not on the callback). */
  aside?: boolean;
}) {
  return (
    <main className="isolate flex min-h-dvh flex-col bg-kumo-canvas text-kumo-default [padding-inline:max(1rem,env(safe-area-inset-left))]">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center gap-6 pt-6 pb-10 sm:pt-12">
        <LogoLink />
        {children}
        {aside && (
          <div className="grid w-full gap-1 px-1">
            <InstallerTerms />
            <OtherWays />
          </div>
        )}
      </div>
      <footer className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-x-4 gap-y-2 border-kumo-hairline border-t px-1 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center gap-x-4">
          <FooterLink href="/start/browser-install/">Help</FooterLink>
          <FooterLink href="/privacy/">Privacy</FooterLink>
          <FooterLink href={`${repositoryUrl}/tree/main/apps/installer`}>Source</FooterLink>
        </div>
        <Appearance />
      </footer>
    </main>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Text variant="secondary" as="span">
      <Link
        href={href}
        variant="plain"
        className="inline-flex min-h-11 items-center text-kumo-subtle"
      >
        {children}
      </Link>
    </Text>
  );
}

/** The id of the step's title, which takes the focus when the step changes. */
export const STEP_TITLE_ID = "deploy-step-title";

/**
 * The card of one step: the meter (where the step is in the journey), the
 * title, one line under it, then the step's content. The card is never
 * marked busy as a whole: that would silence the live regions in it, which
 * announce the progress.
 */
export function DeployCard({
  meter,
  title,
  description,
  children,
}: {
  meter: { step: number; count: number } | null;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <LayerCard className="grid w-full gap-6 rounded-xl px-5 py-5 sm:px-8 sm:py-7">
      <div className="grid gap-5">
        {meter !== null && (
          <Meter
            label="Install Appflare"
            customValue={`Step ${meter.step} of ${meter.count}`}
            value={meter.step}
            max={meter.count}
            getAriaValueText={() => `Step ${meter.step} of ${meter.count}`}
            trackClassName="h-1"
          />
        )}
        <div className="grid gap-1.5">
          <Text variant="heading" size="lg" as="h1">
            <span id={STEP_TITLE_ID} tabIndex={-1} className="outline-none [text-wrap:balance]">
              {title}
            </span>
          </Text>
          {description !== undefined && <Text variant="secondary">{description}</Text>}
        </div>
      </div>
      {children}
    </LayerCard>
  );
}

/**
 * Detail on demand: folded away until asked for, in Kumo's disclosure. The
 * trigger is at least 44 px tall on touch screens.
 */
export function More({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <Collapsible.Root>
      <Collapsible.DefaultTrigger className="min-h-11 text-kumo-subtle sm:min-h-8">
        {summary}
      </Collapsible.DefaultTrigger>
      {/* Kept in the page while folded, so find-in-page and the prerendered HTML have it. */}
      <Collapsible.DefaultPanel keepMounted>
        <div className="grid gap-2 text-kumo-subtle">{children}</div>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

/** What Appflare's hosted installer receives and keeps, folded away. */
export function InstallerTerms() {
  return (
    <More summary="What Appflare's installer receives and keeps">
      <Text variant="secondary">
        A web page cannot create Workers on its own, so a small open-source service behind this
        page, Appflare's installer, does the deploying.
      </Text>
      <Text variant="secondary">
        With each request it gets a short-lived Cloudflare access token. That token allows
        everything you allow Appflare, so you are trusting the installer to run{" "}
        <Link href={`${repositoryUrl}/tree/main/apps/installer`}>its published code</Link>. It does
        not store the token, which stays valid until it expires.
      </Text>
      <Text variant="secondary">
        It never gets the refresh token that keeps Appflare connected. Your browser gives that to
        your new Appflare directly.
      </Text>
      <Text variant="secondary">
        Until your owner account exists, it keeps a record so you can continue or remove the
        installation: the account id, name, address, release and what it created. No token or
        password. The record goes once the owner account is created or the installation is removed.
      </Text>
      <Text variant="secondary">
        This page runs no analytics. <Link href="/privacy/">Privacy</Link>
      </Text>
    </More>
  );
}

/** The ways to install without the hosted installer, folded away. */
export function OtherWays() {
  return (
    <More summary="Other ways to install">
      <Text variant="secondary">
        Both install the same signed Appflare without Appflare's installer: the{" "}
        <Link href="/start/deploy-button/">Deploy to Cloudflare button</Link>, through a copy in
        your GitHub or GitLab account, or{" "}
        <code className="font-mono text-[0.9em]">npx create-appflare</code>{" "}
        <Link href="/start/install/">in a terminal</Link>.
      </Text>
    </More>
  );
}
