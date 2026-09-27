import {
  ArrowsClockwiseIcon,
  ArticleIcon,
  BellIcon,
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
  HardDrivesIcon,
  type Icon,
  LinkIcon,
  MegaphoneIcon,
  NetworkIcon,
  NotepadIcon,
  PasswordIcon,
  PencilLineIcon,
  PulseIcon,
  RobotIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SparkleIcon,
  ThumbsUpIcon,
  UsersIcon,
  UsersThreeIcon,
  WrenchIcon,
} from "@phosphor-icons/react";

/**
 * An icon per catalog category, chosen to be recognised at a glance. Chat and
 * sharing already use speech bubbles and the share symbol, so social is a
 * thumbs up.
 */
const CATEGORY_ICONS: Readonly<Record<string, Icon>> = {
  ai: SparkleIcon,
  analytics: ChartLineIcon,
  blogging: PencilLineIcon,
  bots: RobotIcon,
  business: BuildingsIcon,
  chat: ChatCircleIcon,
  cms: ArticleIcon,
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
  gaming: GameControllerIcon,
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
  social: ThumbsUpIcon,
  storage: HardDrivesIcon,
  sync: ArrowsClockwiseIcon,
  utilities: WrenchIcon,
};

/** The icon of a category the catalog adds before it has one of its own. */
export const FALLBACK_CATEGORY_ICON: Icon = CloudIcon;

/** The icon of a catalog category, or the fallback for one without its own. */
export function categoryIcon(category: string): Icon {
  return CATEGORY_ICONS[category] ?? FALLBACK_CATEGORY_ICON;
}

/** The icon of a catalog category, decorative (the category's name is always next to it). */
export function CategoryIcon({ category, size = 20 }: { category: string; size?: number }) {
  const CategoryGlyph = categoryIcon(category);
  return <CategoryGlyph size={size} aria-hidden />;
}
