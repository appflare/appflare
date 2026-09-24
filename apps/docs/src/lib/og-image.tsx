import { generateOGImage } from "@fumadocs/base-ui/og/takumi";
import mark from "../../public/favicon.svg?raw";
import { siteName } from "./shared.ts";

/** The Appflare mark, drawn white for the dark card. */
const whiteMark = `data:image/svg+xml;base64,${Buffer.from(
  mark.replace("svg{fill:#000}", "svg{fill:#fff}"),
).toString("base64")}`;

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
    primaryColor: "rgba(246, 130, 31, 0.3)",
    primaryTextColor: "rgb(246, 130, 31)",
    format: "png",
  });
}
