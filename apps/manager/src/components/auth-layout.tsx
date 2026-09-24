import { Banner, cn, LayerCard, Link, Meter, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Logo } from "./logo";

/** Where the footer's version line leads. */
export const DOCS_URL = "https://appflare-docs.appflare-dev.workers.dev/";

/**
 * Setup runs in three screens: create the admin account (`/setup`), sign in
 * with it (`/login?created=true`), connect Cloudflare (`/setup` again).
 */
export const SETUP_STEP_COUNT = 3;
export type SetupStep = 1 | 2 | 3;

export function setupStepLabel(step: SetupStep): string {
  return `Step ${step} of ${SETUP_STEP_COUNT}`;
}

/** Makes a Kumo Button span the card, its content centred. */
export const FULL_WIDTH_ACTION = "w-full justify-center";

/**
 * The one layout of every screen shown before the app itself: sign-in, each
 * setup step, the setup notices and the Cloudflare Access refusal page. The
 * full logo, then one card vertically centred on the page (title, one-line
 * subtitle, the screen's content), then a footer line with the version.
 *
 * Light, or dark when chosen in the account menu's Appearance, like the rest
 * of the manager (see `color-mode.ts`); the logo turns white in dark mode. `wide` fits the
 * Cloudflare token step's longer copy and two-button rows.
 */
export function AuthLayout({
  title,
  description,
  step,
  width = "narrow",
  version,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** The setup step this screen is, shown above the title. */
  step?: SetupStep;
  width?: "narrow" | "wide";
  /** The running Appflare version; null when it could not be read. */
  version: string | null;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col bg-kumo-canvas text-kumo-default">
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
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
                customValue={setupStepLabel(step)}
                value={step}
                max={SETUP_STEP_COUNT}
                getAriaValueText={() => setupStepLabel(step)}
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
            href={DOCS_URL}
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

/** An error on an auth screen: a plain sentence, announced when it appears. */
export function AuthError({ message }: { message: string }) {
  return (
    <div role="alert">
      <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} description={message} />
    </div>
  );
}

/** A confirmation on an auth screen, such as "Admin account created". */
export function AuthSuccess({ title, description }: { title: string; description: string }) {
  return (
    <Banner icon={<CheckCircleIcon weight="fill" />} title={title} description={description} />
  );
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
