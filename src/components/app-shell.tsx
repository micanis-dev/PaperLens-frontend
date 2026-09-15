import {
  $,
  component$,
  Slot,
  useOnWindow,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, useLocation, useNavigate } from "@builder.io/qwik-city";
import { Icon } from "~/components/icon";
import { cn } from "~/lib/utils";
import { getPaper, getSetting, listPapers, saveSetting } from "~/lib/storage";
import { message, type Locale, useLocale } from "~/lib/i18n";

type SwitcherPaper = { id: string; title: string; searchText: string };
type SwitcherCategory = "screen" | "open" | "paper";
type SwitcherResult = {
  title: string;
  href: string;
  searchText: string;
  category: SwitcherCategory;
};

const normalizeSwitcherText = (value: string) =>
  value.trim().toLocaleLowerCase();

export const OpenTabs = component$<{ variant?: "shell" | "reader" }>(
  ({ variant = "shell" }) => {
    const locale = useLocale();
    const location = useLocation();
    const navigate = useNavigate();
    const tabs = useSignal<{ id: string; title: string }[]>([]);
    useVisibleTask$(({ track, cleanup }) => {
      track(() => location.url.href);
      let disposed = false;
      cleanup(() => {
        disposed = true;
      });
      void (async () => {
        let storedTabs: { id: string; title: string }[];
        try {
          storedTabs = await getSetting("openTabs", []);
        } catch {
          return;
        }
        if (disposed) return;
        const id = location.params.id;
        if (!id) {
          tabs.value = storedTabs;
          return;
        }
        const paper = await getPaper(id);
        if (disposed || !paper) return;
        tabs.value = [
          { id, title: paper.title || paper.fileName },
          ...storedTabs.filter((tab) => tab.id !== id),
        ].slice(0, 8);
        try {
          await saveSetting("openTabs", tabs.value);
        } catch {
          /* read-only migration mode still permits reading */
        }
      })();
    });
    useOnWindow(
      "keydown",
      $((event) => {
        if (
          !(event.metaKey || event.ctrlKey) ||
          !event.shiftKey ||
          !["ArrowLeft", "ArrowRight"].includes(event.key)
        )
          return;
        const target = event.target as HTMLElement | null;
        if (
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable ||
          tabs.value.length < 2
        )
          return;
        const currentIndex = tabs.value.findIndex(
          (tab) => tab.id === location.params.id,
        );
        if (currentIndex < 0) return;
        event.preventDefault();
        const offset = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex =
          (currentIndex + offset + tabs.value.length) % tabs.value.length;
        void navigate(`/papers/${tabs.value[nextIndex].id}/`);
      }),
    );
    const close = $(async (id: string) => {
      tabs.value = tabs.value.filter((tab) => tab.id !== id);
      try {
        await saveSetting("openTabs", tabs.value);
      } catch {
        /* keep the in-memory tab state */
      }
    });
    if (!tabs.value.length) return null;
    return (
      <nav
        aria-label={locale.value === "en" ? "Open papers" : "開いている論文"}
        class={
          variant === "reader"
            ? "flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 bg-[#3a3e41] px-2"
            : "flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-5 sm:px-8"
        }
      >
        <span
          class={
            variant === "reader"
              ? "shrink-0 py-1.5 text-[10px] font-semibold text-white/45"
              : "shrink-0 py-3 text-xs font-semibold text-slate-400"
          }
        >
          {message(locale.value, "tabs")}
        </span>
        {tabs.value.map((tab) => (
          <div
            key={tab.id}
            class={
              variant === "reader"
                ? "flex shrink-0 items-center border-l border-white/10"
                : "flex shrink-0 items-center border-l border-slate-200"
            }
          >
            <Link
              href={`/papers/${tab.id}/`}
              class={
                location.params.id === tab.id
                  ? variant === "reader"
                    ? "border-b-2 border-sky-300 px-2.5 py-1.5 text-[11px] font-semibold text-white"
                    : "border-b-2 border-sky-400 px-3 py-3 text-xs font-semibold text-slate-950"
                  : variant === "reader"
                    ? "px-2.5 py-1.5 text-[11px] text-white/55 hover:text-white"
                    : "px-3 py-3 text-xs text-slate-500 hover:text-slate-950"
              }
              aria-current={location.params.id === tab.id ? "page" : undefined}
            >
              {tab.title}
            </Link>
            <button
              type="button"
              aria-label={`${tab.title} ${message(locale.value, "close")}`}
              class={
                variant === "reader"
                  ? "flex size-7 items-center justify-center text-white/40 hover:text-white"
                  : "flex size-8 items-center justify-center text-slate-400 hover:text-slate-950"
              }
              onClick$={() => close(tab.id)}
            >
              <Icon name="X" size={13} />
            </button>
          </div>
        ))}
      </nav>
    );
  },
);

