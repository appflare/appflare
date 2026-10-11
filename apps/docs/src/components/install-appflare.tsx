import logo from "../../../../docs/assets/logo_square.svg?url";
import { DEPLOY_PATH } from "../deploy/paths.ts";
import { installLink } from "../lib/install-links.ts";
import { InstallLink } from "./in-app/open-in-browser.tsx";
import { ShareLinkLine } from "./in-app/share-link.tsx";

/** What the share sheet calls a link to install Appflare. */
const SHARE_TITLE = "Install Appflare";

/**
 * Appflare's hosted installer. The shortener counts the link; the deploy page
 * itself counts only how far installs get.
 * `href` replaces the short link with a deploy page address on this site
 * (`/deploy/?app=<slug>`), whose click the site's analytics count instead.
 * In an app's own browser, which often cannot finish the Cloudflare sign-in,
 * a tap asks the visitor to open `handoffPath` (the deploy page unless given)
 * in their browser instead.
 */
export function InstallButton({
  placement,
  size = "md",
  className = "",
  href,
  handoffPath = DEPLOY_PATH,
}: {
  placement: string;
  size?: "md" | "lg";
  className?: string;
  href?: string;
  handoffPath?: string;
}) {
  const sizing = size === "lg" ? "h-12 px-5 text-base" : "h-11 px-4 text-sm";
  return (
    <InstallLink
      href={href ?? installLink(placement)}
      handoffPath={handoffPath}
      shareTitle={SHARE_TITLE}
      data-link-id={placement}
      className={`not-prose inline-flex shrink-0 items-center justify-center gap-2.5 rounded-lg bg-[#fb6b00] font-semibold text-black shadow-sm transition-colors hover:bg-[#ff7d1a] focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2 ${sizing} ${className}`}
    >
      <img src={logo} alt="" width={24} height={24} className="size-6 rounded bg-white p-0.5" />
      Install Appflare
    </InstallLink>
  );
}

/**
 * Under Install Appflare on a phone: a line to send the page to a computer
 * (see {@link ShareLinkLine}). It sends the deploy page unless given another.
 */
export function InstallShareLine({
  handoffPath = DEPLOY_PATH,
  reserve = true,
  className,
}: {
  handoffPath?: string;
  /** See {@link ShareLinkLine}. */
  reserve?: boolean;
  className?: string;
}) {
  return (
    <ShareLinkLine
      path={handoffPath}
      title={SHARE_TITLE}
      reserve={reserve}
      {...(className === undefined ? {} : { className })}
    />
  );
}

/** Install Appflare in a docs page: the button, and the line to share it on a phone. */
export function DocsInstallButton({ placement }: { placement: string }) {
  return (
    <div className="not-prose grid justify-items-start gap-1">
      <InstallButton placement={placement} />
      <InstallShareLine />
    </div>
  );
}
