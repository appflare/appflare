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
import { canonicalCategory } from "../catalog/browse";

/**
 * An icon per catalog category, chosen to be recognised at a glance. Websites
 * and blogs (`cms`) are a browser window, since the globe is DNS.
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

/** The icon of a category the catalog adds before it has one of its own. */
export const FALLBACK_CATEGORY_ICON: Icon = CloudIcon;

/**
 * The icon of a catalog category (a folded one shows the icon of the one it
 * became), or the fallback for one without its own.
 */
export function categoryIcon(category: string): Icon {
  return CATEGORY_ICONS[canonicalCategory(category)] ?? FALLBACK_CATEGORY_ICON;
}

/** The icon of a catalog category, decorative (the category's name is always next to it). */
export function CategoryIcon({ category, size = 20 }: { category: string; size?: number }) {
  const CategoryGlyph = categoryIcon(category);
  return <CategoryGlyph size={size} aria-hidden />;
}
