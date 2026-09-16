import {
  $,
  component$,
  noSerialize,
  Slot,
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
    // Open tabs are stored only in the browser.
    // eslint-disable-next-line qwik/no-use-visible-task
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
        const existing = storedTabs.filter((tab) => tab.id !== id);
        // Opening a paper should not reorder the user's working set. Append
        // only when it was not already open.
        tabs.value = storedTabs.some((tab) => tab.id === id)
          ? storedTabs.map((tab) =>
              tab.id === id
                ? { ...tab, title: paper.title || paper.fileName }
                : tab,
            )
          : [...existing, { id, title: paper.title || paper.fileName }].slice(
              -8,
            );
        try {
          await saveSetting("openTabs", tabs.value);
        } catch {
          /* read-only migration mode still permits reading */
        }
      })();
    });
    // A native listener prevents the browser shortcut synchronously; a lazy
    // QRL handler cannot reliably call preventDefault after it is resumed.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(({ cleanup }) => {
      const handleKeydown = (event: KeyboardEvent) => {
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
      };
      window.addEventListener("keydown", handleKeydown);
      cleanup(() => window.removeEventListener("keydown", handleKeydown));
    });
    const close = $(async (id: string) => {
      const wasCurrent = location.params.id === id;
      tabs.value = tabs.value.filter((tab) => tab.id !== id);
      try {
        await saveSetting("openTabs", tabs.value);
      } catch {
        /* keep the in-memory tab state */
      }
      if (wasCurrent) {
        const next = tabs.value[0];
        void navigate(next ? `/papers/${next.id}/` : "/");
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
                    ? "max-w-[min(28rem,60vw)] truncate border-b-2 border-sky-300 px-2.5 py-1.5 text-[11px] font-semibold text-white"
                    : "max-w-[min(28rem,60vw)] truncate border-b-2 border-sky-400 px-3 py-3 text-xs font-semibold text-slate-950"
                  : variant === "reader"
                    ? "max-w-[min(28rem,60vw)] truncate px-2.5 py-1.5 text-[11px] text-white/75 hover:text-white"
                    : "max-w-[min(28rem,60vw)] truncate px-3 py-3 text-xs text-slate-500 hover:text-slate-950"
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

export const QuickSwitcher = component$(() => {
  const locale = useLocale();
  const open = useSignal(false);
  const query = useSignal("");
  const returnFocus = useSignal<HTMLElement>();
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
  const close = $(() => {
    open.value = false;
    const target = returnFocus.value;
    if (target) window.setTimeout(() => target.focus(), 0);
  });
  // Quick-switcher data is browser-local.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    void loadCandidates();
  });
  // Move focus into the dialog after it is mounted and return it naturally
  // through the modal's focus cycle.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    track(() => open.value);
    if (!open.value) return;
    const timer = window.setTimeout(
      () =>
        document
          .querySelector<HTMLElement>("[data-quick-switcher] input")
          ?.focus(),
      0,
    );
    cleanup(() => window.clearTimeout(timer));
  });
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!open.value)
          returnFocus.value = noSerialize(
            document.activeElement as HTMLElement,
          );
        open.value = true;
        query.value = "";
        void loadCandidates();
      }
      if (event.key === "Escape" && open.value) close();
      if (open.value && event.key === "Tab") {
        const dialog = document.querySelector<HTMLElement>(
          "[data-quick-switcher]",
        );
        const focusable = dialog
          ? Array.from(
              dialog.querySelectorAll<HTMLElement>(
                "a,button,input,[tabindex]:not([tabindex='-1'])",
              ),
            )
          : [];
        if (focusable.length) {
          const first = focusable[0],
            last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeydown);
    cleanup(() => window.removeEventListener("keydown", handleKeydown));
  });
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
      onClick$={close}
    >
      <div
        data-quick-switcher
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
                onClick$={close}
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
  {
    label: message(locale, "billing"),
    href: "/billing/",
    icon: "CreditCard" as const,
  },
];

const sectionTitle = (pathname: string, locale: Locale) => {
  if (pathname.startsWith("/upload")) return message(locale, "addPaper");
  if (pathname.startsWith("/llm")) return message(locale, "llm");
  if (pathname.startsWith("/billing")) return message(locale, "billing");
  if (pathname.startsWith("/settings")) return message(locale, "settings");
  if (pathname.startsWith("/papers")) return message(locale, "reading");
  return message(locale, "library");
};

