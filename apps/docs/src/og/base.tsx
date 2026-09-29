import type { CSSProperties, ReactNode } from "react";
import fullLogo from "../../../../docs/assets/logo_full.svg?raw";
import squareLogo from "../../../../docs/assets/logo_square.svg?raw";
import squareLogoWhite from "../../../../docs/assets/logo_square_white.svg?raw";
import { fitText } from "./fit.ts";
import type { OgPicture } from "./picture.ts";

/**
 * The one visual system of every link preview Appflare draws: the site's
 * OpenGraph cards (`cards.tsx`) and the GitHub repositories' social previews
 * (`social.tsx`). A light neutral canvas with a faint dot grid and the orange
 * glow of the front page, the logo top left, a large left-aligned headline
 * with a sub-line under it, a quiet footer with the address, and on the
 * right a picture of the product: a window with a real screenshot, a wall of
 * app icons, or an app's own icon.
 */

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

/** An app as a card draws it. */
export interface CardApp {
  name: string;
  /** The one line under the name. */
  pitch: string;
  /** The icon as a data URI; null draws the name's first letter instead. */
  icon: string | null;
}

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

/** `appflare.dev / github.com/appflare/appflare`: the site and a repository. */
export function RepoAddress({ repo, size }: { repo: string; size: number }) {
  return (
    <>
      <Address path="" size={size} />
      <span style={{ fontSize: size, color: colors.line }}>/</span>
      <span style={{ fontSize: size, color: colors.muted }}>github.com/{repo}</span>
    </>
  );
}

