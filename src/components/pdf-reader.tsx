import {
  $,
  component$,
  noSerialize,
  useOnDocument,
  useOnWindow,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import type { QRL } from "@builder.io/qwik";
import { Icon } from "~/components/icon";
import type { Annotation } from "~/lib/domain";
import { loadPdf } from "~/lib/pdf";
import { getPaper, getPaperFile } from "~/lib/storage";
import { localize, useLocale } from "~/lib/i18n";

export type AnnotationDraft = Pick<Annotation, "type" | "quote" | "rect"> & {
  pageNumber: number;
};
export type TranslationDraft = { pageNumber: number; quote: string };
export type PdfFitMode = "page" | "width" | "height";
type Props = {
  documentId: string;
  page: number;
  zoom: number;
  viewMode: "continuous" | "single";
  active?: boolean;
  onPage$: QRL<(page: number) => void>;
  onZoom$?: QRL<(zoom: number) => void>;
  onAnnotate$?: QRL<(draft: AnnotationDraft) => void>;
  onTranslate$?: QRL<(draft: TranslationDraft) => void>;
  onPages$?: QRL<(pages: number) => void>;
  annotations?: Annotation[];
  minimal?: boolean;
  showThumbnails?: boolean;
  fitMode?: PdfFitMode;
  fitVersion?: number;
};

const clampPage = (value: number, total: number) =>
  Math.max(1, Math.min(total || value, value));

export const PdfReader = component$<Props>(
  ({
    documentId,
    page,
    zoom,
    viewMode,
    active = true,
    onPage$,
    onZoom$,
    onAnnotate$,
    onTranslate$,
    onPages$,
    annotations = [],
    minimal = false,
    showThumbnails = false,
    fitMode,
    fitVersion = 0,
  }) => {
    const locale = useLocale();
    const singlePageHost = useSignal<HTMLElement>();
    const container = useSignal<HTMLElement>();
    const scrollArea = useSignal<HTMLElement>();
    const thumbnailRail = useSignal<HTMLElement>();
    const pdf = useSignal<any>();
    const textByPage = useSignal<Record<number, string>>({});
    const pages = useSignal(0);
    const loading = useSignal(true);
    const error = useSignal("");
    const search = useSignal("");
    const searchInput = useSignal<HTMLInputElement>();
    const searchMatches = useSignal<number[]>([]);
    const searchMatchIndex = useSignal(-1);
    const searchError = useSignal("");
    const pageError = useSignal("");
    const localZoom = useSignal(zoom);
    const selectedText = useSignal("");
    const selectedRect = useSignal<AnnotationDraft["rect"]>();
    const selectedPage = useSignal(page);
    const fullscreen = useSignal(false);
    const pageFromScroll = useSignal<number>();
    const renderTasks =
      useSignal<
        WeakMap<HTMLElement, { cancel: () => void; promise: Promise<void> }>
      >();

    const renderPage = $(
      async (pageNumber: number, target: HTMLElement, scale?: number) => {
        if (!pdf.value) return;
        // Qwik serializes `$()` functions for lazy execution. Values referenced
        // only from a default parameter are not captured, so resolving the
        // reader zoom inside the function keeps the central-page render on the
        // same 100%-based scale as the toolbar. Thumbnails still pass 0.16.
        const renderScale = scale ?? localZoom.value;
        const renderKey = `${pageNumber}:${renderScale}`;
        if (
          target.dataset.renderKey === renderKey &&
          (target.dataset.rendered === "true" || renderTasks.value?.has(target))
        )
          return;
        const renderToken = crypto.randomUUID();
        target.dataset.renderToken = renderToken;
        target.dataset.renderKey = renderKey;
        const pdfPage = await pdf.value.getPage(pageNumber);
        if (target.dataset.renderToken !== renderToken) return;
        const viewport = pdfPage.getViewport({ scale: renderScale });
        const previousTask = renderTasks.value?.get(target);
        if (previousTask) {
          previousTask.cancel();
          try {
            await previousTask.promise;
          } catch {
            // Cancellation must settle before pdf.js can reuse the canvas.
          }
        }
        if (target.dataset.renderToken !== renderToken) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const renderedCanvas = document.createElement("canvas");
        renderedCanvas.width = Math.ceil(viewport.width * ratio);
        renderedCanvas.height = Math.ceil(viewport.height * ratio);
        renderedCanvas.style.width = `${viewport.width}px`;
        renderedCanvas.style.height = "auto";
        renderedCanvas.style.maxWidth = "100%";
        renderedCanvas.style.display = "block";
        renderedCanvas.setAttribute(
          "aria-label",
          `${localize(locale.value, "PDF", "PDF")} ${pageNumber} ${localize(locale.value, "ページ", "page")}`,
        );
        target.style.width = `${viewport.width}px`;
        target.style.height = "auto";
        target.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
        target.replaceChildren(renderedCanvas);
        const renderTask = pdfPage.render({
          canvas: renderedCanvas,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        }) as { cancel: () => void; promise: Promise<void> };
        renderTasks.value?.set(target, renderTask);
        try {
          await renderTask.promise;
        } catch (renderError) {
          if (
            typeof renderError === "object" &&
            renderError !== null &&
            "name" in renderError &&
            renderError.name === "RenderingCancelledException"
          )
            return;
          error.value = localize(
            locale.value,
            `${pageNumber}ページを描画できませんでした`,
            `Could not render page ${pageNumber}`,
          );
          return;
        } finally {
          if (renderTasks.value?.get(target) === renderTask)
            renderTasks.value.delete(target);
        }
        if (target.dataset.renderToken !== renderToken) return;
        if (target.dataset.pdfPageHost !== undefined) {
          const textLayerContainer = document.createElement("div");
          textLayerContainer.dataset.pdfTextLayer = String(pageNumber);
          textLayerContainer.setAttribute("aria-hidden", "true");
          target.appendChild(textLayerContainer);
          const { TextLayer } = (await import(
            "pdfjs-dist/build/pdf.mjs"
          )) as unknown as {
            TextLayer: new (options: {
              textContentSource: unknown;
              container: HTMLElement;
              viewport: unknown;
            }) => { render: () => Promise<void> };
          };
          if (target.dataset.renderToken !== renderToken) return;
          const textLayer = new TextLayer({
            textContentSource: await pdfPage.getTextContent(),
            container: textLayerContainer,
            viewport,
          });
          await textLayer.render();
        }
        if (target.dataset.renderToken !== renderToken) return;
        target.dataset.rendered = "true";
      },
    );
    const releaseCanvas = $((target: HTMLElement) => {
      const releaseToken = crypto.randomUUID();
      target.dataset.renderToken = releaseToken;
      const task = renderTasks.value?.get(target);
      task?.cancel();
      void (task?.promise || Promise.resolve())
        .catch(() => undefined)
        .finally(() => {
          if (target.dataset.renderToken !== releaseToken) return;
          renderTasks.value?.delete(target);
          target.replaceChildren();
          delete target.dataset.rendered;
          delete target.dataset.renderKey;
        });
    });

    useVisibleTask$(async () => {
      renderTasks.value = noSerialize(new WeakMap());
      try {
        const file = await getPaperFile(documentId);
        if (!file) throw new Error("PDF本体が見つかりません。");
        textByPage.value = file.textByPage || {};
        pdf.value = noSerialize(await loadPdf(file.file));
        pages.value = pdf.value.numPages;
        void onPages$?.(pages.value);
      } catch (e) {
        error.value =
          e instanceof Error ? e.message : "PDFを表示できませんでした";
      } finally {
        loading.value = false;
      }
    });

    useVisibleTask$(({ track }) => {
      const nextZoom = track(() => zoom);
      if (nextZoom !== localZoom.value) localZoom.value = nextZoom;
    });

    // Render only the viewport and nearby pages. Canvases that are far outside
    // the viewport release their backing bitmap to keep large PDFs bounded.
    useVisibleTask$(({ track, cleanup }) => {
      track(() => pages.value);
      track(() => page);
      track(() => viewMode);
      track(() => localZoom.value);
      track(() => active);
      if (!active || !pdf.value || !pages.value) return;
      const thumbnailObserver = thumbnailRail.value
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const target = entry.target as HTMLElement;
                if (entry.isIntersecting)
                  void renderPage(Number(target.dataset.page), target, 0.16);
                else void releaseCanvas(target);
              }
            },
            { root: thumbnailRail.value, rootMargin: "320px 0px" },
          )
        : undefined;
      thumbnailRail.value
        ?.querySelectorAll<HTMLElement>("[data-pdf-thumbnail]")
        .forEach((item) => thumbnailObserver?.observe(item));
      if (viewMode === "single") {
        const initialRenderFrame = requestAnimationFrame(() => {
          if (singlePageHost.value)
            void renderPage(clampPage(page, pages.value), singlePageHost.value);
        });
        cleanup(() => {
          cancelAnimationFrame(initialRenderFrame);
          thumbnailObserver?.disconnect();
        });
        return;
      }
      const viewport = scrollArea.value;
      if (!viewport) return;
      const observer = new IntersectionObserver(
        (entries) => {
          let visiblePage: number | undefined;
          let visibleRatio = 0.35;
          for (const entry of entries) {
            const target = entry.target as HTMLElement;
            const pageNumber = Number(target.dataset.page);
            if (entry.isIntersecting) {
              void renderPage(pageNumber, target);
              if (entry.intersectionRatio > visibleRatio) {
                visibleRatio = entry.intersectionRatio;
                visiblePage = pageNumber;
              }
            } else {
              const bounds = entry.boundingClientRect;
              if (
                bounds.bottom < -900 ||
                bounds.top > viewport.clientHeight + 900
              )
                void releaseCanvas(target);
            }
          }
          if (visiblePage && visiblePage !== page) {
            pageFromScroll.value = visiblePage;
            void onPage$(visiblePage);
          }
        },
        { root: viewport, rootMargin: "900px 0px", threshold: [0, 0.35] },
      );
      viewport
        .querySelectorAll<HTMLElement>("[data-pdf-page-host]")
        .forEach((item) => observer.observe(item));
      const initialRenderFrame = requestAnimationFrame(() => {
        const currentPageHost = viewport.querySelector<HTMLElement>(
          `[data-pdf-page-host][data-page="${clampPage(page, pages.value)}"]`,
        );
        if (currentPageHost)
          void renderPage(clampPage(page, pages.value), currentPageHost);
      });
      cleanup(() => {
        cancelAnimationFrame(initialRenderFrame);
        observer.disconnect();
        thumbnailObserver?.disconnect();
      });
    });

    useVisibleTask$(({ track }) => {
      track(() => page);
      track(() => viewMode);
      track(() => active);
      if (!active || viewMode !== "continuous") return;
      if (pageFromScroll.value === page) {
        pageFromScroll.value = undefined;
        return;
      }
      const viewport = scrollArea.value;
      const pageShell = viewport?.querySelector<HTMLElement>(
        `[data-pdf-page-shell="${page}"]`,
      );
      if (viewport && pageShell)
        viewport.scrollTo({ top: Math.max(0, pageShell.offsetTop - 16) });
    });

    const toggleFullscreen = $(async () => {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await container.value?.requestFullscreen();
    });
    useOnDocument(
      "fullscreenchange",
      $(() => {
        fullscreen.value = document.fullscreenElement === container.value;
      }),
    );

    useOnWindow(
      "keydown",
      $((event) => {
        if (!active) return;
        const target = event.target as HTMLElement | null;
        const editing =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable;
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          searchInput.value?.focus();
          return;
        }
        if (editing) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          void onPage$(Math.max(1, page - 1));
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          void onPage$(Math.min(pages.value || page + 1, page + 1));
        }
        if (event.key === "+" || event.key === "=")
          void zoomTo(localZoom.value + 0.1);
        if (event.key === "-") void zoomTo(localZoom.value - 0.1);
        if (!minimal && event.key.toLowerCase() === "f")
          void toggleFullscreen();
      }),
    );

    const runSearch = $(() => {
      const needle = search.value.trim().toLowerCase();
      if (!needle) {
        searchMatches.value = [];
        searchMatchIndex.value = -1;
        searchError.value = localize(
          locale.value,
          "検索語を入力してください",
          "Enter a search term",
        );
        return;
      }
      const matches = Object.entries(textByPage.value)
        .filter(([, text]) => text.toLowerCase().includes(needle))
        .map(([pageNumber]) => Number(pageNumber))
        .sort((a, b) => a - b);
      searchMatches.value = matches;
      searchMatchIndex.value = matches.length ? 0 : -1;
      searchError.value = matches.length
        ? ""
        : localize(locale.value, "一致なし", "No matches");
      if (matches[0]) void onPage$(matches[0]);
    });
    const moveSearch = $((offset: number) => {
      if (!searchMatches.value.length) return;
      const next =
        (searchMatchIndex.value + offset + searchMatches.value.length) %
        searchMatches.value.length;
      searchMatchIndex.value = next;
      void onPage$(searchMatches.value[next]);
    });
    const updatePageNumber = $((raw: string) => {
      const value = Number(raw);
      if (
        !raw.trim() ||
        !Number.isInteger(value) ||
        value < 1 ||
        (pages.value && value > pages.value)
      ) {
        pageError.value = localize(
          locale.value,
          `1〜${pages.value || 1}のページ番号を入力してください`,
          `Enter a page from 1 to ${pages.value || 1}`,
        );
        return;
      }
      pageError.value = "";
      void onPage$(value);
    });
    const zoomTo = $((value: number) => {
      const next = Math.max(0.5, Math.min(3, value));
      localZoom.value = next;
      return onZoom$?.(next);
    });
    const fit = $((mode: PdfFitMode) => {
      void pdf.value?.getPage(page).then(
        (pdfPage: {
          getViewport: (options: { scale: number }) => {
            width: number;
            height: number;
          };
        }) => {
          const scrollElement = scrollArea.value;
          const styles = scrollElement
            ? getComputedStyle(scrollElement)
            : undefined;
          const horizontalPadding = styles
            ? Number.parseFloat(styles.paddingLeft) +
              Number.parseFloat(styles.paddingRight)
            : 0;
          const verticalPadding = styles
            ? Number.parseFloat(styles.paddingTop) +
              Number.parseFloat(styles.paddingBottom)
            : 0;
          const viewportWidth = Math.max(
            1,
            (scrollElement?.clientWidth || 800) - horizontalPadding,
          );
          const viewportHeight = Math.max(
            1,
            (scrollElement?.clientHeight || 800) - verticalPadding,
          );
          const base = pdfPage.getViewport({ scale: 1 });
          const widthScale = viewportWidth / base.width;
          const heightScale = viewportHeight / base.height;
          const next =
            mode === "width"
              ? widthScale
              : mode === "height"
                ? heightScale
                : Math.min(widthScale, heightScale);
          void zoomTo(next);
        },
      );
    });
    useVisibleTask$(({ track, cleanup }) => {
      const requestedVersion = track(() => fitVersion);
      const requestedMode = track(() => fitMode);
      if (
        !requestedVersion ||
        !requestedMode ||
        !active ||
        !pdf.value ||
        !pages.value
      )
        return;
      const frame = requestAnimationFrame(() => void fit(requestedMode));
      cleanup(() => cancelAnimationFrame(frame));
    });
    const download = $(() => {
      void Promise.all([getPaper(documentId), getPaperFile(documentId)]).then(
        ([paper, file]) => {
          if (!file) return;
          const url = URL.createObjectURL(file.file);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download =
            paper?.fileName ||
            (file.file instanceof File ? file.file.name : `${documentId}.pdf`);
          anchor.click();
          URL.revokeObjectURL(url);
        },
      );
    });
    const captureSelection = $(() => {
      const selection = window.getSelection();
      const quote = selection?.toString().trim() || "";
      selectedText.value = quote.slice(0, 4_000);
      const range = selection?.rangeCount
        ? selection.getRangeAt(0).getBoundingClientRect()
        : undefined;
      const textLayer = selection?.anchorNode?.parentElement?.closest(
        "[data-pdf-text-layer]",
      ) as HTMLElement | null;
      const pageShell = (selection?.anchorNode?.parentElement?.closest(
        "[data-pdf-page-shell]",
      ) || textLayer?.parentElement) as HTMLElement | null;
      selectedPage.value = Number(pageShell?.dataset.pdfPageShell) || page;
      const bounds = pageShell
        ?.querySelector<HTMLCanvasElement>("canvas")
        ?.getBoundingClientRect();
      selectedRect.value =
        range && bounds && bounds.width > 0 && bounds.height > 0
          ? {
              x: Math.max(0, (range.left - bounds.left) / bounds.width),
              y: Math.max(0, (range.top - bounds.top) / bounds.height),
              width: Math.min(1, range.width / bounds.width),
              height: Math.min(1, range.height / bounds.height),
            }
          : undefined;
    });
    const annotateSelection = $((type: Annotation["type"]) => {
      if (!selectedText.value) return;
      void onAnnotate$?.({
        type,
        pageNumber: selectedPage.value,
        quote: selectedText.value,
        rect: selectedRect.value,
      });
      selectedText.value = "";
      selectedRect.value = undefined;
      window.getSelection()?.removeAllRanges();
    });
    const translateSelection = $(() => {
      if (!selectedText.value) return;
      void onTranslate$?.({
        pageNumber: selectedPage.value,
        quote: selectedText.value,
      });
      selectedText.value = "";
      selectedRect.value = undefined;
      window.getSelection()?.removeAllRanges();
    });
    const translatePage = $(() => {
      const text = textByPage.value[page]?.trim();
      if (text) void onTranslate$?.({ pageNumber: page, quote: text });
    });
    const thumbnailPages = () =>
      Array.from({ length: pages.value }, (_, index) => index + 1);

    const pageAnnotations = (pageNumber: number) =>
      annotations.filter((item) => item.pageNumber === pageNumber && item.rect);
    return (
      <section
        ref={container}
        class={
          minimal
            ? "pdf-reader flex h-full min-h-0 min-w-0 flex-col bg-[#525659]"
            : "pdf-reader flex h-[calc(100vh-13rem)] min-h-[32rem] min-w-0 flex-col border border-slate-200 bg-slate-100"
        }
      >
        {!minimal && (
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 text-sm">
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="button subtle"
                disabled={page <= 1}
                aria-label={localize(
                  locale.value,
                  "前のページ",
                  "Previous page",
                )}
                onClick$={() => onPage$(Math.max(1, page - 1))}
              >
                <Icon name="ChevronLeft" size={18} />
              </button>
              <input
                class="w-16 py-1 text-center"
                type="number"
                min={1}
                max={pages.value || undefined}
                aria-label={localize(locale.value, "ページ番号", "Page number")}
                value={page}
                aria-invalid={pageError.value ? "true" : undefined}
                onChange$={(_, el) => updatePageNumber(el.value)}
              />
              <span>/ {pages.value || "—"}</span>
              {pageError.value && (
                <span role="alert" class="text-xs text-red-700">
                  {pageError.value}
                </span>
              )}
              <button
                type="button"
                class="button subtle"
                disabled={!pages.value || page >= pages.value}
                aria-label={localize(locale.value, "次のページ", "Next page")}
                onClick$={() =>
                  onPage$(Math.min(pages.value || page + 1, page + 1))
                }
              >
                <Icon name="ChevronRight" size={18} />
              </button>
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="button subtle"
                aria-label={localize(locale.value, "縮小", "Zoom out")}
                onClick$={() => zoomTo(localZoom.value - 0.1)}
              >
                <Icon name="ZoomOut" size={16} />
              </button>
              <span class="w-12 text-center text-xs tabular-nums">
                {Math.round(localZoom.value * 100)}%
              </span>
              <button
                type="button"
                class="button subtle"
                aria-label={localize(locale.value, "拡大", "Zoom in")}
                onClick$={() => zoomTo(localZoom.value + 0.1)}
              >
                <Icon name="ZoomIn" size={16} />
              </button>
              <button
                type="button"
                class="button subtle"
                onClick$={() => fit("width")}
              >
                {localize(locale.value, "幅に合わせる", "Fit width")}
              </button>
              <button
                type="button"
                class="button subtle"
                onClick$={() => fit("height")}
              >
                {localize(locale.value, "高さに合わせる", "Fit height")}
              </button>
              <button
                type="button"
                class="button subtle"
                aria-label={localize(
                  locale.value,
                  "PDFをダウンロード",
                  "Download PDF",
                )}
                onClick$={download}
              >
                <Icon name="FileDown" size={16} />
              </button>
              <button
                type="button"
                class="button subtle"
                aria-label={localize(
                  locale.value,
                  fullscreen.value ? "全画面を終了" : "全画面",
                  fullscreen.value ? "Exit fullscreen" : "Fullscreen",
                )}
                onClick$={toggleFullscreen}
              >
                <Icon
                  name={fullscreen.value ? "Minimize2" : "Maximize2"}
                  size={16}
                />
              </button>
            </div>
          </div>
        )}
        <div
          class={`grid min-h-0 flex-1 ${showThumbnails ? "grid-cols-[8.5rem_minmax(0,1fr)]" : "grid-cols-1"}`}
        >
          <aside
            ref={thumbnailRail}
            class={`${showThumbnails ? "block" : "hidden"} overflow-auto border-r border-black/30 bg-[#3f4245] p-2`}
          >
            <p class="px-2 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-white/60">
              {localize(locale.value, "ページ", "Pages")}
            </p>
            <div class="space-y-2">
              {thumbnailPages().map((number) => (
                <button
                  type="button"
                  key={number}
                  class={
                    number === page
                      ? "w-full border-2 border-sky-400 bg-white/10 p-1"
                      : "w-full border border-transparent bg-transparent p-1 hover:border-white/40"
                  }
                  onClick$={() => onPage$(number)}
                >
                  <div class="flex aspect-[3/4] items-center justify-center overflow-hidden bg-white shadow-sm">
                    <div
                      data-pdf-thumbnail
                      data-page={number}
                      class="flex max-h-full max-w-full items-center justify-center overflow-hidden"
                      aria-label={`${localize(locale.value, "PDF", "PDF")} ${number} ${localize(locale.value, "ページのサムネイル", "page thumbnail")}`}
                    />
                  </div>
                  <span class="mt-1 block text-[10px] text-white/70">
                    {number}
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <div class="flex min-w-0 flex-col">
            {!minimal && (
              <div class="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                <label class="relative min-w-48 flex-1">
                  <span class="sr-only">
                    {localize(locale.value, "PDF内検索", "Search PDF")}
                  </span>
                  <Icon
                    name="Search"
                    size={15}
                    class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    ref={searchInput}
                    class="pdf-search-input w-full py-1 pl-8 text-xs"
                    placeholder={localize(
                      locale.value,
                      "PDF内検索",
                      "Search PDF",
                    )}
                    value={search.value}
                    aria-invalid={searchError.value ? "true" : undefined}
                    onInput$={(_, el) => {
                      search.value = el.value;
                      searchError.value = "";
                      searchMatches.value = [];
                      searchMatchIndex.value = -1;
                    }}
                    onKeyDown$={(event) => {
                      if (event.key === "Enter") void runSearch();
                    }}
                  />
                </label>
                <button
                  type="button"
                  class="button subtle py-1 text-xs"
                  onClick$={runSearch}
                >
                  {localize(locale.value, "検索", "Search")}
                </button>
                {searchMatches.value.length > 0 && (
                  <div class="flex items-center gap-1 text-xs text-slate-600">
                    <button
                      type="button"
                      class="button subtle py-1"
                      aria-label={localize(
                        locale.value,
                        "前の検索結果",
                        "Previous match",
                      )}
                      onClick$={() => moveSearch(-1)}
                    >
                      <Icon name="ChevronLeft" size={15} />
                    </button>
                    <span class="tabular-nums">
                      {searchMatchIndex.value + 1}/{searchMatches.value.length}
                    </span>
                    <button
                      type="button"
                      class="button subtle py-1"
                      aria-label={localize(
                        locale.value,
                        "次の検索結果",
                        "Next match",
                      )}
                      onClick$={() => moveSearch(1)}
                    >
                      <Icon name="ChevronRight" size={15} />
                    </button>
                  </div>
                )}
                {searchError.value && (
                  <span role="alert" class="text-xs text-red-700">
                    {searchError.value}
                  </span>
                )}
                <button
                  type="button"
                  class="button subtle py-1 text-xs"
                  disabled={!textByPage.value[page]?.trim()}
                  onClick$={translatePage}
                >
                  {localize(locale.value, "このページを翻訳", "Translate page")}
                </button>
              </div>
            )}
            <div
              ref={scrollArea}
              class={
                minimal
                  ? "flex-1 overflow-auto p-4 md:p-6"
                  : "flex-1 overflow-auto p-4 sm:p-8"
              }
            >
              {loading.value ? (
                <div class="flex h-96 w-full items-center justify-center bg-white text-sm text-slate-500">
                  {localize(
                    locale.value,
                    "PDFを読み込んでいます…",
                    "Loading PDF…",
                  )}
                </div>
              ) : error.value ? (
                <p role="alert" class="bg-white p-8 text-sm text-red-700">
                  {error.value}
                </p>
              ) : viewMode === "single" ? (
                <div class="mx-auto w-fit" data-pdf-page-shell={page}>
                  <div
                    class="relative max-w-full bg-white shadow-xl"
                    onMouseUp$={captureSelection}
                  >
                    <div
                      ref={singlePageHost}
                      data-pdf-page-host
                      data-page={page}
                      class="relative max-w-full overflow-hidden"
                    />
                    {pageAnnotations(page).map((item) => (
                      <span
                        key={item.id}
                        title={
                          item.content ||
                          item.quote ||
                          localize(locale.value, "注釈", "Annotation")
                        }
                        class={`pointer-events-none absolute border-2 ${item.type === "underline" ? "border-b-2 border-x-0 border-t-0 border-sky-500" : "border-sky-400 bg-sky-300/25"}`}
                        style={{
                          left: `${(item.rect?.x || 0) * 100}%`,
                          top: `${(item.rect?.y || 0) * 100}%`,
                          width: `${(item.rect?.width || 0) * 100}%`,
                          height: `${(item.rect?.height || 0) * 100}%`,
                        }}
                        aria-label={localize(
                          locale.value,
                          "保存した注釈",
                          "Saved annotation",
                        )}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div class="mx-auto flex w-full flex-col items-center gap-6">
                  {Array.from(
                    { length: pages.value },
                    (_, index) => index + 1,
                  ).map((number) => (
                    <article
                      key={number}
                      data-pdf-page-shell={number}
                      class="relative w-fit max-w-full bg-white shadow-xl"
                      onMouseUp$={captureSelection}
                    >
                      <div
                        data-pdf-page-host
                        data-page={number}
                        class="relative max-w-full overflow-hidden"
                        aria-label={`${localize(locale.value, "PDF", "PDF")} ${number} ${localize(locale.value, "ページ", "page")}`}
                      />
                      {pageAnnotations(number).map((item) => (
                        <span
                          key={item.id}
                          title={
                            item.content ||
                            item.quote ||
                            localize(locale.value, "注釈", "Annotation")
                          }
                          class={`pointer-events-none absolute border-2 ${item.type === "underline" ? "border-b-2 border-x-0 border-t-0 border-sky-500" : "border-sky-400 bg-sky-300/25"}`}
                          style={{
                            left: `${(item.rect?.x || 0) * 100}%`,
                            top: `${(item.rect?.y || 0) * 100}%`,
                            width: `${(item.rect?.width || 0) * 100}%`,
                            height: `${(item.rect?.height || 0) * 100}%`,
                          }}
                          aria-label={localize(
                            locale.value,
                            "保存した注釈",
                            "Saved annotation",
                          )}
                        />
                      ))}
                    </article>
                  ))}
                </div>
              )}
              {selectedText.value && (
                <div class="sticky bottom-3 mx-auto mt-3 flex max-w-3xl flex-wrap items-center gap-2 border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                  <span class="mr-auto max-w-full truncate">
                    {localize(locale.value, "選択: ", "Selected: ")}
                    {selectedText.value}
                  </span>
                  <button
                    type="button"
                    class="button py-1 text-xs"
                    onClick$={translateSelection}
                  >
                    {localize(locale.value, "翻訳", "Translate")}
                  </button>
                  <button
                    type="button"
                    class="button py-1 text-xs"
                    onClick$={() => annotateSelection("highlight")}
                  >
                    {localize(locale.value, "ハイライト", "Highlight")}
                  </button>
                  <button
                    type="button"
                    class="button py-1 text-xs"
                    onClick$={() => annotateSelection("underline")}
                  >
                    {localize(locale.value, "下線", "Underline")}
                  </button>
                  <button
                    type="button"
                    class="button py-1 text-xs"
                    onClick$={() => annotateSelection("comment")}
                  >
                    {localize(locale.value, "コメント", "Comment")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {!minimal && fullscreen.value && (
          <button
            type="button"
            class="button fixed right-3 top-3 z-50 bg-white shadow-lg"
            aria-label={localize(
              locale.value,
              "全画面を終了",
              "Exit fullscreen",
            )}
            onClick$={toggleFullscreen}
          >
            <Icon name="Minimize2" size={18} />
          </button>
        )}
      </section>
    );
  },
);
