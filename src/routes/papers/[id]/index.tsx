import {
  component$,
  $,
  noSerialize,
  useOnDocument,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, type DocumentHead, useLocation } from "@builder.io/qwik-city";
import { Icon } from "~/components/icon";
import {
  PdfReader,
  type AnnotationDraft,
  type PdfFitMode,
  type TranslationDraft,
} from "~/components/pdf-reader";
import {
  supportedLanguages,
  isSupportedLanguage,
  type Annotation,
  type PaperDocument,
  type PaperFile,
  type ProviderSettings,
  type Translation,
  type TranslationSegmentResult,
} from "~/lib/domain";
import {
  cancelManagedTranslation,
  estimateTranslation,
  streamManagedTranslation,
  type TranslationRequest,
} from "~/lib/api";
import { getSessionProvider, translateText } from "~/lib/llm";
import {
  getPaper,
  getPaperFile,
  getSetting,
  listAnnotations,
  listTranslations,
  saveAnnotation,
  savePaper,
  saveTranslation,
} from "~/lib/storage";
import { localize, useLocale } from "~/lib/i18n";

const defaultProvider: ProviderSettings = {
  mode: "local",
  model: "llama3.2",
  baseUrl: "http://127.0.0.1:11434/v1",
  targetLanguage: "ja",
  connected: false,
};
async function hashText(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const normalizeSourceText = (text: string) => text.replace(/\s+/g, " ").trim();
const MarkdownPreview = component$<{ value: string }>(({ value }) => (
  <div class="space-y-3 text-sm leading-7 text-slate-700">
    {value.trim() ? (
      value.split("\n").map((line, index) =>
        line.startsWith("# ") ? (
          <h3 key={index} class="text-lg font-bold text-slate-950">
            {line.slice(2)}
          </h3>
        ) : line.startsWith("## ") ? (
          <h4 key={index} class="font-bold text-slate-950">
            {line.slice(3)}
          </h4>
        ) : line.startsWith("- ") ? (
          <p key={index}>・{line.slice(2)}</p>
        ) : (
          <p key={index}>{line || " "}</p>
        ),
      )
    ) : (
      <p class="text-slate-400">翻訳文はまだありません。</p>
    )}
  </div>
));

export default component$(() => {
  const locale = useLocale();
  const t = (japanese: string, english: string) =>
    localize(locale.value, japanese, english);
  const location = useLocation();
  const id = location.params.id;
  const paper = useSignal<PaperDocument>();
  const file = useSignal<PaperFile>();
  const translations = useSignal<Translation[]>([]);
  const annotations = useSignal<Annotation[]>([]);
  const markdown = useSignal("");
  const editing = useSignal(false);
  const layout = useSignal<"split" | "stack" | "pdf" | "text">("split");
  const page = useSignal(1);
  const zoom = useSignal(1);
  const viewMode = useSignal<"continuous" | "single">("continuous");
  const language = useSignal("ja");
  const translationSegments = useSignal<TranslationSegmentResult[]>([]);
  const translationStale = useSignal(false);
  const dirty = useSignal(0);
  const saved = useSignal(0);
  const saveState = useSignal("保存済み");
  const readerTranslationController = useSignal<AbortController>();
  const readerTranslationID = useSignal("");
  const readerPersistTimer = useSignal<number>();
  const loading = useSignal(true);
  const error = useSignal("");
  const viewerRoot = useSignal<HTMLElement>();
  const fullscreen = useSignal(false);
  const showThumbnails = useSignal(true);
  const totalPages = useSignal(0);
  const fitMode = useSignal<PdfFitMode>();
  const fitVersion = useSignal(0);

  useOnDocument(
    "fullscreenchange",
    $(() => {
      fullscreen.value = document.fullscreenElement === viewerRoot.value;
    }),
  );

  useVisibleTask$(async () => {
    if (window.matchMedia("(max-width: 639px)").matches)
      showThumbnails.value = false;
    try {
      const [loaded, loadedFile] = await Promise.all([
        getPaper(id),
        getPaperFile(id),
      ]);
      if (!loaded || !loadedFile) throw new Error("論文が見つかりません。");
      const storedPageCount = Math.max(
        0,
        ...Object.keys(loadedFile.textByPage || {}).map(Number),
      );
      const opened = { ...loaded, lastOpenedAt: new Date().toISOString() };
      paper.value = opened;
      file.value = noSerialize(loadedFile);
      page.value = Math.max(
        1,
        Math.min(
          storedPageCount || Number.MAX_SAFE_INTEGER,
          loaded.reader?.page || 1,
        ),
      );
      zoom.value = loaded.reader?.zoom || 1;
      viewMode.value = loaded.reader?.viewMode || "continuous";
      layout.value = loaded.reader?.layout || "split";
      void savePaper(opened).catch(() => undefined);
      translations.value = await listTranslations(id);
      annotations.value = await listAnnotations(id);
      markdown.value = translations.value[0]?.markdown || "";
      translationSegments.value = translations.value[0]?.segments || [];
      if (translationSegments.value.length) {
        const comparisons = await Promise.all(
          translationSegments.value.map(async (segment) => {
            if (!segment.sourceText) return { known: false, stale: false };
            const currentPageText = normalizeSourceText(
              loadedFile.textByPage?.[segment.pageNumber] || "",
            );
            const sourceSnapshot = normalizeSourceText(segment.sourceText);
            return {
              known: true,
              stale:
                (await hashText(segment.sourceText)) !==
                  segment.sourceTextHash ||
                !currentPageText.includes(sourceSnapshot),
            };
          }),
        );
        translationStale.value = comparisons.some(
          (comparison) => comparison.known && comparison.stale,
        );
      }
    } catch (e) {
      error.value =
        e instanceof Error ? e.message : "論文を読み込めませんでした";
    } finally {
      loading.value = false;
    }
  });
  const save = $(async () => {
    const current = paper.value;
    if (!current || !file.value) return;
    if (saved.value === dirty.value) return;
    const version = dirty.value;
    saveState.value = "保存中…";
    try {
      const updated = {
        ...current,
        title: current.title.trim(),
        updatedAt: new Date().toISOString(),
      };
      paper.value = updated;
      await savePaper(updated);
      const previous = translations.value[0];
      if (markdown.value !== (previous?.markdown || "")) {
        const translation: Translation = {
          id: previous?.id || crypto.randomUUID(),
          documentId: id,
          language: language.value,
          markdown: markdown.value,
          source: previous?.source || "manual",
          updatedAt: new Date().toISOString(),
          revision: (previous?.revision || 0) + 1,
        };
        await saveTranslation(translation);
        translations.value = [
          translation,
          ...translations.value.filter((item) => item.id !== translation.id),
        ];
      }
      saved.value = version;
      saveState.value = "保存済み";
    } catch (e) {
      saveState.value = e instanceof Error ? e.message : "保存できませんでした";
    }
  });
  const persistReader = $(
    async (
      nextPage: number,
      nextZoom: number,
      nextViewMode: "continuous" | "single",
      nextLayout?: "split" | "stack" | "pdf" | "text",
    ) => {
      const current = paper.value;
      if (!current) return;
      const updated = {
        ...current,
        lastOpenedAt: new Date().toISOString(),
        reader: {
          page: nextPage,
          zoom: nextZoom,
          viewMode: nextViewMode,
          layout: nextLayout ?? layout.value,
        },
      };
      paper.value = updated;
      await savePaper(updated);
    },
  );
  const persistReaderSoon = $(() => {
    if (readerPersistTimer.value) window.clearTimeout(readerPersistTimer.value);
    readerPersistTimer.value = window.setTimeout(
      () => void persistReader(page.value, zoom.value, viewMode.value),
      250,
    );
  });
  const updatePage = $((value: number) => {
    page.value = value;
    void persistReaderSoon();
  });
  const updateZoom = $((value: number) => {
    zoom.value = value;
    void persistReader(page.value, value, viewMode.value);
  });
  const requestFit = $((mode: PdfFitMode) => {
    fitMode.value = mode;
    fitVersion.value++;
  });
  const updateViewMode = $((value: "continuous" | "single") => {
    viewMode.value = value;
    void persistReader(page.value, zoom.value, value);
  });
  const updateLayout = $((value: "split" | "stack" | "pdf" | "text") => {
    layout.value = value;
    void persistReader(page.value, zoom.value, viewMode.value, value);
  });
  useVisibleTask$(({ track, cleanup }) => {
    const current = track(() => dirty.value);
    const baseline = track(() => saved.value);
    if (current === baseline) return;
    const timer = setTimeout(() => void save(), 2500);
    cleanup(() => clearTimeout(timer));
  });
  const addAnnotation = $(async (draft: AnnotationDraft) => {
    const content =
      draft.type === "comment"
        ? window.prompt("コメントを入力してください", "") || ""
        : "";
    if (draft.type === "comment" && !content.trim()) return;
    const item: Annotation = {
      id: crypto.randomUUID(),
      documentId: id,
      pageNumber: draft.pageNumber,
      type: draft.type,
      quote: draft.quote,
      rect: draft.rect,
      content: content || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveAnnotation(item);
    annotations.value = [item, ...annotations.value];
    saveState.value = `${draft.pageNumber}ページの${draft.type === "highlight" ? "ハイライト" : draft.type === "underline" ? "下線" : "コメント"}を保存しました`;
  });
  const translateFromReader = $(async (draft: TranslationDraft) => {
    if (!paper.value || !draft.quote.trim()) return;
    const storedSettings = {
      ...defaultProvider,
      ...(await getSetting("provider", defaultProvider)),
    };
    const sessionSettings = getSessionProvider();
    const settings =
      sessionSettings?.mode === storedSettings.mode
        ? sessionSettings
        : storedSettings;
    if (layout.value === "pdf") {
      layout.value = "split";
      void persistReader(page.value, zoom.value, viewMode.value, "split");
    }
    saveState.value = "翻訳中…";
    const controller = new AbortController();
    readerTranslationController.value = noSerialize(controller);
    try {
      if (!isSupportedLanguage(settings.targetLanguage))
        throw new Error(
          "対応していない翻訳先言語です。設定を確認してください。",
        );
      const text = draft.quote.slice(0, 20_000);
      const textHash = await hashText(text);
      const segment = {
        id: `${id}:${draft.pageNumber}:inline:${Date.now()}`,
        pageNumber: draft.pageNumber,
        order: 0,
        text,
        textHash,
      };
      let translated = "";
      let segments: TranslationSegmentResult[] | undefined;
      if (settings.mode === "paperlens-managed") {
        if (!settings.connected)
          throw new Error(
            "LLM画面でPaperLens管理LLMへの接続確認を完了してください。",
          );
        const request: TranslationRequest = {
          documentId: id,
          sourceLanguage: "auto",
          targetLanguage: settings.targetLanguage,
          segments: [segment],
          preserveFormatting: true,
        };
        const preview = await estimateTranslation(request);
        if (
          !window.confirm(
            `${preview.estimate.estimatedCredits}クレジットを使用して${draft.pageNumber}ページを翻訳します。送信先はPaperLens管理LLMです。続けますか？`,
          )
        ) {
          saveState.value = "翻訳をキャンセルしました";
          return;
        }
        const result = await streamManagedTranslation(
          request,
          crypto.randomUUID(),
          (event) => {
            if (event.type === "started")
              readerTranslationID.value = event.data.translationId;
          },
          controller.signal,
        );
        translated =
          result?.segments.map((item) => item.translatedText).join("\n\n") ||
          "";
        segments = result?.segments.map((item) => ({
          ...item,
          sourceText: text,
        }));
      } else {
        const destination =
          settings.mode === "local" || settings.mode === "openai-compatible"
            ? settings.baseUrl
            : settings.mode === "openai"
              ? "OpenAI API"
              : settings.mode === "google"
                ? "Google Gemini API"
                : "Anthropic API";
        if (
          !window.confirm(
            `${localize(locale.value, "送信先", "Destination")}: ${destination}\n${localize(locale.value, "対象", "Scope")}: ${localize(locale.value, "選択範囲", "Selected text")}（${draft.pageNumber}${localize(locale.value, "ページ", " page")}）\n${localize(locale.value, "PaperLensクレジット", "PaperLens credits")}: 0\n${localize(locale.value, "APIキーはこのブラウザのセッション中だけ使用します。送信しますか？", "The API key is used only for this browser session. Send the selected text?")}`,
          )
        ) {
          saveState.value = localize(
            locale.value,
            "翻訳をキャンセルしました",
            "Translation canceled",
          );
          return;
        }
        translated = await translateText(settings, text, controller.signal);
        segments = [
          {
            id: segment.id,
            pageNumber: segment.pageNumber,
            translatedText: translated,
            sourceTextHash: textHash,
            sourceText: text,
          },
        ];
      }
      if (!translated.trim()) throw new Error("翻訳結果が空です。");
      const item: Translation = {
        id: crypto.randomUUID(),
        documentId: id,
        language: settings.targetLanguage,
        markdown: translated,
        source: "llm",
        updatedAt: new Date().toISOString(),
        revision: 1,
        segments,
      };
      await saveTranslation(item);
      translations.value = [item, ...translations.value];
      markdown.value = item.markdown;
      language.value = item.language;
      translationSegments.value = item.segments || [];
      translationStale.value = false;
      saveState.value = `${draft.pageNumber}ページの翻訳を保存しました`;
    } catch (error) {
      saveState.value =
        error instanceof DOMException && error.name === "AbortError"
          ? "翻訳をキャンセルしました。受信済みの結果を確認できます。"
          : error instanceof Error
            ? error.message
            : "翻訳に失敗しました";
    } finally {
      readerTranslationController.value = undefined;
      readerTranslationID.value = "";
    }
  });
  const cancelReaderTranslation = $(async () => {
    const id = readerTranslationID.value;
    if (id) {
      try {
        await cancelManagedTranslation(id);
      } catch {
        /* the request context still releases the reservation */
      }
    }
    readerTranslationController.value?.abort();
  });
  const exportMarkdown = $(() => {
    if (!markdown.value.trim()) return;
    const url = URL.createObjectURL(
      new Blob([markdown.value], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(paper.value?.fileName || "paper").replace(/\.pdf$/i, "")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const downloadPdf = $(() => {
    if (!file.value) return;
    const url = URL.createObjectURL(file.value.file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = paper.value?.fileName || `${id}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  const toggleViewerFullscreen = $(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await viewerRoot.value?.requestFullscreen();
  });
  const updatePageInput = $((raw: string) => {
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 1) return;
    void updatePage(Math.min(totalPages.value || next, next));
  });
  const translateCurrentPage = $(() => {
    const quote = file.value?.textByPage?.[page.value]?.trim();
    if (quote) void translateFromReader({ pageNumber: page.value, quote });
  });

  if (loading.value)
    return (
      <main class="flex h-screen items-center justify-center bg-[#525659] text-sm text-white/70">
        {t("論文を読み込んでいます…", "Loading paper…")}
      </main>
    );
  if (error.value || !paper.value)
    return (
      <main class="flex h-screen items-center justify-center bg-[#525659] p-6">
        <div class="max-w-md bg-white p-7 text-center text-sm text-slate-700 shadow-2xl">
          <p role="alert">
            {error.value || t("論文が見つかりません", "Paper not found")}
          </p>
          <Link href="/" class="button mt-5">
            {t("ライブラリへ戻る", "Back to library")}
          </Link>
        </div>
      </main>
    );

  const viewerPaper = paper.value;
  const viewerLayoutClass =
    layout.value === "split"
      ? "reader-layout reader-layout-split grid grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)]"
      : layout.value === "stack"
        ? "reader-layout grid grid-rows-2"
        : "reader-layout flex";

  return (
    <main
      ref={viewerRoot}
      class="flex h-screen min-h-0 w-full flex-col overflow-hidden bg-[#525659] text-slate-900"
    >
      <header class="paper-viewer-toolbar flex h-14 shrink-0 items-center gap-1 bg-[#323639] px-2 text-white shadow-md sm:gap-2 sm:px-3">
        <div class="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
          <Link
            href="/"
            class="viewer-icon-button"
            aria-label={t("ライブラリへ戻る", "Back to library")}
            title={t("ライブラリへ戻る", "Back to library")}
          >
            <Icon name="ArrowLeft" size={20} />
          </Link>
          <button
            type="button"
            class={
              showThumbnails.value
                ? "viewer-icon-button bg-white/15"
                : "viewer-icon-button"
            }
            aria-pressed={showThumbnails.value}
            aria-label={t("サムネイルを切り替え", "Toggle thumbnails")}
            title={t("サムネイル", "Thumbnails")}
            onClick$={() => (showThumbnails.value = !showThumbnails.value)}
          >
            <Icon name="Menu" size={20} />
          </button>
          <div class="hidden min-w-0 sm:block">
            <p class="max-w-56 truncate text-[13px] font-medium lg:max-w-80">
              {viewerPaper.title}
            </p>
            <p class="max-w-56 truncate text-[10px] text-white/55 lg:max-w-80">
              {viewerPaper.fileName}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="viewer-icon-button"
            disabled={page.value <= 1}
            aria-label={t("前のページ", "Previous page")}
            onClick$={() => updatePage(Math.max(1, page.value - 1))}
          >
            <Icon name="ChevronLeft" size={18} />
          </button>
          <input
            class="viewer-page-input"
            type="number"
            min={1}
            max={totalPages.value || undefined}
            value={page.value}
            aria-label={t("ページ番号", "Page number")}
            onChange$={(_, el) => updatePageInput(el.value)}
          />
          <span class="min-w-10 text-xs tabular-nums text-white/70">
            / {totalPages.value || "—"}
          </span>
          <button
            type="button"
            class="viewer-icon-button"
            disabled={!totalPages.value || page.value >= totalPages.value}
            aria-label={t("次のページ", "Next page")}
            onClick$={() =>
              updatePage(
                Math.min(totalPages.value || page.value + 1, page.value + 1),
              )
            }
          >
            <Icon name="ChevronRight" size={18} />
          </button>
        </div>

        <div class="flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-2">
          <div class="hidden items-center md:flex">
            <button
              type="button"
              class="viewer-icon-button"
              aria-label={t("縮小", "Zoom out")}
              onClick$={() => updateZoom(Math.max(0.5, zoom.value - 0.1))}
            >
              <Icon name="ZoomOut" size={18} />
            </button>
            <span class="w-12 text-center text-xs tabular-nums text-white/80">
              {Math.round(zoom.value * 100)}%
            </span>
            <button
              type="button"
              class="viewer-icon-button"
              aria-label={t("拡大", "Zoom in")}
              onClick$={() => updateZoom(Math.min(3, zoom.value + 0.1))}
            >
              <Icon name="ZoomIn" size={18} />
            </button>
          </div>
          <div
            class="hidden items-center gap-0.5 sm:flex"
            role="group"
            aria-label={t("PDFの表示倍率", "PDF zoom mode")}
          >
            <button
              type="button"
              class={`viewer-icon-button ${fitMode.value === "page" ? "bg-white/15" : ""}`}
              aria-pressed={fitMode.value === "page"}
              aria-label={t("ページ全体に合わせる", "Fit to page")}
              title={t("ページ全体に合わせる", "Fit to page")}
              onClick$={() => requestFit("page")}
            >
              <Icon name="Scan" size={18} />
            </button>
            <button
              type="button"
              class={`viewer-icon-button ${fitMode.value === "width" ? "bg-white/15" : ""}`}
              aria-pressed={fitMode.value === "width"}
              aria-label={t("幅に合わせる", "Fit to width")}
              title={t("幅に合わせる", "Fit to width")}
              onClick$={() => requestFit("width")}
            >
              <Icon name="MoveHorizontal" size={18} />
            </button>
            <button
              type="button"
              class={`viewer-icon-button ${fitMode.value === "height" ? "bg-white/15" : ""}`}
              aria-pressed={fitMode.value === "height"}
              aria-label={t("高さに合わせる", "Fit to height")}
              title={t("高さに合わせる", "Fit to height")}
              onClick$={() => requestFit("height")}
            >
              <Icon name="MoveVertical" size={18} />
            </button>
          </div>
          <select
            class="viewer-toolbar-select hidden xl:block"
            aria-label={t("PDF表示方式", "PDF view mode")}
            title={t("PDF表示方式", "PDF view mode")}
            value={viewMode.value}
            onChange$={(_, el) =>
              updateViewMode(el.value as "continuous" | "single")
            }
          >
            <option value="continuous">{t("連続", "Continuous")}</option>
            <option value="single">{t("単ページ", "Single page")}</option>
          </select>
          <select
            class="viewer-toolbar-select max-w-24 sm:max-w-48"
            aria-label={t("表示レイアウト", "Layout")}
            title={t("表示レイアウト", "Layout")}
            value={layout.value}
            onChange$={(_, el) =>
              updateLayout(el.value as "split" | "stack" | "pdf" | "text")
            }
          >
            <option value="pdf">{t("PDFのみ", "PDF only")}</option>
            <option value="text">{t("翻訳のみ", "Translation only")}</option>
            <option value="split">{t("左右に表示", "Side by side")}</option>
            <option value="stack">{t("上下に表示", "Stacked")}</option>
          </select>
          <button
            type="button"
            class="viewer-icon-button hidden sm:inline-flex"
            aria-label={t("PDFをダウンロード", "Download PDF")}
            title={t("PDFをダウンロード", "Download PDF")}
            onClick$={downloadPdf}
          >
            <Icon name="FileDown" size={19} />
          </button>
          <button
            type="button"
            class="viewer-icon-button hidden sm:inline-flex"
            aria-label={t(
              fullscreen.value ? "全画面を終了" : "全画面",
              fullscreen.value ? "Exit fullscreen" : "Fullscreen",
            )}
            title={t(
              fullscreen.value ? "全画面を終了" : "全画面",
              fullscreen.value ? "Exit fullscreen" : "Fullscreen",
            )}
            onClick$={toggleViewerFullscreen}
          >
            <Icon
              name={fullscreen.value ? "Minimize2" : "Maximize2"}
              size={19}
            />
          </button>
        </div>
      </header>

      <div class={`${viewerLayoutClass} min-h-0 flex-1`}>
        <section
          aria-label={t("PDFビューアー", "PDF viewer")}
          class={`${layout.value === "text" ? "hidden" : "block"} min-h-0 min-w-0 overflow-hidden ${layout.value === "split" ? "border-r border-black/30" : layout.value === "stack" ? "border-b border-black/30" : "flex-1"}`}
        >
          <PdfReader
            documentId={id}
            page={page.value}
            zoom={zoom.value}
            viewMode={viewMode.value}
            active={layout.value !== "text"}
            annotations={annotations.value}
            minimal
            showThumbnails={showThumbnails.value}
            fitMode={fitMode.value}
            fitVersion={fitVersion.value}
            onPages$={$((count: number) => (totalPages.value = count))}
            onPage$={updatePage}
            onZoom$={updateZoom}
            onAnnotate$={addAnnotation}
            onTranslate$={translateFromReader}
          />
        </section>

        <section
          aria-label={t("翻訳", "Translation")}
          class={`${layout.value === "pdf" ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col bg-white`}
        >
          <div class="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-[#f8f9fa] px-3">
            <h2 class="mr-auto truncate text-sm font-semibold">
              {t("翻訳", "Translation")}
            </h2>
            <span
              class="hidden max-w-48 truncate text-[11px] text-slate-500 lg:block"
              role="status"
            >
              {saveState.value}
            </span>
            {saveState.value === "翻訳中…" && (
              <button
                type="button"
                class="viewer-panel-button text-red-700"
                onClick$={cancelReaderTranslation}
              >
                {t("キャンセル", "Cancel")}
              </button>
            )}
            <button
              type="button"
              class="viewer-panel-button px-2 md:px-2.5"
              disabled={!file.value?.textByPage?.[page.value]?.trim()}
              aria-label={t("このページを翻訳", "Translate page")}
              title={t("このページを翻訳", "Translate page")}
              onClick$={translateCurrentPage}
            >
              <Icon name="Sparkles" size={15} />
              <span class="hidden md:inline">
                {t("このページを翻訳", "Translate page")}
              </span>
            </button>
            <select
              class="viewer-panel-select"
              aria-label={t("翻訳言語", "Translation language")}
              value={language.value}
              onChange$={(_, el) => (language.value = el.value)}
            >
              {supportedLanguages.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              class="viewer-icon-button-light"
              aria-label={
                editing.value ? t("プレビュー", "Preview") : t("編集", "Edit")
              }
              title={
                editing.value ? t("プレビュー", "Preview") : t("編集", "Edit")
              }
              onClick$={() => (editing.value = !editing.value)}
            >
              <Icon name={editing.value ? "BookOpen" : "Pencil"} size={17} />
            </button>
            <button
              type="button"
              class="viewer-icon-button-light hidden sm:inline-flex"
              disabled={!markdown.value.trim()}
              aria-label={t("Markdownを書き出す", "Export Markdown")}
              title={t("Markdownを書き出す", "Export Markdown")}
              onClick$={exportMarkdown}
            >
              <Icon name="Download" size={17} />
            </button>
            <button
              type="button"
              class="viewer-icon-button-light"
              aria-label={t("保存", "Save")}
              title={t("保存", "Save")}
              onClick$={save}
            >
              <Icon name="Save" size={17} />
            </button>
          </div>
          {translationStale.value && (
            <p
              role="alert"
              class="m-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
            >
              {t(
                "原文が変更されています。この翻訳は古い可能性があります。",
                "The source changed; this translation may be stale.",
              )}
            </p>
          )}
          <div class="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
            {editing.value ? (
              <textarea
                class="h-full min-h-80 w-full resize-none border-0 font-mono text-sm leading-7 shadow-none focus:border-0 focus:shadow-none"
                aria-label={t("翻訳Markdown", "Translation Markdown")}
                placeholder={t("翻訳文", "Translation")}
                value={markdown.value}
                onInput$={(_, el) => {
                  markdown.value = el.value;
                  translationSegments.value = [];
                  translationStale.value = false;
                  dirty.value++;
                  saveState.value = "未保存の変更";
                }}
              />
            ) : (
              <div class="mx-auto max-w-3xl">
                <MarkdownPreview value={markdown.value} />
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
});
export const head: DocumentHead = { title: "論文 | PaperLens" };
