import type { CSSProperties, ReactNode } from "react";
import { ImageResponse } from "takumi-js/response";
import fullLogo from "../../../../docs/assets/logo_full.svg?raw";
import squareLogo from "../../../../docs/assets/logo_square.svg?raw";
import squareLogoWhite from "../../../../docs/assets/logo_square_white.svg?raw";
import { categoryIconUri } from "./category-icons.tsx";
import { fitText } from "./fit.ts";

/**
 * The site's OpenGraph cards, one family in the site's own look: a light
 * neutral canvas, the Appflare logo, the orange of the cloud in the mark as
 * the one accent, a large title, and a quiet footer with the page's address.
 *
 * Each card is 1200x630 and centred on one column, as the front page's hero
 * is: the full card shows on X, Slack, LinkedIn and iMessage, and the square
 * thumbnails some apps cut from its middle still hold the icon and the title.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** The mark and wordmark, black with the orange cloud. */
export const LOGO = svgUri(fullLogo);
export const LOGO_RATIO = 69.89 / 14.96;
/** The square mark, black with the orange cloud. */
export const MARK = svgUri(squareLogo);
/** The square mark in white with the orange cloud, for a dark surface. */
export const MARK_WHITE = svgUri(squareLogoWhite);

export const colors = {
  ink: "#0a0a0a",
  muted: "#525252",
  soft: "#8a8a8a",
  line: "#e5e5e5",
  canvas: "#fafafa",
  tile: "#f4f4f4",
  flare: "#fb6b00",
} as const;

/**
 * The canvas: the soft orange light below the front page's hero, over a faint
 * dot grid that fades out behind the words.
 */
export const GLOW = [
  "radial-gradient(ellipse 62% 58% at 50% 112%, rgba(251,107,0,0.16), rgba(251,107,0,0) 100%)",
  "radial-gradient(ellipse 58% 62% at 50% 48%, #fafafa 40%, rgba(250,250,250,0) 100%)",
  "radial-gradient(circle, rgba(0,0,0,0.13) 1.5px, rgba(0,0,0,0) 2px)",
].join(", ");

/** The widest a line of text runs, leaving the sides clear. */
const COLUMN = 960;

/** An app as a card draws it. */
export interface CardApp {
  name: string;
  /** The one line under the name. */
  pitch: string;
  /** The icon as a data URI; null draws the name's first letter instead. */
  icon: string | null;
}

export type OgCard =
  | { kind: "site"; title: string; description: string }
  | {
      kind: "docs";
      /** The heading of the part of the docs the page is in, if any. */
      section: string | null;
      title: string;
      description?: string | undefined;
      /** The page's path, shown after `appflare.dev` in the footer. */
      path: string;
    }
  | { kind: "app"; app: CardApp; categories: string[]; path: string }
  | { kind: "install"; app: CardApp; path: string }
  | {
      kind: "category";
      id: string;
      title: string;
      description: string;
      apps: CardApp[];
      path: string;
    }
  | { kind: "apps"; title: string; description: string; apps: CardApp[]; path: string };

/** A card as a 1200x630 PNG response. */
export function renderOgCard(card: OgCard): Response {
  return new ImageResponse(ogCardElement(card), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    format: "png",
  });
}

export function ogCardElement(card: OgCard): ReactNode {
  switch (card.kind) {
    case "site":
      return <SiteCard title={card.title} description={card.description} />;
    case "docs":
      return <DocsCard {...card} />;
    case "app":
      return <AppCard app={card.app} categories={card.categories} path={card.path} />;
    case "install":
      return <InstallCard app={card.app} path={card.path} />;
    case "category":
      return (
        <ListCard
          badge={<img src={categoryIconUri(card.id, colors.ink)} width={60} height={60} alt="" />}
          title={card.title}
          description={card.description}
          apps={card.apps}
          path={card.path}
        />
      );
    case "apps":
      return (
        <ListCard
          badge={<img src={MARK} width={62} height={62} alt="" />}
          title={card.title}
          description={card.description}
          apps={card.apps}
          path={card.path}
        />
      );
  }
}

/* Pieces the cards share. */