const QuickSwitcher = component$(() => {
  const locale = useLocale();
  const open = useSignal(false);
  const query = useSignal("");
  const tabs = useSignal<{ id: string; title: string }[]>([]);
  const papers = useSignal<SwitcherPaper[]>([]);
  const loadCandidates = $(async () => {
    const [tabsResult, papersResult] = await Promise.allSettled([
      getSetting("openTabs", []),
      listPapers(),
    ]);
    if (tabsResult.status === "fulfilled") tabs.value = tabsResult.value;
    if (papersResult.status === "fulfilled") {
      papers.value = papersResult.value.map((paper) => {
        const title = paper.title || paper.fileName;
        return {
          id: paper.id,
          title,
          searchText: normalizeSwitcherText(
            [title, paper.fileName, ...paper.authors, ...paper.tags].join(" "),
          ),
        };
      });
    }
  });
  useVisibleTask$(() => {
    void loadCandidates();
  });
  useOnWindow(
    "keydown",
    $((event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open.value = true;
        query.value = "";
        void loadCandidates();
      }
      if (event.key === "Escape") open.value = false;
    }),
  );
  const routes = [
    {
      title: message(locale.value, "library"),
      href: "/",
      searchText: normalizeSwitcherText(message(locale.value, "library")),
      category: "screen" as const,
    },
    {
      title: message(locale.value, "addPaper"),
      href: "/upload/",
      searchText: normalizeSwitcherText(message(locale.value, "addPaper")),
      category: "screen" as const,
    },
    {
      title: message(locale.value, "llmOperations"),
      href: "/llm/",
      searchText: normalizeSwitcherText(message(locale.value, "llmOperations")),
      category: "screen" as const,
    },
    {
      title: message(locale.value, "settings"),
      href: "/settings/",
      searchText: normalizeSwitcherText(message(locale.value, "settings")),
      category: "screen" as const,
    },
  ];
  const openIDs = new Set(tabs.value.map((tab) => tab.id));
  const openPaperResults: SwitcherResult[] = tabs.value.map((tab) => {
    const paper = papers.value.find((item) => item.id === tab.id);
    return {
      title: tab.title,
      href: `/papers/${tab.id}/`,
      searchText: paper?.searchText || normalizeSwitcherText(tab.title),
      category: "open",
    };
  });
  const libraryResults: SwitcherResult[] = papers.value
    .filter((paper) => !openIDs.has(paper.id))
    .map((paper) => ({
      title: paper.title,
      href: `/papers/${paper.id}/`,
      searchText: paper.searchText,
      category: "paper",
    }));
  const needle = normalizeSwitcherText(query.value);
  const results = [...routes, ...openPaperResults, ...libraryResults]
    .filter((item) => !needle || item.searchText.includes(needle))
    .slice(0, 40);
  if (!open.value) return null;
  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/30 px-4 pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label={message(locale.value, "quickSwitcher")}
      onClick$={() => (open.value = false)}
    >
      <div
        class="w-full max-w-xl border border-slate-300 bg-white shadow-2xl"
        onClick$={(event) => event.stopPropagation()}
      >
        <div class="border-b border-slate-200 p-3">
          <label>
            <span class="sr-only">
              {message(locale.value, "searchNavigation")}
            </span>
            <input
              autoFocus
              value={query.value}
              onInput$={(_, el) => (query.value = el.value)}
              placeholder={message(locale.value, "searchDestination")}
            />
          </label>
        </div>
        <nav
          aria-label={locale.value === "en" ? "Destinations" : "移動先"}
          class="max-h-80 overflow-auto p-2"
        >
          {results.length ? (
            results.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                class="flex items-center gap-3 border-l-2 border-transparent px-3 py-3 text-sm hover:border-sky-400 hover:bg-sky-50"
                onClick$={() => (open.value = false)}
              >
                <span class="min-w-0 flex-1 truncate">{item.title}</span>
                <span class="shrink-0 text-[10px] text-slate-400">
                  {item.category === "screen"
                    ? locale.value === "en"
                      ? "Screen"
                      : "画面"
                    : item.category === "open"
                      ? locale.value === "en"
                        ? "Open"
                        : "開いている論文"
                      : locale.value === "en"
                        ? "Paper"
                        : "論文"}
                </span>
              </Link>
            ))
          ) : (
            <p class="p-4 text-sm text-slate-500">
              {message(locale.value, "noDestination")}
            </p>
          )}
        </nav>
        <p class="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
          {message(locale.value, "escapeClose")}
        </p>
      </div>
    </div>
  );
});

const navigation = (locale: Locale) => [
  { label: message(locale, "allPapers"), href: "/", icon: "Library" as const },
  { label: message(locale, "llm"), href: "/llm/", icon: "Sparkles" as const },
  {
    label: message(locale, "billing"),
    href: "/billing/",
    icon: "CreditCard" as const,
  },
];

