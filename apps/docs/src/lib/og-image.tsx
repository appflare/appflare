import { generateOGImage } from "@fumadocs/base-ui/og/takumi";
import { ImageResponse } from "takumi-js/response";
import mark from "../../../../docs/assets/logo_square_white.svg?raw";
import { siteName } from "./shared.ts";

/** The square Appflare logo in its white variant, for the dark card. */
const whiteMark = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

/** The site's orange, as the cards draw it. */
const brand = "rgb(251, 107, 0)";
const brandTint = "rgba(251, 107, 0, 0.3)";

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
    primaryColor: brandTint,
    primaryTextColor: brand,
    format: "png",
  });
}

/**
 * An app's 1200x630 OpenGraph card, for an app without a cover: its icon (or
 * its first letter), its name and its tagline, with the Appflare mark below.
 * `icon` is a data URI; the card is drawn during the build, which fetches
 * nothing.
 */
export function renderAppOgImage({
  name,
  tagline,
  icon,
}: {
  name: string;
  tagline: string;
  icon: string | null;
}): Response {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "72px",
        color: "white",
        backgroundColor: "#0c0c0c",
        borderBottom: `18px solid ${brandTint}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "48px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "200px",
            height: "200px",
            flexShrink: 0,
            borderRadius: "40px",
            backgroundColor: "white",
            color: "#0c0c0c",
            fontSize: "110px",
            fontWeight: 800,
          }}
        >
          {icon === null ? letter : <img src={icon} width={160} height={160} alt="" />}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          <p style={{ fontSize: "84px", fontWeight: 800, margin: 0, lineHeight: 1.05 }}>{name}</p>
          <p
            style={{
              fontSize: "44px",
              margin: 0,
              color: "rgba(240,240,240,0.8)",
              lineHeight: 1.25,
            }}
          >
            {tagline}
          </p>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: "20px",
          marginTop: "auto",
          color: brand,
        }}
      >
        <img src={whiteMark} width={56} height={56} alt="" />
        <p style={{ fontSize: "48px", fontWeight: 600, margin: 0 }}>{siteName}</p>
      </div>
    </div>,
    { width: 1200, height: 630, format: "png" },
  );
}