export function Canvas({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "relative",
        width: "100%",
        height: "100%",
        backgroundColor: colors.canvas,
        backgroundImage: GLOW,
        backgroundSize: "100% 100%, 100% 100%, 28px 28px",
        backgroundPosition: "0 0, 0 0, 14px 14px",
        color: colors.ink,
        fontFamily: "Geist",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Logo({ height }: { height: number }) {
  return <img src={LOGO} width={Math.round(height * LOGO_RATIO)} height={height} alt="" />;
}

/**
 * A centred card: the logo at the top (unless the card draws the mark
 * itself), the content in the middle, and the page's address at the bottom.
 */
function Frame({
  path,
  logo = true,
  footer,
  children,
}: {
  path: string;
  logo?: boolean;
  /** What the bottom shows instead of the address. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Canvas style={{ alignItems: "center", padding: "52px 80px 48px" }}>
      <div style={{ display: "flex", height: 34 }}>{logo && <Logo height={34} />}</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flexGrow: 1,
          width: "100%",
        }}
      >
        {children}
      </div>
      <div style={{ display: "flex", alignItems: "center", height: 40 }}>
        {footer ?? <Address path={path} />}
      </div>
    </Canvas>
  );
}

/** `appflare.dev/start/install`: the site, then the page's path a shade darker. */
export function Address({ path, size = 24 }: { path: string; size?: number }) {
  const rest = path.replace(/\/$/, "");
  return (
    <div style={{ display: "flex", fontSize: size, color: colors.soft, letterSpacing: "-0.01em" }}>
      <span>appflare.dev</span>
      {rest !== "" && <span style={{ color: colors.muted }}>{rest}</span>}
    </div>
  );
}

/** A small caps label after the orange dot the front page puts before its own. */
export function Eyebrow({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: colors.flare }} />
      <span
        style={{
          fontSize: 21,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: colors.muted,
        }}
      >
        {children}
      </span>
    </div>
  );
}

const clamp = (lines: number): CSSProperties => ({
  display: "block",
  lineClamp: lines,
  textOverflow: "ellipsis",
});

/** A title fitted to at most `lines` lines of `width`, then clamped to them. */
export function Title({
  children,
  width,
  lines = 2,
  max,
  min,
  style,
}: {
  children: string;
  width: number;
  lines?: number;
  max: number;
  min: number;
  style?: CSSProperties;
}) {
  const size = fitText(children, { width, lines, max, min, bold: true });
  return (
    <div
      style={{
        ...clamp(lines),
        maxWidth: width,
        fontSize: size,
        fontWeight: 700,
        lineHeight: 1.06,
        letterSpacing: "-0.035em",
        textAlign: "center",
        textWrap: "balance",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The sub-line under a title, fitted and clamped like it. */
export function Subline({
  children,
  width,
  lines = 2,
  max = 30,
  min = 24,
  style,
}: {
  children: string;
  width: number;
  lines?: number;
  max?: number;
  min?: number;
  style?: CSSProperties;
}) {
  const size = fitText(children, { width, lines, max, min });
  return (
    <div
      style={{
        ...clamp(lines),
        maxWidth: width,
        fontSize: size,
        lineHeight: 1.34,
        color: colors.muted,
        letterSpacing: "-0.01em",
        textAlign: "center",
        textWrap: "balance",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A white rounded tile with a hairline and a soft shadow, as app icons sit on. */
function Tile({
  size,
  dark = false,
  children,
}: {
  size: number;
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        backgroundColor: dark ? colors.ink : "#ffffff",
        border: dark ? "none" : `${Math.max(1, Math.round(size / 100))}px solid ${colors.line}`,
        boxShadow: `0 ${Math.round(size / 12)}px ${Math.round(size / 4)}px -${Math.round(size / 10)}px rgba(0,0,0,${dark ? 0.3 : 0.16})`,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** An app's icon on a tile, or the first letter of its name when it has none. */
export function AppTile({ app, size }: { app: CardApp; size: number }) {
  if (app.icon === null) {
    const letter = Array.from(app.name.trim())[0]?.toUpperCase() ?? "?";
    return (
      <Tile size={size}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            backgroundColor: colors.tile,
            fontSize: Math.round(size * 0.46),
            fontWeight: 600,
            color: colors.soft,
          }}
        >
          {letter}
        </div>
      </Tile>
    );
  }
  const inner = Math.round(size * 0.76);
  return (
    <Tile size={size}>
      <img
        src={app.icon}
        width={inner}
        height={inner}
        alt=""
        style={{ objectFit: "contain", borderRadius: Math.round(size * 0.14) }}
      />
    </Tile>
  );
}

/** The dark "Install with Appflare" pill; the cloud in its mark is the card's accent. */
export function InstallPill({ size = 24 }: { size?: number }) {
  const unit = (n: number) => Math.round(size * n);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: unit(0.5),
        padding: `${unit(0.5)}px ${unit(1)}px ${unit(0.5)}px ${unit(0.6)}px`,
        borderRadius: 999,
        backgroundColor: colors.ink,
        color: "#ffffff",
        fontSize: size,
        fontWeight: 600,
        letterSpacing: "-0.01em",
      }}
    >
      <img src={MARK_WHITE} width={unit(1.3)} height={unit(1.3)} alt="" />
      <span>Install with Appflare</span>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <div
      style={{
        display: "flex",
        padding: "6px 18px",
        borderRadius: 999,
        border: `1px solid ${colors.line}`,
        backgroundColor: "#ffffff",
        fontSize: 21,
        color: colors.muted,
      }}
    >
      {children}
    </div>
  );
}

/* The kinds of card. */

/** The front page, and any page without a card of its own. */
function SiteCard({ title, description }: { title: string; description: string }) {
  return (
    <Canvas style={{ alignItems: "center", padding: "68px 80px 48px" }}>
      <Logo height={54} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flexGrow: 1,
          gap: 26,
        }}
      >
        <Title width={COLUMN} max={78} min={56}>
          {title}
        </Title>
        <Subline width={820} max={30} min={24}>
          {description}
        </Subline>
      </div>
      <div style={{ display: "flex", alignItems: "center", height: 40 }}>
        <Address path="" />
      </div>
    </Canvas>
  );
}

function DocsCard({
  section,
  title,
  description,
  path,
}: {
  section: string | null;
  title: string;
  description?: string | undefined;
  path: string;
}) {
  return (
    <Frame path={path}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
        <Eyebrow>{section ?? "Docs"}</Eyebrow>
        <Title width={COLUMN} max={84} min={54}>
          {title}
        </Title>
        {description !== undefined && description !== "" && (
          <Subline width={860}>{description}</Subline>
        )}
      </div>
    </Frame>
  );
}

function AppCard({ app, categories, path }: { app: CardApp; categories: string[]; path: string }) {
  return (
    <Frame path={path} footer={<InstallPill size={23} />}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <AppTile app={app} size={156} />
        <Title width={COLUMN} lines={1} max={76} min={52} style={{ marginTop: 30 }}>
          {app.name}
        </Title>
        <Subline width={860} max={30} min={24} style={{ marginTop: 12 }}>
          {app.pitch}
        </Subline>
        {categories.length > 0 && (
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            {categories.slice(0, 3).map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
          </div>
        )}
      </div>
    </Frame>
  );
}

function InstallCard({ app, path }: { app: CardApp; path: string }) {
  const title = `Install ${app.name} in your Cloudflare account`;
  const size = fitText(title, { width: COLUMN, lines: 2, max: 68, min: 48, bold: true });
  return (
    <Frame path={path} logo={false}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <AppTile app={app} size={124} />
          <Connector />
          <Tile size={124} dark>
            <img src={MARK_WHITE} width={76} height={76} alt="" />
          </Tile>
        </div>
        <div
          style={{
            ...clamp(2),
            maxWidth: COLUMN,
            fontSize: size,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: "-0.035em",
            textAlign: "center",
            textWrap: "balance",
          }}
        >
          <span>Install {app.name} </span>
          <span style={{ color: colors.soft }}>in your Cloudflare account</span>
        </div>
        <Subline width={860} lines={1} max={28} min={22}>
          {app.pitch}
        </Subline>
      </div>
    </Frame>
  );
}

/** Dots from the app to Appflare, the last one orange. */
function Connector() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: i === 2 ? colors.flare : "#d4d4d4",
          }}
        />
      ))}
    </div>
  );
}

/** The apps page and a category page: a badge, the title, and the first apps' icons. */
function ListCard({
  badge,
  title,
  description,
  apps,
  path,
}: {
  badge: ReactNode;
  title: string;
  description: string;
  apps: CardApp[];
  path: string;
}) {
  const shown = apps.slice(0, 7);
  const more = apps.length - shown.length;
  return (
    <Frame path={path}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <Tile size={96}>{badge}</Tile>
          <Title width={COLUMN - 130} lines={1} max={72} min={48}>
            {title}
          </Title>
        </div>
        <Subline width={880} style={{ marginTop: 26 }}>
          {description}
        </Subline>
        {shown.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 34 }}>
            {shown.map((app) => (
              <AppTile key={app.name} app={app} size={72} />
            ))}
            {more > 0 && (
              <span style={{ fontSize: 24, fontWeight: 600, color: colors.soft, marginLeft: 4 }}>
                +{more}
              </span>
            )}
          </div>
        )}
      </div>
    </Frame>
  );
}
