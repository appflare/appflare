import logo from "../../../../docs/assets/logo_square.svg?url";
import { installLink } from "../lib/install-links.ts";

/** Appflare's hosted installer. The shortener counts the link; the deploy page stays untracked. */
export function InstallButton({
  placement,
  size = "md",
  className = "",
}: {
  placement: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const sizing = size === "lg" ? "h-12 px-5 text-base" : "h-11 px-4 text-sm";
  return (
    <a
      href={installLink(placement)}
      data-link-id={placement}
      className={`not-prose inline-flex shrink-0 items-center justify-center gap-2.5 rounded-lg bg-[#fb6b00] font-semibold text-black shadow-sm transition-colors hover:bg-[#ff7d1a] focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2 ${sizing} ${className}`}
    >
      <img src={logo} alt="" width={24} height={24} className="size-6 rounded bg-white p-0.5" />
      Install Appflare
    </a>
  );
}
