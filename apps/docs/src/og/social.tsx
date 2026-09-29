import type { ReactNode } from "react";
import {
  type CardApp,
  colors,
  IconWall,
  MARK_WHITE,
  RepoAddress,
  Split,
  type SplitFrame,
  Window,
  YOUR_APPS_CROP,
} from "./base.tsx";
import type { OgPicture } from "./picture.ts";

/**
 * The social preview images of the three GitHub repositories, drawn in the
 * same system as the site's cards (`base.tsx`) at GitHub's 1280x640: the
 * logo, the line that says what the repository is, and a picture of the
 * product on the right. GitHub has no API for them;
 * `scripts/social-previews.ts` writes them to `docs/assets/`, and the
 * maintainer uploads each one by hand.
 */

export const SOCIAL_WIDTH = 1280;
export const SOCIAL_HEIGHT = 640;

export type SocialPreview =
  | {
      repo: "appflare";
      /** The manager's Home screenshot. */
      screenshot: OgPicture;
    }
  | { repo: "catalog"; apps: CardApp[]; count: number }
  | { repo: "deploy" };

const FRAME: SplitFrame = {
  padding: "72px 88px 60px",
  logo: 50,
  text: 560,
  title: { lines: 3, max: 62, min: 46 },
  line: { width: 520, lines: 3, max: 27, min: 22 },
  gap: 24,
  footer: { size: 24, gap: 22 },
};

export function socialPreviewElement(preview: SocialPreview): ReactNode {
  switch (preview.repo) {
    case "appflare":
      return (
        <Layout
          repo="appflare/appflare"
          title="The app manager for your own Cloudflare account"
          line="One Worker in your account installs apps built for Workers and keeps them updated."
        >
          <Window
            picture={preview.screenshot}
            crop={YOUR_APPS_CROP}
            left={700}
            top={96}
            width={680}
            height={640}
          />
        </Layout>
      );
    case "catalog":
      return (
        <Layout
          repo="appflare/catalog"
          title="The catalog of apps Appflare installs"
          line={`${preview.count} apps built for Workers, each built from a pinned upstream commit and signed.`}
        >
          <IconWall apps={preview.apps} left={720} top={-38} size={112} gap={26} />
        </Layout>
      );
    case "deploy":
      return (
        <Layout
          repo="appflare/deploy"
          title="Deploy Appflare to your Cloudflare account"
          line="One click puts a prebuilt Appflare in your account and opens the setup wizard."
        >
          <DeployPicture />
        </Layout>
      );
  }
}

function Layout({
  repo,
  title,
  line,
  children,
}: {
  repo: string;
  title: string;
  line: string;
  children: ReactNode;
}) {
  return (
    <Split
      frame={FRAME}
      title={title}
      line={line}
      footer={<RepoAddress repo={repo} size={FRAME.footer.size} />}
    >
      {children}
    </Split>
  );
}

/** The mark on its dark tile, as an app's icon would sit, with the account it lands in. */
function DeployPicture() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 34,
        position: "absolute",
        left: 760,
        top: 150,
        width: 440,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 240,
          height: 240,
          borderRadius: 58,
          backgroundColor: colors.ink,
          boxShadow: "0 30px 60px -20px rgba(0,0,0,0.35)",
        }}
      >
        <img src={MARK_WHITE} width={150} height={150} alt="" />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 24px",
          borderRadius: 999,
          border: `1px solid ${colors.line}`,
          backgroundColor: "#ffffff",
          fontSize: 24,
          color: colors.muted,
        }}
      >
        <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: colors.flare }} />
        <span>Your account, your plan</span>
      </div>
    </div>
  );
}