/** A small caps label after the orange dot the front page puts before its own. */
export function Eyebrow({ children, size = 21 }: { children: string; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: Math.round(size * 0.57) }}>
      <div
        style={{
          width: Math.round(size * 0.52),
          height: Math.round(size * 0.52),
          borderRadius: size,
          backgroundColor: colors.flare,
        }}
      />
      <span
        style={{
          fontSize: size,
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

/**
 * A title fitted to at most `lines` lines of `width`, then clamped to them.
 * A `tail` follows it a shade lighter, as part of the same sentence.
 */
export function Title({
  children,
  tail,
  width,
  lines = 2,
  max,
  min,
  style,
}: {
  children: string;
  tail?: string | undefined;
  width: number;
  lines?: number;
  max: number;
  min: number;
  style?: CSSProperties;
}) {
  const text = tail === undefined ? children : `${children} ${tail}`;
  const size = fitText(text, { width, lines, max, min, bold: true });
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
      {tail === undefined ? (
        children
      ) : (
        <>
          <span>{children} </span>
          <span style={{ color: colors.muted }}>{tail}</span>
        </>
      )}
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
export function Tile({
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

/** Appflare's mark on its dark tile, as an app's icon would sit. */
export function MarkTile({ size }: { size: number }) {
  const mark = Math.round(size * 0.62);
  return (
    <Tile size={size} dark>
      <img src={MARK_WHITE} width={mark} height={mark} alt="" />
    </Tile>
  );
}

/** The dark "Install with Appflare" pill; the cloud in its mark is the card's accent. */
export function InstallPill({
  size = 24,
  label = "Install with Appflare",
}: {
  size?: number;
  label?: string;
}) {
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
      <span>{label}</span>
    </div>
  );
}

/** A white rounded label with a hairline, such as a category's name. */
export function Chip({ children, size = 21 }: { children: string; size?: number }) {
  return (
    <div
      style={{
        display: "flex",
        padding: `${Math.round(size * 0.3)}px ${Math.round(size * 0.85)}px`,
        borderRadius: 999,
        border: `1px solid ${colors.line}`,
        backgroundColor: "#ffffff",
        fontSize: size,
        color: colors.muted,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The measures of one size of preview: the margins, the logo, the width of
 * the words on the left, and the sizes the headline and sub-line fit between.
 */
export interface SplitFrame {
  padding: string;
  logo: number;
  /** The width of the headline; the picture starts to the right of it. */
  text: number;
  title: { lines: number; max: number; min: number };
  line: { width: number; lines: number; max: number; min: number };
  /** Space between the eyebrow, the headline, the sub-line and what follows them. */
  gap: number;
  footer: { size: number; gap: number };
}

/**
 * The composition every preview shares: the picture (absolutely placed, so
 * it may run off the edges), the logo top left, the words in the middle of
 * the left side, and the footer at the bottom.
 */
export function Split({
  frame,
  eyebrow,
  title,
  tail,
  line,
  extra,
  footer,
  children,
}: {
  frame: SplitFrame;
  eyebrow?: string | undefined;
  title: string;
  /** The end of the headline, drawn a shade lighter. */
  tail?: string | undefined;
  line?: string | undefined;
  /** What follows the sub-line, such as category chips or the install pill. */
  extra?: ReactNode;
  footer: ReactNode;
  /** The picture on the right. */
  children: ReactNode;
}) {
  return (
    <Canvas style={{ padding: frame.padding, overflow: "hidden" }}>
      {children}
      <Logo height={frame.logo} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          flexGrow: 1,
          gap: frame.gap,
        }}
      >
        {eyebrow !== undefined && (
          <Eyebrow size={Math.round(frame.footer.size * 0.86)}>{eyebrow}</Eyebrow>
        )}
        <Title
          width={frame.text}
          tail={tail}
          lines={frame.title.lines}
          max={frame.title.max}
          min={frame.title.min}
          style={{ textAlign: "left" }}
        >
          {title}
        </Title>
        {line !== undefined && line !== "" && (
          <Subline
            width={frame.line.width}
            lines={frame.line.lines}
            max={frame.line.max}
            min={frame.line.min}
            style={{ textAlign: "left" }}
          >
            {line}
          </Subline>
        )}
        {extra}
      </div>
      <div style={{ display: "flex", gap: frame.footer.gap, alignItems: "center" }}>{footer}</div>
    </Canvas>
  );
}

/** Which part of a picture a window shows: its scale, and the offset of its top-left corner. */
export interface Crop {
  scale: number;
  x: number;
  y: number;
}

/**
 * The manager's Home, cropped to the "Your apps" list: at 0.8 of the
 * 2352x1384 screenshot the tiles stay readable at half size.
 */
export const YOUR_APPS_CROP: Crop = { scale: 0.8, x: 84, y: 596 };

/** A browser-like window, placed absolutely (often running off the edges), showing a crop of a picture. */
export function Window({
  picture,
  crop,
  left,
  top,
  width,
  height,
}: {
  picture: OgPicture;
  crop: Crop;
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "absolute",
        left,
        top,
        width,
        height,
        borderRadius: 18,
        border: "1px solid rgba(0,0,0,0.1)",
        backgroundColor: "#fafafa",
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.25)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "14px 18px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.12)" }}
          />
        ))}
      </div>
      <div style={{ display: "flex", position: "relative", flexGrow: 1, overflow: "hidden" }}>
        <img
          src={picture.src}
          width={Math.round(picture.width * crop.scale)}
          height={Math.round(picture.height * crop.scale)}
          alt=""
          style={{ position: "absolute", left: -crop.x, top: -crop.y }}
        />
      </div>
    </div>
  );
}

/** App icons in offset rows, placed absolutely and running off the edges. */
export function IconWall({
  apps,
  left,
  top,
  size,
  gap,
  rows = 5,
  perRow = 5,
}: {
  apps: CardApp[];
  left: number;
  top: number;
  size: number;
  gap: number;
  rows?: number;
  perRow?: number;
}) {
  const lines = Array.from({ length: rows }, (_, row) =>
    apps.slice(row * perRow, row * perRow + perRow),
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        position: "absolute",
        left,
        top,
      }}
    >
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows never reorder
          key={i}
          style={{ display: "flex", gap, marginLeft: i % 2 === 0 ? 0 : (size + gap) / 2 }}
        >
          {line.map((app, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two apps may share a name
            <AppTile key={j} app={app} size={size} />
          ))}
        </div>
      ))}
    </div>
  );
}
