import { canonicalCategory } from "@appflare/schema/catalog-display";
import {
  ArrowsClockwiseIcon,
  BellIcon,
  BrowserIcon,
  BuildingsIcon,
  CalendarBlankIcon,
  ChartLineIcon,
  ChatCircleIcon,
  CheckSquareIcon,
  CloudIcon,
  CodeIcon,
  CurrencyDollarIcon,
  DesktopIcon,
  EnvelopeSimpleIcon,
  EyeSlashIcon,
  FilmStripIcon,
  FolderIcon,
  GameControllerIcon,
  GlobeIcon,
  GraduationCapIcon,
  type Icon,
  LinkIcon,
  MegaphoneIcon,
  NetworkIcon,
  NotepadIcon,
  PasswordIcon,
  PulseIcon,
  RobotIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SparkleIcon,
  UsersIcon,
  UsersThreeIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The icon of each catalog category, the same ones the manager's category
 * cards show, so a shared category link looks like the category in Appflare.
 */
const CATEGORY_ICONS: Readonly<Record<string, Icon>> = {
  ai: SparkleIcon,
  analytics: ChartLineIcon,
  bots: RobotIcon,
  business: BuildingsIcon,
  chat: ChatCircleIcon,
  cms: BrowserIcon,
  community: UsersThreeIcon,
  "developer-tools": CodeIcon,
  dns: GlobeIcon,
  ecommerce: ShoppingCartIcon,
  education: GraduationCapIcon,
  email: EnvelopeSimpleIcon,
  family: UsersIcon,
  files: FolderIcon,
  finance: CurrencyDollarIcon,
  games: GameControllerIcon,
  "link-shortener": LinkIcon,
  marketing: MegaphoneIcon,
  media: FilmStripIcon,
  monitoring: PulseIcon,
  networking: NetworkIcon,
  notes: NotepadIcon,
  notifications: BellIcon,
  passwords: PasswordIcon,
  privacy: EyeSlashIcon,
  productivity: CheckSquareIcon,
  "remote-access": DesktopIcon,
  scheduling: CalendarBlankIcon,
  security: ShieldCheckIcon,
  sharing: ShareNetworkIcon,
  sync: ArrowsClockwiseIcon,
  utilities: WrenchIcon,
};

/**
 * A category's icon as an SVG data URI, drawn in `color` (a category the
 * catalog adds before it has an icon of its own gets the cloud). The card
 * renderer takes images, not React components, so the icon is rendered to
 * markup first.
 */
export function categoryIconUri(category: string, color: string): string {
  const Glyph = CATEGORY_ICONS[canonicalCategory(category)] ?? CloudIcon;
  const svg = renderToStaticMarkup(
    <Glyph size={256} color={color} weight="duotone" xmlns="http://www.w3.org/2000/svg" />,
  );
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
