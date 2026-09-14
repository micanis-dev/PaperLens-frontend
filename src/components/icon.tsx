import { component$ } from "@builder.io/qwik";
import {
  BookOpen,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpDown,
  Check,
  CreditCard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FileDown,
  Globe,
  Heart,
  Library,
  Maximize2,
  Minimize2,
  Menu,
  MoveHorizontal,
  MoveVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Scan,
  Settings2,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  Sparkles,
} from "lucide";

const icons = {
  BookOpen,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpDown,
  Check,
  CreditCard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  Globe,
  FileText,
  Heart,
  Library,
  Maximize2,
  Minimize2,
  Menu,
  MoveHorizontal,
  MoveVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Scan,
  Settings2,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  Sparkles,
};

export type IconName = keyof typeof icons;

export const Icon = component$<{
  name: IconName;
  size?: number;
  class?: string;
}>(({ name, size = 18, class: className }) => (
  <svg
    class={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {icons[name].map(([tag, attrs], index) => {
      const Element = tag as "path";
      return <Element key={index} {...attrs} />;
    })}
  </svg>
));