export const AppShell = component$(() => {
  const mobileOpen = useSignal(false);
  const isMobile = useSignal(false);
  const menuTrigger = useSignal<HTMLButtonElement>();
  const mobileNav = useSignal<HTMLElement>();
  const locale = useLocale();
  const location = useLocation();
  const isReader = location.url.pathname.startsWith("/papers/");
  const items = navigation(locale.value);
  const currentTitle = sectionTitle(location.url.pathname, locale.value);
  // Keep the off-canvas navigation out of the tab order only on mobile;
  // desktop uses the same aside as the primary navigation.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const media = window.matchMedia("(max-width: 1023px)");
    const sync = () => (isMobile.value = media.matches);
    sync();
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isMobile.value && mobileOpen.value) {
        mobileOpen.value = false;
        menuTrigger.value?.focus();
      }
    };
    media.addEventListener("change", sync);
    window.addEventListener("keydown", onKeydown);
    cleanup(() => {
      media.removeEventListener("change", sync);
      window.removeEventListener("keydown", onKeydown);
    });
  });
  // Keep keyboard focus inside the newly opened navigation and return it to
  // the trigger after closing. The inert attribute handles the closed state;
  // this also makes Escape and link activation predictable for keyboard users.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    track(() => mobileOpen.value);
    if (!mobileOpen.value) return;
    const frame = requestAnimationFrame(() => {
      mobileNav.value?.querySelector<HTMLElement>("a,button")?.focus();
    });
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !mobileNav.value) return;
      const focusable = Array.from(
        mobileNav.value.querySelectorAll<HTMLElement>(
          "a,button,input,select,textarea,[tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeydown);
    cleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeydown);
    });
  });
  const closeMobileMenu = $(() => {
    mobileOpen.value = false;
    if (isMobile.value) menuTrigger.value?.focus();
  });
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
        aria-label={message(locale.value, "close")}
        aria-hidden={!mobileOpen.value ? "true" : undefined}
        tabIndex={mobileOpen.value ? 0 : -1}
        onClick$={closeMobileMenu}
      />
      <aside
        data-mobile-nav
        ref={mobileNav}
        inert={isMobile.value && !mobileOpen.value ? true : undefined}
        aria-hidden={isMobile.value && !mobileOpen.value ? "true" : undefined}
        class={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-slate-200 bg-[#fbfbfd] px-4 py-6 transition-transform lg:translate-x-0",
          mobileOpen.value ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div class="flex items-center justify-between px-3 pb-10">
          <Link
            href="/"
            class="flex items-center gap-3"
            onClick$={closeMobileMenu}
          >
            {/* Shared vector artwork needs no raster image optimization. */}
            <img
              // eslint-disable-next-line qwik/jsx-img
              src="/icons/paperlens-sky-v1.svg"
              width={36}
              height={36}
              alt=""
              class="shrink-0"
            />
            <span class="text-lg font-bold tracking-[-0.04em]">PaperLens</span>
          </Link>
          <button
            type="button"
            class="p-2 text-slate-500 lg:hidden"
            aria-label={message(locale.value, "close")}
            onClick$={closeMobileMenu}
          >
            <Icon name="X" size={18} />
          </button>
        </div>
        <Link
          href="/upload/"
          class="button primary mb-8 w-full"
          onClick$={closeMobileMenu}
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
                onClick$={closeMobileMenu}
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
            onClick$={closeMobileMenu}
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
            data-mobile-menu-trigger
            ref={menuTrigger}
            class="flex size-10 items-center justify-center text-slate-500 lg:hidden"
            aria-label={locale.value === "en" ? "Open menu" : "メニューを開く"}
            onClick$={() => (mobileOpen.value = true)}
          >
            <Icon name="Menu" size={20} />
          </button>
          <button
            type="button"
            class="ml-2 flex size-10 items-center justify-center text-slate-500"
            aria-label={message(locale.value, "quickSwitcher")}
            onClick$={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
              )
            }
          >
            <Icon name="Search" size={18} />
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
