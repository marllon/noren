import {
  BookOpen,
  Briefcase,
  Code,
  FlaskConical,
  Folder,
  Globe,
  House,
  Rocket,
  Server,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SpaceIconName } from "./spaces";

/** The Lucide icons a space can carry, by the name stored in `space.icon`. */
export const SPACE_ICONS: Record<SpaceIconName, { label: string; Icon: LucideIcon }> = {
  terminal: { label: "Terminal", Icon: Terminal },
  folder: { label: "Folder", Icon: Folder },
  code: { label: "Code", Icon: Code },
  rocket: { label: "Rocket", Icon: Rocket },
  briefcase: { label: "Briefcase", Icon: Briefcase },
  house: { label: "House", Icon: House },
  "book-open": { label: "Book", Icon: BookOpen },
  "flask-conical": { label: "Flask", Icon: FlaskConical },
  server: { label: "Server", Icon: Server },
  globe: { label: "Globe", Icon: Globe },
};

function isSpaceIcon(name: string): name is SpaceIconName {
  return Object.hasOwn(SPACE_ICONS, name);
}

/** The icon of a space in its color. A name that is not a known Lucide icon shows as text. */
export function SpaceIcon({ name, color }: { name: string; color: string }) {
  if (isSpaceIcon(name)) {
    const { Icon } = SPACE_ICONS[name];
    return <Icon size={18} color={color} aria-hidden="true" />;
  }
  return (
    <span className="space-glyph" style={{ color }} aria-hidden="true">
      {name}
    </span>
  );
}
