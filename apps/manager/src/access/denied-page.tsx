import { Banner, LinkButton, Text } from "@cloudflare/kumo";
import { LockKeyIcon } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthLayout, FULL_WIDTH_ACTION } from "../components/auth-layout";
import { COLOR_MODE_SCRIPT } from "../components/color-mode";
import { FAVICON_LINKS, FAVICON_META } from "../components/favicons";
import appCss from "../styles.css?url";
import { ACCESS_RECOVERY_COMMAND } from "./recovery";

export interface AccessDeniedPageProps {
  title: string;
  detail: string;
  /** The manager's own address, when Access protection knows it. */
  address: string | null;
  /** The two recovery steps, from `accessRecoverySteps`. */
  steps: readonly [string, string];
  /** The running Appflare version, for the footer. */
  version: string | null;
}

/**
 * The page a browser gets when the Access check refuses a request: the same
 * layout as the sign-in screens, rendered once on the server with the app's
 * own stylesheet (static assets are served before the Access check, so the
 * stylesheet loads where this page is shown). Without it the markup still
 * reads top to bottom.
 */
export function AccessDeniedPage({
  title,
  detail,
  address,
  steps,
  version,
}: AccessDeniedPageProps) {
  return (
    <AuthLayout width="wide" title={title} description={detail} version={version}>
      {address !== null && (
        <LinkButton href={address} variant="primary" className={FULL_WIDTH_ACTION}>
          Open the manager
        </LinkButton>
      )}
      <Banner
        variant="secondary"
        icon={<LockKeyIcon weight="fill" />}
        title="Locked out?"
        description={
          <span className="grid gap-2">
            <span>
              An admin turns Access protection off in Settings. If Settings cannot be reached:
            </span>
            <span>1. {steps[0]}</span>
            <span>2. {steps[1]}</span>
            <Text variant="mono" as="span" DANGEROUS_className="[overflow-wrap:anywhere]">
              {ACCESS_RECOVERY_COMMAND}
            </Text>
          </span>
        }
      />
    </AuthLayout>
  );
}

/** The whole HTML document for `AccessDeniedPage`, light or dark like the app. */
export function renderAccessDeniedPage(props: AccessDeniedPageProps): string {
  const head = renderToStaticMarkup(
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{`${props.title} · Appflare`}</title>
      {FAVICON_META.map((meta) => (
        <meta key={meta.name} {...meta} />
      ))}
      <link rel="stylesheet" href={appCss} />
      {FAVICON_LINKS.map((link) => (
        <link key={link.href} {...link} />
      ))}
    </>,
  );
  const body = renderToStaticMarkup(
    <body className="bg-kumo-base text-kumo-default antialiased">
      <div className="isolate min-h-dvh">
        <AccessDeniedPage {...props} />
      </div>
    </body>,
  );
  return `<!doctype html><html lang="en"><head>${head}<script>${COLOR_MODE_SCRIPT}</script></head>${body}</html>`;
}
