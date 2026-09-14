import { component$, $, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { Link, type DocumentHead, useLocation } from "@builder.io/qwik-city";
import { AppShell } from "~/components/app-shell";
import { Icon } from "~/components/icon";
import type { PaperDocument } from "~/lib/domain";
import {
  getPaperFile,
  listAnnotations,
  listPapers,
  listTranslations,
  savePaper,
} from "~/lib/storage";
import {
  buildSearchIndex,
  type SearchDocument,
  type SearchIndexEntry,
} from "~/lib/search";
import { message, useLocale } from "~/lib/i18n";

const formatDate = (date: string | undefined, locale: "ja" | "en") =>
  date
    ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ja-JP", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(new Date(date))
    : "—";
const pageLabel = (page: number, locale: "ja" | "en") =>
  page > 0
    ? locale === "en"
      ? `Page ${page}`
      : `${page}ページ`
    : locale === "en"
      ? "Whole paper"
      : "論文全体";

export default component$(() => {
  const locale = useLocale();
  const statusLabels = {
    unread: message(locale.value, "unread"),
    reading: message(locale.value, "reading"),
    read: message(locale.value, "completed"),
  } as const;
  const location = useLocation();
  const papers = useSignal<PaperDocument[]>([]);
  const query = useSignal("");
  const status = useSignal<PaperDocument["readingStatus"] | "">(
    (location.url.searchParams.get(
      "status",
    ) as PaperDocument["readingStatus"]) || "",
  );
  const favoriteOnly = useSignal(
    location.url.searchParams.get("favorite") === "true",
  );
  const sort = useSignal<"recent" | "updated" | "rating" | "title">("recent");
  const selectedTag = useSignal("");
  const rating = useSignal<"" | "1" | "2" | "3" | "4" | "5">("");
  const dateFilter = useSignal<"" | "7" | "30" | "365">("");
  const loading = useSignal(true);
  const error = useSignal("");
  const searchIndex = useSignal<SearchIndexEntry[]>([]);

  const reload = $(async () => {
    try {
      papers.value = await listPapers();
    } catch (e) {
      error.value =
        e instanceof Error
          ? e.message
          : "ローカルライブラリを読み込めませんでした";
    } finally {
      loading.value = false;
    }
  });
  useVisibleTask$(async () => {
    await reload();
    const indexed = await Promise.all(
      papers.value.map(async (paper) => {
        const [file, annotations, translations] = await Promise.all([
          getPaperFile(paper.id),
          listAnnotations(paper.id),
          listTranslations(paper.id),
        ]);
        const entries: SearchDocument["entries"] = Object.entries(
          file?.textByPage || {},
        ).map(([pageNumber, text]) => ({
          pageNumber: Number(pageNumber),
          text,
          kind: "pdf",
        }));
        for (const annotation of annotations) {
          const noteText = [annotation.quote, annotation.content]
            .filter(Boolean)
            .join(" ");
          if (noteText)
            entries.push({
              pageNumber: annotation.pageNumber,
              text: noteText,
              kind: "note",
            });
        }
        for (const translation of translations) {
          if (translation.segments?.length)
            for (const segment of translation.segments)
              entries.push({
                pageNumber: segment.pageNumber,
                text: segment.translatedText,
                kind: "translation",
              });
          else if (translation.markdown)
            entries.push({
              pageNumber: 0,
              text: translation.markdown,
              kind: "translation",
            });
        }
        return { documentId: paper.id, entries };
      }),
    );
    searchIndex.value = await buildSearchIndex(indexed);
  });
  const updatePaper = $(
    async (paper: PaperDocument, patch: Partial<PaperDocument>) => {
      const updated = {
        ...paper,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      papers.value = papers.value.map((item) =>
        item.id === paper.id ? updated : item,
      );
      await savePaper(updated);
    },
  );
  const visiblePapers = papers.value
    .filter((paper) => {
      const needle = query.value.trim().toLowerCase();
      const paperText = searchIndex.value
        .filter((entry) => entry.documentId === paper.id)
        .map((entry) => entry.text)
        .join(" ");
      const haystack = [
        paper.title,
        ...paper.authors,
        paper.abstract || "",
        ...paper.tags,
        paperText,
      ]
        .join(" ")
        .toLowerCase();
      const minimumRating = rating.value ? Number(rating.value) : 0;
      const cutoff = dateFilter.value
        ? Date.now() - Number(dateFilter.value) * 24 * 60 * 60 * 1000
        : 0;
      return (
        (!needle || haystack.includes(needle)) &&
        (!status.value || paper.readingStatus === status.value) &&
        (!favoriteOnly.value || paper.favorite) &&
        (!selectedTag.value || paper.tags.includes(selectedTag.value)) &&
        (!minimumRating || paper.rating >= minimumRating) &&
        (!cutoff || new Date(paper.updatedAt).getTime() >= cutoff)
      );
    })
    .sort((a, b) =>
      sort.value === "title"
        ? a.title.localeCompare(b.title, "ja")
        : sort.value === "rating"
          ? b.rating - a.rating
          : sort.value === "recent"
            ? (b.lastOpenedAt || b.updatedAt || "").localeCompare(
                a.lastOpenedAt || a.updatedAt || "",
              )
            : (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
  const tags = [...new Set(papers.value.flatMap((paper) => paper.tags))].sort();
  const hasFilters = Boolean(
    query.value.trim() ||
      status.value ||
      favoriteOnly.value ||
      selectedTag.value ||
      rating.value ||
      dateFilter.value,
  );
  const clearFilters = $(() => {
    query.value = "";
    status.value = "";
    favoriteOnly.value = false;
    selectedTag.value = "";
    rating.value = "";
    dateFilter.value = "";
  });
  const exportMetadata = $(async () => {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      papers: papers.value,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `paperlens-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  return (
    <AppShell>
      <section class="app-page space-y-8">
        <div class="page-heading">
          <div>
            <h1 class="text-3xl font-bold tracking-[-0.04em] sm:text-4xl">
              {message(locale.value, "libraryTitle")}
            </h1>
          </div>
          <Link href="/upload/" class="button primary">
            <Icon name="Plus" size={18} />
            {message(locale.value, "addPaper")}
          </Link>
        </div>
        <div class="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-4">
          {[
            [papers.value.length, message(locale.value, "registered")],
            [
              papers.value.filter((p) => p.readingStatus === "reading").length,
              message(locale.value, "readingCount"),
            ],
            [
              papers.value.filter((p) => p.favorite).length,
              message(locale.value, "favoriteCount"),
            ],
            [
              papers.value.filter((p) => p.readingStatus === "read").length,
              message(locale.value, "completed"),
            ],
          ].map(([value, label]) => (
            <div key={label as string} class="bg-white p-5">
              <p class="text-2xl font-bold">{value}</p>
              <p class="mt-1 text-sm text-slate-500">{label}</p>
            </div>
          ))}
        </div>
        <div class="border-b border-slate-200 pb-4">
          <label class="relative block w-full lg:max-w-xl">
            <span class="sr-only">
              {message(locale.value, "searchLibrary")}
            </span>
            <Icon
              name="Search"
              size={18}
              class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              class="library-search-input h-11 w-full pl-10 pr-16 text-sm"
              placeholder={message(locale.value, "searchLibrary")}
              value={query.value}
              onInput$={(_, target) => (query.value = target.value)}
              onKeyDown$={(event) => {
                if (event.key === "Escape") query.value = "";
              }}
            />
            <span
              class="absolute right-3 top-1/2 -translate-y-1/2 border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400"
              aria-hidden="true"
            >
              Esc
            </span>
          </label>
          <div class="mt-3 flex gap-2 overflow-x-auto pb-1 lg:items-center">
            <select
              aria-label={message(locale.value, "allStatuses")}
              class="h-11 min-w-36 shrink-0"
              value={status.value}
              onChange$={(_, el) =>
                (status.value = el.value as typeof status.value)
              }
            >
              <option value="">{message(locale.value, "allStatuses")}</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label={message(locale.value, "allTags")}
              class="h-11 min-w-32 shrink-0"
              value={selectedTag.value}
              onChange$={(_, el) => (selectedTag.value = el.value)}
            >
              <option value="">{message(locale.value, "allTags")}</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>{`#${tag}`}</option>
              ))}
            </select>
            <select
              aria-label={message(locale.value, "allRatings")}
              class="h-11 min-w-32 shrink-0"
              value={rating.value}
              onChange$={(_, el) =>
                (rating.value = el.value as typeof rating.value)
              }
            >
              <option value="">{message(locale.value, "allRatings")}</option>
              <option value="5">5 stars</option>
              <option value="4">4+ stars</option>
              <option value="3">3+ stars</option>
              <option value="2">2+ stars</option>
              <option value="1">1+ star</option>
            </select>
            <select
              aria-label={message(locale.value, "allDates")}
              class="h-11 min-w-32 shrink-0"
              value={dateFilter.value}
              onChange$={(_, el) =>
                (dateFilter.value = el.value as typeof dateFilter.value)
              }
            >
              <option value="">{message(locale.value, "allDates")}</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="365">Last year</option>
            </select>
            <button
              type="button"
              class={`button shrink-0 ${favoriteOnly.value ? "primary" : ""}`}
              onClick$={() => (favoriteOnly.value = !favoriteOnly.value)}
            >
              <Icon name="Heart" size={16} />
              {message(locale.value, "favoritesOnly")}
            </button>
            <select
              aria-label={locale.value === "en" ? "Sort" : "並び替え"}
              class="h-11 min-w-32 shrink-0 lg:ml-auto"
              value={sort.value}
              onChange$={(_, el) =>
                (sort.value = el.value as typeof sort.value)
              }
            >
              <option value="recent">{message(locale.value, "recent")}</option>
              <option value="updated">
                {message(locale.value, "updated")}
              </option>
              <option value="rating">
                {message(locale.value, "ratingOrder")}
              </option>
              <option value="title">
                {message(locale.value, "titleOrder")}
              </option>
            </select>
            {hasFilters && (
              <button
                type="button"
                class="button subtle shrink-0"
                onClick$={clearFilters}
              >
                {message(locale.value, "clearFilters")}
              </button>
            )}
          </div>
        </div>
        <div class="flex items-center justify-between gap-3 text-sm text-slate-500">
          <span aria-live="polite" role="status">
            {loading.value
              ? locale.value === "en"
                ? "Loading…"
                : "読み込み中…"
              : `${visiblePapers.length} ${locale.value === "en" ? "papers" : "件"}`}
          </span>
          <button
            type="button"
            class="button subtle shrink-0"
            onClick$={exportMetadata}
          >
            <Icon name="Download" size={16} />
            {locale.value === "en"
              ? "Back up metadata"
              : "メタデータをバックアップ"}
          </button>
        </div>
        {error.value && (
          <p
            role="alert"
            class="border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          >
            {error.value}
          </p>
        )}
        <div class="space-y-3">
          {visiblePapers.map((paper) => {
            const needle = query.value.trim().toLowerCase();
            const matches = needle
              ? searchIndex.value.filter(
                  (entry) =>
                    entry.documentId === paper.id &&
                    entry.text.toLowerCase().includes(needle),
                )
              : [];
            const firstMatch = matches[0];
            const excerpt = firstMatch
              ? firstMatch.text.slice(
                  Math.max(
                    0,
                    firstMatch.text.toLowerCase().indexOf(needle) - 45,
                  ),
                  Math.max(
                    0,
                    firstMatch.text.toLowerCase().indexOf(needle) - 45,
                  ) + 130,
                )
              : "";
            const locations = [
              ...new Set(
                matches.map((entry) =>
                  pageLabel(entry.pageNumber, locale.value),
                ),
              ),
            ];
            return (
              <article
                key={paper.id}
                class="group flex flex-col gap-4 border border-slate-200 bg-white p-5 hover:border-sky-300 sm:flex-row sm:items-center"
              >
                <Link
                  href={`/papers/${paper.id}/`}
                  class="flex min-w-0 flex-1 items-center gap-4"
                >
                  <div class="flex size-14 shrink-0 items-center justify-center bg-slate-100 text-slate-500 group-hover:bg-sky-100 group-hover:text-sky-700">
                    <Icon name="FileText" size={24} />
                  </div>
                  <div class="min-w-0">
                    <div class="mb-2 flex flex-wrap items-center gap-2">
                      <span class="border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
                        {statusLabels[paper.readingStatus]}
                      </span>
                      {paper.tags.map((tag) => (
                        <span
                          key={tag}
                          class="text-xs text-slate-400"
                        >{`#${tag}`}</span>
                      ))}
                    </div>
                    <h2 class="truncate text-base font-bold sm:text-lg">
                      {paper.title || paper.fileName}
                    </h2>
                    <p class="mt-1 truncate text-sm text-slate-500">
                      {paper.authors.length
                        ? paper.authors.join(", ")
                        : locale.value === "en"
                          ? "No author"
                          : "著者未登録"}
                      {paper.publicationYear
                        ? ` · ${paper.publicationYear}`
                        : ""}
                    </p>
                    {firstMatch && (
                      <p class="mt-2 line-clamp-2 text-xs text-slate-500">
                        <span class="font-semibold text-sky-700">
                          {locations.join(", ")}
                        </span>{" "}
                        · {excerpt}
                      </p>
                    )}
                  </div>
                </Link>
                <div class="flex shrink-0 items-center justify-between gap-5 sm:flex-col sm:items-end">
                  <div
                    class="flex items-center gap-1 text-sky-500"
                    aria-label={`${locale.value === "en" ? "Rating" : "評価"} ${paper.rating} / 5`}
                  >
                    {Array.from({ length: 5 }, (_, index) => (
                      <button
                        key={index}
                        type="button"
                        class="flex size-8 items-center justify-center"
                        aria-label={
                          locale.value === "en"
                            ? `${index + 1} stars`
                            : `${index + 1}つ星`
                        }
                        onClick$={() =>
                          updatePaper(paper, {
                            rating:
                              paper.rating === index + 1
                                ? 0
                                : ((index + 1) as PaperDocument["rating"]),
                          })
                        }
                      >
                        <Icon
                          name="Star"
                          size={14}
                          class={
                            index < paper.rating
                              ? "fill-current"
                              : "text-slate-200"
                          }
                        />
                      </button>
                    ))}
                  </div>
                  <div class="flex items-center gap-3">
                    <span class="text-xs text-slate-400">
                      {paper.lastOpenedAt
                        ? `${message(locale.value, "lastOpened")} · ${formatDate(paper.lastOpenedAt, locale.value)}${paper.reader ? ` · ${pageLabel(paper.reader.page, locale.value)}` : ""}`
                        : `${formatDate(paper.updatedAt, locale.value)} ${locale.value === "en" ? "updated" : "更新"}`}
                    </span>
                    <button
                      type="button"
                      aria-label={
                        locale.value === "en"
                          ? "Toggle favorite"
                          : "お気に入りを切り替え"
                      }
                      class={`flex size-8 items-center justify-center ${paper.favorite ? "text-sky-500" : "text-slate-300"}`}
                      onClick$={() =>
                        updatePaper(paper, { favorite: !paper.favorite })
                      }
                    >
                      <Icon
                        name="Heart"
                        size={17}
                        class={paper.favorite ? "fill-current" : ""}
                      />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {!loading.value && visiblePapers.length === 0 && (
            <div class="border border-dashed border-slate-300 px-6 py-20 text-center">
              <Icon name="FileText" size={28} class="mx-auto text-slate-300" />
              <p class="mt-4 font-semibold">
                {papers.value.length
                  ? locale.value === "en"
                    ? "No papers match these filters"
                    : "条件に一致する論文がありません"
                  : locale.value === "en"
                    ? "No papers yet"
                    : "まだ論文がありません"}
              </p>
              <p class="mt-2 text-sm text-slate-500">
                {papers.value.length
                  ? locale.value === "en"
                    ? "Try a different search or filter."
                    : "検索語や絞り込み条件を変えてください。"
                  : locale.value === "en"
                    ? "Add a PDF to start your research library."
                    : "PDFを追加して、あなたの研究ライブラリを始めましょう。"}
              </p>
              {!papers.value.length && (
                <Link href="/upload/" class="button primary mt-6">
                  <Icon name="Upload" size={16} />
                  {locale.value === "en" ? "Add PDF" : "PDFを追加"}
                </Link>
              )}
            </div>
          )}
        </div>
      </section>
    </AppShell>
  );
});
export const head: DocumentHead = {
  title: "ライブラリ | PaperLens",
  meta: [
    {
      name: "description",
      content: "PaperLensのローカルファースト論文ライブラリ",
    },
  ],
};
