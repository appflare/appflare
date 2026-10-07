import { SITE_URL } from "@appflare/schema/links";
import { cn, LayerCard, Link, Meter, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { managerSiteLink } from "../site-links";
import { Logo } from "./logo";
import { ErrorMessageBanner } from "./message-text";

/**
 * Where the documentation starts, which the footer's version line and the
 * account menu's Documentation link lead to. The site's own `/` is its front
 * page.
 */
export const DOCS_URL = `${SITE_URL}/start/overview/`;

/**
 * Setup runs in three steps on one page, `/setup`: connect Cloudflare (paste
 * an API token for this account), create the owner account, then check
 * what the account can run. A fourth, where Appflare should live, comes
 * before the last when the account has a domain.
 */
export const SETUP_STEP_COUNT = 3;
export type SetupStep = 1 | 2 | 3 | 4;

export function setupStepLabel(step: SetupStep, count: number = SETUP_STEP_COUNT): string {
  return `Step ${step} of ${count}`;
}

/** Makes a Kumo Button span the card, its content centred; 44 px tall on a phone. */
export const FULL_WIDTH_ACTION = "w-full justify-center max-sm:min-h-11";

/**
 * The one layout of every screen shown before the app itself: sign-in, each
 * setup step, the setup notices and the Cloudflare Access refusal page. The
 * full logo, then one card vertically centred on the page (title, one-line
 * subtitle, the screen's content), then a footer line with the version.
 *
 * Light, or dark when chosen in the account menu's Appearance, like the rest
 * of the manager (see `color-mode.ts`); the logo turns white in dark mode.
 * `wide` fits the setup wizard and longer notices. `placement="top"` pins the
 * card near the top instead of centring it, so a frame whose content changes
 * height (the setup wizard's steps) keeps its logo and step indicator still.
 */
export function AuthLayout({
  title,
  description,
  step,
  stepCount = SETUP_STEP_COUNT,
  width = "narrow",
  placement = "center",
  version,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** The setup step this screen is, shown above the title. */
  step?: SetupStep;
  /** How many steps setup has on this run. */
  stepCount?: number;
  width?: "narrow" | "wide";
  placement?: "center" | "top";
  /** The running Appflare version; null when it could not be read. */
  version: string | null;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col bg-kumo-canvas text-kumo-default">
      <div
        className={cn(
          "flex flex-1 flex-col items-center px-4",
          placement === "top" ? "justify-start gap-6 py-6" : "justify-center gap-8 py-12",
        )}
      >
        <Logo height={32} />
        <LayerCard
          className={cn(
            "grid w-full gap-6 rounded-xl px-6 py-5 sm:px-8 sm:py-7",
            width === "wide" ? "max-w-xl" : "max-w-100",
          )}
        >
          <div className="grid gap-5">
            {step !== undefined && (
              <Meter
                label="Set up Appflare"
                customValue={setupStepLabel(step, stepCount)}
                value={step}
                max={stepCount}
                getAriaValueText={() => setupStepLabel(step, stepCount)}
                trackClassName="h-1"
              />
            )}
            <div className="grid gap-1.5">
              <Text variant="heading" size="lg" as="h1">
                {title}
              </Text>
              {description !== undefined && <Text variant="secondary">{description}</Text>}
            </div>
          </div>
          {children}
        </LayerCard>
      </div>
      <footer className="flex justify-center px-4 pb-6">
        <Text variant="secondary" size="sm">
          {/* `text-kumo-subtle` wins over the plain variant's colour at rest; its hover colour stays. */}
          <Link
            href={managerSiteLink(DOCS_URL, "footer")}
            target="_blank"
            rel="noopener noreferrer"
            variant="plain"
            className="text-kumo-subtle"
          >
            {version === null ? "Appflare documentation" : `Appflare ${version}`}
          </Link>
        </Text>
      </footer>
    </main>
  );
}

/**
 * An error on an auth screen, like any other error banner and announced
 * when it appears. A link in it (to a settings page) opens in a new tab,
 * keeping the screen.
 */
export function AuthError({ message }: { message: string }) {
  return <ErrorMessageBanner message={message} newTab />;
}

/** "or" between two ways of doing the same thing, with a hairline on each side. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="h-px flex-1 bg-kumo-hairline" />
      <Text variant="secondary" size="sm" as="span">
        or
      </Text>
      <span aria-hidden="true" className="h-px flex-1 bg-kumo-hairline" />
    </div>
  );
}