const sectionTitle = (pathname: string, locale: Locale) => {
  if (pathname.startsWith("/upload")) return message(locale, "addPaper");
  if (pathname.startsWith("/llm")) return message(locale, "llmOperations");
  if (pathname.startsWith("/billing")) return message(locale, "billing");
  if (pathname.startsWith("/settings")) return message(locale, "settings");
  if (pathname.startsWith("/papers")) return message(locale, "reading");
  return message(locale, "library");
};

export const AppShell = component$(() => {
  const mobileOpen = useSignal(false);
  const locale = useLocale();
  const location = useLocation();
  const isReader = location.url.pathname.startsWith("/papers/");
  const items = navigation(locale.value);
  const currentTitle = sectionTitle(location.url.pathname, locale.value);
  const isActive = (href: string) => {
    if (href === "/")
      return location.url.pathname === "/" && !location.url.search;
    if (href.includes("?")) {
      const [path, query] = href.split("?");
      return (
        location.url.pathname === path && location.url.search === `?${query}`
      );
    }
    return location.url.pathname.startsWith(href);
  };
  return (
    <div class="min-h-screen bg-white text-slate-950">
      <QuickSwitcher />
      <button
        type="button"
        class={cn(
          "fixed inset-0 z-30 bg-slate-950/20 lg:hidden",
          mobileOpen.value ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-label="メニューを閉じる"
        onClick$={() => (mobileOpen.value = false)}
      />
      <aside
        class={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-slate-200 bg-[#fbfbfd] px-4 py-6 transition-transform lg:translate-x-0",
          mobileOpen.value ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div class="flex items-center justify-between px-3 pb-10">
          <Link
            href="/"
            class="flex items-center gap-3"
            onClick$={() => (mobileOpen.value = false)}
          >
            <span class="flex size-9 items-center justify-center bg-slate-950 text-white">
              <Icon name="BookOpen" size={18} />
            </span>
            <span class="text-lg font-bold tracking-[-0.04em]">PaperLens</span>
          </Link>
          <button
            type="button"
            class="p-2 text-slate-500 lg:hidden"
            aria-label="メニューを閉じる"
            onClick$={() => (mobileOpen.value = false)}
          >
            <Icon name="X" size={18} />
          </button>
        </div>
        <Link
          href="/upload/"
          class="button primary mb-8 w-full"
          onClick$={() => (mobileOpen.value = false)}
        >
          <Icon name="Plus" size={17} />
          {message(locale.value, "addPaper")}
        </Link>
        <nav
          aria-label={
            locale.value === "en" ? "Main navigation" : "メインナビゲーション"
          }
        >
          <p class="mb-2 px-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {message(locale.value, "library")}
          </p>
          <div class="space-y-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                class={cn(
                  "flex items-center gap-3 border-l-2 px-3 py-2.5 text-sm font-medium transition-colors hover:border-sky-400 hover:bg-slate-100 hover:text-slate-950",
                  isActive(item.href)
                    ? "border-sky-400 bg-sky-50 text-slate-950"
                    : "border-transparent text-slate-500",
                )}
                aria-current={isActive(item.href) ? "page" : undefined}
                onClick$={() => (mobileOpen.value = false)}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
          <p class="mb-2 mt-8 px-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {message(locale.value, "management")}
          </p>
          <Link
            href="/settings/"
            class={cn(
              "flex items-center gap-3 border-l-2 px-3 py-2.5 text-sm font-medium transition-colors hover:border-sky-400 hover:bg-slate-100 hover:text-slate-950",
              isActive("/settings/")
                ? "border-sky-400 bg-sky-50 text-slate-950"
                : "border-transparent text-slate-500",
            )}
            aria-current={isActive("/settings/") ? "page" : undefined}
            onClick$={() => (mobileOpen.value = false)}
          >
            <Icon name="Settings2" size={18} />
            {message(locale.value, "settings")}
          </Link>
        </nav>
      </aside>
      <div class="lg:pl-60">
        <header class="sticky top-0 z-20 flex h-14 items-center border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            class="flex size-10 items-center justify-center text-slate-500 lg:hidden"
            aria-label={locale.value === "en" ? "Open menu" : "メニューを開く"}
            onClick$={() => (mobileOpen.value = true)}
          >
            <Icon name="Menu" size={20} />
          </button>
          <span class="ml-2 text-sm font-semibold text-slate-950">
            {currentTitle}
          </span>
          {!isReader && (
            <Link
              href="/upload/"
              class="ml-auto flex size-10 items-center justify-center text-slate-600"
              aria-label={message(locale.value, "addPaper")}
            >
              <Icon name="Plus" size={20} />
            </Link>
          )}
        </header>
        <OpenTabs />
        <main
          class={cn(
            "app-main w-full",
            isReader ? "px-3 py-4 sm:px-5" : "px-5 py-8 sm:px-8 sm:py-10",
          )}
        >
          <Slot />
        </main>
      </div>
    </div>
  );
});
