import { generateOGImage } from "@fumadocs/base-ui/og/takumi";
import mark from "../../../../docs/assets/logo_square_white.svg?raw";
import { siteName } from "./shared.ts";

/** The square Appflare logo in its white variant, for the dark card. */
const whiteMark = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

/** A page's 1200x630 OpenGraph card: the page title and summary on Fumadocs' layout. */
export function renderOgImage({
  title,
  description,
}: {
  title: string;
  description?: string | undefined;
}): Response {
  return generateOGImage({
    title,
    description,
    site: siteName,
    icon: <img src={whiteMark} width={56} height={56} alt="" />,
    primaryColor: "rgba(251, 107, 0, 0.3)",
    primaryTextColor: "rgb(251, 107, 0)",
    format: "png",
  });
}
