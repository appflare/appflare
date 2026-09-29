import { type CatalogCategory, isCatalogCategory } from "@appflare/schema/catalog-display";
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
  GraduationCapIcon,
  type Icon,
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

/**
 * An icon per catalog category (the schema's `CATALOG_CATEGORIES`), chosen to
 * be recognised at a glance. Websites and blogs (`cms`) are a browser window.
 */
const CATEGORY_ICONS: Readonly<Record<CatalogCategory, Icon>> = {
  ai: SparkleIcon,
  analytics: ChartLineIcon,
  bots: RobotIcon,
  business: BuildingsIcon,
  chat: ChatCircleIcon,
  cms: BrowserIcon,
  community: UsersThreeIcon,
  "developer-tools": CodeIcon,
  ecommerce: ShoppingCartIcon,
  education: GraduationCapIcon,
  email: EnvelopeSimpleIcon,
  family: UsersIcon,
  files: FolderIcon,
  finance: CurrencyDollarIcon,
  games: GameControllerIcon,
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

/** The icon of a category this version does not know (a custom catalog's). */
export const FALLBACK_CATEGORY_ICON: Icon = CloudIcon;

/** The icon of a catalog category, or the fallback for an id this version does not know. */
export function categoryIcon(category: string): Icon {
  return isCatalogCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

/** The icon of a catalog category, decorative (the category's name is always next to it). */
export function CategoryIcon({ category, size = 20 }: { category: string; size?: number }) {
  const CategoryGlyph = categoryIcon(category);
  return <CategoryGlyph size={size} aria-hidden />;
}
