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
import { OpenTabs, QuickSwitcher } from "~/components/app-shell";
import {
  PdfReader,
  type AnnotationDraft,
  type PdfFitMode,
  type TranslationDraft,
} from "~/components/pdf-reader";
import {
  supportedLanguages,
  isSupportedLanguage,
  providerDisplayName,
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
  saveSetting,
  removeSetting,
  saveAnnotation,
  removeAnnotation,
  savePaper,
  saveTranslation,
} from "~/lib/storage";
import { localize, useLocale } from "~/lib/i18n";

const defaultProvider: ProviderSettings = {
  mode: "local",
  model: "",
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
const pageLabel = (page: number, locale: "ja" | "en") => locale === "en" ? `Page ${page}` : `${page}ページ`;
const InlineMarkdown = component$<{ text: string }>(({ text }) => {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g);
  return <>{parts.map((part, index) => {
    const bold = part.match(/^\*\*(.+)\*\*$/);
    const code = part.match(/^`(.+)`$/);
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (bold) return <strong key={index}>{bold[1]}</strong>;
    if (code) return <code key={index} class="rounded bg-slate-100 px-1">{code[1]}</code>;
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" class="text-sky-700 underline">{link[1]}</a>;
    return <span key={index}>{part}</span>;
  })}</>;
});
const MarkdownPreview = component$<{ value: string }>(({ value }) => (
  <div class="space-y-3 text-sm leading-7 text-slate-700">
    {value.trim() ? (
      value.split("\n").map((line, index) =>
          line.startsWith("# ") ? (
            <h3 key={index} class="text-lg font-bold text-slate-950">
              <InlineMarkdown text={line.slice(2)} />
            </h3>
          ) : line.startsWith("## ") ? (
            <h4 key={index} class="font-bold text-slate-950">
              <InlineMarkdown text={line.slice(3)} />
            </h4>
          ) : line.startsWith("- ") ? (
            <p key={index}>・<InlineMarkdown text={line.slice(2)} /></p>
          ) : (
            <p key={index}><InlineMarkdown text={line || " "} /></p>
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
  const translationProgress = useSignal("");
  const translationStale = useSignal(false);
  const selectedTranslationId = useSignal("");
  const dirty = useSignal(0);
  const saved = useSignal(0);
  const saveState = useSignal("保存済み");
  const saving = useSignal(false);
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
  const providerConnected = useSignal(false);
  const requestedPage = (() => {
    const raw = location.url.searchParams.get("page");
    if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  })();
  const requestedReturnTo = (() => {
    const value = location.url.searchParams.get("returnTo");
    return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
  })();

  useOnDocument(
    "fullscreenchange",
    $(() => {
      fullscreen.value = document.fullscreenElement === viewerRoot.value;
    }),
  );

  // Papers and PDF blobs are loaded from browser storage.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    if (window.matchMedia("(max-width: 639px)").matches)
      showThumbnails.value = false;
    try {
      const [loaded, loadedFile, configuredProvider, defaultViewMode] = await Promise.all([
        getPaper(id),
        getPaperFile(id),
        getSetting("provider", defaultProvider),
        getSetting<"continuous" | "single">("viewMode", "continuous"),
      ]);
      if (!loaded) throw new Error("論文が見つかりません。");
      if (!loadedFile) throw new Error("この論文にはPDF本体がありません。元のPDFを再登録して結び直してください。");
      const initialLanguage =
        getSessionProvider()?.targetLanguage ||
        configuredProvider.targetLanguage;
      providerConnected.value =
        getSessionProvider()?.mode === configuredProvider.mode
          ? !!getSessionProvider()?.connected
          : configuredProvider.connected;
      if (isSupportedLanguage(initialLanguage))
        language.value = initialLanguage;
      const storedPageCount = Math.max(
        0,
        ...Object.keys(loadedFile.textByPage || {}).map(Number),
      );
      const opened = { ...loaded, lastOpenedAt: new Date().toISOString() };
      paper.value = opened;
      file.value = noSerialize(loadedFile);
      page.value = Math.max(
        1,
        requestedPage ||
          Math.min(
            storedPageCount || Number.MAX_SAFE_INTEGER,
            loaded.reader?.page || 1,
          ),
      );
      zoom.value = loaded.reader?.zoom || 1;
      viewMode.value = loaded.reader?.viewMode || defaultViewMode || "continuous";
      layout.value = loaded.reader?.layout || "split";
      void savePaper(opened).catch(() => undefined);
      translations.value = (await listTranslations(id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      annotations.value = await listAnnotations(id);
      const latest = translations.value[0];
      selectedTranslationId.value = latest?.id || "";
      const draft = await getSetting<{ markdown: string; updatedAt: string; translationId?: string; language?: string; segments?: TranslationSegmentResult[] } | undefined>(`editor-draft:${id}`, undefined).catch(() => undefined);
      if (draft?.translationId && translations.value.some((item) => item.id === draft.translationId)) selectedTranslationId.value = draft.translationId;
      const initialTranslation = translations.value.find((item) => item.id === selectedTranslationId.value) || latest;
      markdown.value = draft?.markdown ?? initialTranslation?.markdown ?? "";
      if (draft?.language && isSupportedLanguage(draft.language)) language.value = draft.language;
      if (draft?.markdown != null && draft.markdown !== initialTranslation?.markdown) {
        dirty.value = 1;
        saveState.value = "未保存の変更";
      }
      translationSegments.value = draft?.segments || initialTranslation?.segments || [];
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
    if (saving.value) return;
    saving.value = true;
    const version = dirty.value;
    const snapshotTranslationId = selectedTranslationId.value;
    const snapshotMarkdown = markdown.value;
    const snapshotLanguage = language.value;
    const snapshotSegments = translationSegments.value;
    saveState.value = "保存中…";
    try {
      const updated = {
        ...current,
        title: current.title.trim(),
        updatedAt: new Date().toISOString(),
      };
      paper.value = updated;
      await savePaper(updated);
      const previous = translations.value.find((item) => item.id === snapshotTranslationId) || translations.value[0];
      let persistedTranslationId = snapshotTranslationId || previous?.id || "";
      if (snapshotMarkdown !== (previous?.markdown || "")) {
        const translation: Translation = {
          id: previous?.id || crypto.randomUUID(),
          documentId: id,
          language: previous?.language || snapshotLanguage,
          markdown: snapshotMarkdown,
          source: previous?.source || "manual",
          updatedAt: new Date().toISOString(),
          revision: (previous?.revision || 0) + 1,
          // Keep page/source mapping when editing an existing translation so
          // history selection and stale-source warnings remain meaningful.
          segments: snapshotSegments.length ? snapshotSegments : previous?.segments,
          pageStart: previous?.pageStart,
          pageEnd: previous?.pageEnd,
        };
        persistedTranslationId = translation.id;
        await saveTranslation(translation);
        translations.value = [
          translation,
          ...translations.value.filter((item) => item.id !== translation.id),
        ];
        selectedTranslationId.value = translation.id;
      }
      const stillCurrent = dirty.value === version && selectedTranslationId.value === persistedTranslationId && markdown.value === snapshotMarkdown;
      if (stillCurrent) {
        await removeSetting(`editor-draft:${id}`).catch(() => undefined);
        saved.value = version;
        saveState.value = "保存済み";
      } else {
        saveState.value = "未保存の変更";
      }
    } catch (e) {
      saveState.value = e instanceof Error ? e.message : "保存できませんでした";
    } finally {
      saving.value = false;
    }
  });
  const selectTranslation = $(async (translationId: string) => {
    if (dirty.value !== saved.value && !window.confirm(localize(locale.value, "未保存の変更を破棄して別の翻訳を開きますか？", "Discard unsaved changes and open another translation?"))) return;
    const selected = translations.value.find((item) => item.id === translationId);
    if (!selected) return;
    selectedTranslationId.value = selected.id;
    markdown.value = selected.markdown;
    language.value = selected.language;
    translationSegments.value = selected.segments || [];
    translationStale.value = false;
    saveState.value = "保存済み";
    // Selecting a persisted revision establishes a new clean baseline. Any
    // previously recovered draft belongs to the old revision and must not
    // reappear when the user revisits this page.
    dirty.value = 0;
    saved.value = 0;
    await removeSetting(`editor-draft:${id}`).catch(() => undefined);
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
    if (dirty.value === saved.value) {
      const matching = translations.value.find((item) =>
        item.pageStart
          ? value >= item.pageStart && value <= (item.pageEnd || item.pageStart)
          : item.segments?.some((segment) => segment.pageNumber === value),
      );
      if (matching && matching.id !== selectedTranslationId.value) {
        selectedTranslationId.value = matching.id;
        markdown.value = matching.markdown;
        language.value = matching.language;
        translationSegments.value = matching.segments || [];
      }
    }
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
  // Autosave is a browser timer around local persistence.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    const current = track(() => dirty.value);
    const baseline = track(() => saved.value);
    if (current === baseline) return;
    const timer = setTimeout(() => void save(), 2500);
    cleanup(() => clearTimeout(timer));
  });
  // Warn before a full page navigation while a save is pending. The editor
  // draft is persisted on input, so the user can safely return and recover it.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    track(() => dirty.value);
    track(() => saved.value);
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.value === saved.value) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    cleanup(() => window.removeEventListener("beforeunload", warn));
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
    try {
      await saveAnnotation(item);
    } catch {
      saveState.value = localize(
        locale.value,
        "注釈を保存できませんでした。ブラウザの保存領域を確認して再試行してください。",
        "Could not save the annotation. Check browser storage and try again.",
      );
      return;
    }
    annotations.value = [item, ...annotations.value];
    saveState.value = `${draft.pageNumber}ページの${draft.type === "highlight" ? "ハイライト" : draft.type === "underline" ? "下線" : "コメント"}を保存しました`;
  });
  const deleteAnnotation = $(async (annotation: Annotation) => {
    if (!window.confirm(localize(locale.value, "この注釈を削除しますか？", "Delete this annotation?"))) return;
    try {
      await removeAnnotation(annotation.id);
      annotations.value = annotations.value.filter((item) => item.id !== annotation.id);
    } catch (error) {
      saveState.value = error instanceof Error ? error.message : localize(locale.value, "注釈を削除できませんでした", "Could not delete annotation");
    }
  });
  const editAnnotation = $(async (annotation: Annotation) => {
    if (annotation.type !== "comment") return;
    const content = window.prompt(localize(locale.value, "コメントを編集", "Edit comment"), annotation.content || "");
    if (content == null || !content.trim()) return;
    const updated = { ...annotation, content: content.trim(), updatedAt: new Date().toISOString() };
    try {
      await saveAnnotation(updated);
      annotations.value = annotations.value.map((item) => item.id === updated.id ? updated : item);
      saveState.value = localize(locale.value, "コメントを更新しました", "Comment updated");
    } catch (error) {
      saveState.value = error instanceof Error ? error.message : localize(locale.value, "コメントを更新できませんでした", "Could not update comment");
    }
  });
  const translateFromReader = $(async (draft: TranslationDraft) => {
    if (!paper.value || !draft.quote.trim()) return;
    // Finish an editor change before starting a page/range translation. The
    // translation result becomes a new revision; allowing the old autosave
    // timer to run afterward could erase that edit.
    if (dirty.value !== saved.value) {
      await save();
      if (dirty.value !== saved.value) {
        saveState.value = localize(locale.value, "未保存の変更を保存できないため翻訳を開始できません。", "Translation was not started because the pending edit could not be saved.");
        return;
      }
    }
    const storedSettings = {
      ...defaultProvider,
      ...(await getSetting("provider", defaultProvider)),
    };
    const sessionSettings = getSessionProvider();
    const settings =
      sessionSettings?.mode === storedSettings.mode
        ? sessionSettings
        : storedSettings;
    const targetLanguage = language.value;
    if (!isSupportedLanguage(targetLanguage)) {
      saveState.value =
        "リーダーの翻訳言語が未対応です。翻訳言語を選び直してください。";
      return;
    }
    const translationSettings = { ...settings, targetLanguage };
    if (layout.value === "pdf") {
      layout.value = "split";
      void persistReader(page.value, zoom.value, viewMode.value, "split");
    }
    saveState.value = "翻訳中…";
    translationProgress.value = "";
    const controller = new AbortController();
    readerTranslationController.value = noSerialize(controller);
    try {
      if (draft.quote.length > 20_000)
        throw new Error(localize(locale.value, "選択範囲が上限の20,000文字を超えています。範囲を分けて翻訳してください。", "The selected text exceeds the 20,000-character limit. Select a smaller range."));
      const text = draft.quote;
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
      const streamedSegments: TranslationSegmentResult[] = [];
      if (!settings.connected)
        throw new Error(
          localize(
            locale.value,
            "設定画面でLLM接続を確認してください。",
            "Check your AI connection in Settings.",
          ),
        );
      if (settings.mode === "paperlens-managed") {
        const request: TranslationRequest = {
          documentId: id,
          sourceLanguage: "auto",
          targetLanguage,
          model: settings.model,
          segments: [segment],
          preserveFormatting: true,
        };
        const preview = await estimateTranslation(request);
        if (
          !window.confirm(
            `${preview.estimate.estimatedCredits}クレジットを使用して${draft.pageNumber}ページを翻訳します。送信先はPaperLens LLMです。続けますか？`,
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
            if (event.type === "segment") {
              const segment = { ...event.data, sourceText: text };
              streamedSegments.push(segment);
              // Keep in-flight output separate from the editor's selected
              // revision. Autosave must never overwrite a saved translation
              // with a mixture of old and partial streamed content.
              translationProgress.value = streamedSegments.map((item) => item.translatedText).join("\n\n");
            }
          },
          controller.signal,
        );
        translated = result?.segments.map((item) => item.translatedText).join("\n\n") || translationProgress.value;
        segments = (result?.segments || streamedSegments).map((item) => ({
          ...item,
          sourceText: text,
        }));
      } else {
        const destination = providerDisplayName(settings.mode);
        const endpoint = settings.mode === "local" || settings.mode === "openai-compatible" ? settings.baseUrl : "";
        if (
          !window.confirm(
            `${localize(locale.value, "送信先", "Destination")}: ${destination}${endpoint ? `\n${localize(locale.value, "接続先", "Endpoint")}: ${endpoint}` : ""}\n${localize(locale.value, "対象", "Scope")}: ${localize(locale.value, "選択範囲", "Selected text")}（${draft.pageNumber}${localize(locale.value, "ページ", " page")}）\n${localize(locale.value, "PaperLensクレジット", "PaperLens credits")}: 0\n${localize(locale.value, "APIキーはこのブラウザのセッション中だけ使用します。送信しますか？", "The API key is used only for this browser session. Send the selected text?")}`,
          )
        ) {
          saveState.value = localize(
            locale.value,
            "翻訳をキャンセルしました",
            "Translation canceled",
          );
          return;
        }
        translated = await translateText(
          translationSettings,
          text,
          controller.signal,
        );
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
        language: targetLanguage,
        markdown: translated,
        source: "llm",
        updatedAt: new Date().toISOString(),
        revision: 1,
        segments,
        pageStart: draft.pageNumber,
        pageEnd: draft.endPage || draft.pageNumber,
      };
      await saveTranslation(item);
      translations.value = [item, ...translations.value];
      selectedTranslationId.value = item.id;
      markdown.value = item.markdown;
      language.value = item.language;
      translationSegments.value = item.segments || [];
      translationStale.value = false;
      translationProgress.value = "";
      dirty.value = 0;
      saved.value = 0;
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
  const translateRange = $(async () => {
    if (!file.value?.textByPage || !totalPages.value) return;
    const raw = window.prompt(localize(locale.value, "翻訳するページ範囲（例: 2-4）", "Pages to translate (for example: 2-4)"), `${page.value}-${page.value}`);
    if (!raw) return;
    const match = raw.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) { saveState.value = localize(locale.value, "ページ範囲の形式を確認してください", "Enter a range such as 2-4"); return; }
    const start = Math.max(1, Number(match[1]));
    const end = Math.min(totalPages.value, Number(match[2]));
    if (start > end) { saveState.value = localize(locale.value, "ページ範囲の形式を確認してください", "Enter a valid page range"); return; }
    const quote = Array.from({ length: end - start + 1 }, (_, index) => file.value?.textByPage?.[start + index] || "").filter(Boolean).join("\n\n");
    if (quote) await translateFromReader({ pageNumber: start, endPage: end, quote });
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
          {error.value.includes("PDF本体") && (
            <Link href={`/upload/?replace=${encodeURIComponent(id)}`} class="button primary mt-3">
              {t("元のPDFを再登録", "Reattach the original PDF")}
            </Link>
          )}
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
      <QuickSwitcher />
      <OpenTabs variant="reader" />
      <header class="paper-viewer-toolbar flex h-14 shrink-0 items-center gap-1 bg-[#323639] px-2 text-white shadow-md sm:gap-2 sm:px-3">
        <div class="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
          <Link
            href={requestedReturnTo}
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
          <button
            type="button"
            class="viewer-icon-button sm:hidden"
            aria-label={t("幅に合わせる", "Fit to width")}
            title={t("幅に合わせる", "Fit to width")}
            onClick$={() => requestFit("width")}
          >
            <Icon name="MoveHorizontal" size={17} />
          </button>
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
      {saveState.value !== "保存済み" && (
        <div role={saveState.value.includes("失敗") || saveState.value.includes("できません") ? "alert" : "status"} class="shrink-0 border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-900">
          {saveState.value}
        </div>
      )}

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
            onPages$={$((count: number) => {
              totalPages.value = count;
              if (page.value > count) void updatePage(count);
            })}
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
            {translations.value.length > 1 && (
              <select
                class="viewer-panel-select max-w-40"
                aria-label={t("保存済みの翻訳", "Saved translations")}
                value={selectedTranslationId.value}
                disabled={saving.value || saveState.value === "翻訳中…"}
                onChange$={(_, el) => selectTranslation(el.value)}
              >
                {translations.value.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.language} · ${new Intl.DateTimeFormat(locale.value === "en" ? "en-US" : "ja-JP", { dateStyle: "short" }).format(new Date(item.updatedAt))}`}
                  </option>
                ))}
              </select>
            )}
            <span
              class="max-w-32 truncate text-[10px] text-slate-500 sm:max-w-48 sm:text-[11px]"
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
                disabled={
                saving.value ||
                saveState.value === "翻訳中…" ||
                !providerConnected.value ||
                !file.value?.textByPage?.[page.value]?.trim()
              }
              aria-label={t("このページを翻訳", "Translate page")}
              title={t("このページを翻訳", "Translate page")}
              onClick$={translateCurrentPage}
            >
              <Icon name="Sparkles" size={15} />
              <span class="hidden md:inline">
                {t("このページを翻訳", "Translate page")}
              </span>
            </button>
            <button type="button" class="viewer-panel-button hidden sm:inline-flex" disabled={saveState.value === "翻訳中…" || !providerConnected.value || !totalPages.value} onClick$={translateRange}>
              <Icon name="ArrowUpDown" size={15} />
              {t("範囲を翻訳", "Translate range")}
            </button>
            <Link
              href="/settings/#ai-connection"
              class={`viewer-icon-button-light relative ${providerConnected.value ? "text-emerald-700" : "text-amber-700"}`}
              aria-label={
                providerConnected.value
                  ? t("LLM接続済み。設定を開く", "LLM connected. Open settings")
                  : t("LLM未接続。設定を開く", "LLM not connected. Open settings")
              }
              title={
                providerConnected.value
                  ? t("LLM接続済み", "LLM connected")
                  : t("LLM接続を設定", "Configure LLM")
              }
            >
              <Icon name="Settings2" size={17} />
              <span
                class={`absolute right-1 top-1 size-2 ${providerConnected.value ? "bg-emerald-500" : "bg-amber-400"}`}
                aria-hidden="true"
              />
            </Link>
            <select
              class="viewer-panel-select"
              aria-label={t("次回の翻訳先", "Next translation language")}
              value={language.value}
              disabled={saving.value || saveState.value === "翻訳中…"}
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
          {translationProgress.value && (saveState.value === "翻訳中…" || saveState.value.includes("キャンセル")) && (
            <div class="border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-900" role="status" aria-live="polite">
              {t("受信済みの翻訳", "Received translation")} · {translationProgress.value.slice(0, 240)}{translationProgress.value.length > 240 ? "…" : ""}
            </div>
          )}
          {markdown.value && (
            <p class="m-0 border-b border-slate-100 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-500" role="status">
              {t("表示中の翻訳", "Showing translation")} · {(() => { const selected = translations.value.find((item) => item.id === selectedTranslationId.value); return selected?.language || t("未選択", "None"); })()} · {(() => { const selected = translations.value.find((item) => item.id === selectedTranslationId.value); return selected?.pageStart ? selected.pageEnd && selected.pageEnd !== selected.pageStart ? `${pageLabel(selected.pageStart, locale.value)}–${pageLabel(selected.pageEnd, locale.value)}` : pageLabel(selected.pageStart, locale.value) : translationSegments.value.length ? [...new Set(translationSegments.value.map((segment) => pageLabel(segment.pageNumber, locale.value)))].join(", ") : t("ページ情報なし", "Page unspecified"); })()}
            </p>
          )}
          <div class="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
            {editing.value ? (
              <textarea
                class="h-full min-h-80 w-full resize-none border-0 font-mono text-sm leading-7 shadow-none focus:border-0 focus:shadow-none"
                aria-label={t("翻訳Markdown", "Translation Markdown")}
                placeholder={t("翻訳文", "Translation")}
                disabled={saving.value || saveState.value === "翻訳中…"}
                value={markdown.value}
                onInput$={(_, el) => {
                  markdown.value = el.value;
                  translationSegments.value = [];
                  translationStale.value = false;
                  dirty.value++;
                  saveState.value = "未保存の変更";
                  void saveSetting(`editor-draft:${id}`, { markdown: el.value, translationId: selectedTranslationId.value, language: language.value, segments: translationSegments.value, updatedAt: new Date().toISOString() }).catch(() => undefined);
                }}
              />
            ) : (
              <div class="mx-auto max-w-3xl">
                <MarkdownPreview value={markdown.value} />
              </div>
            )}
            {annotations.value.length > 0 && (
              <details class="mx-auto mt-8 max-w-3xl border border-slate-200">
                <summary class="cursor-pointer px-4 py-3 text-sm font-semibold">{t("注釈", "Annotations")} ({annotations.value.length})</summary>
                <div class="space-y-2 border-t border-slate-200 p-3">
                  {annotations.value.map((annotation) => (
                    <div key={annotation.id} class="flex items-start gap-3 border-l-2 border-sky-300 bg-slate-50 p-3 text-xs">
                      <button type="button" class="font-semibold text-sky-700 hover:text-sky-950" onClick$={() => updatePage(annotation.pageNumber)}>{pageLabel(annotation.pageNumber, locale.value)}</button>
                      <p class="min-w-0 flex-1 whitespace-pre-wrap text-slate-600">{annotation.content || annotation.quote || t("注釈", "Annotation")}</p>
                      {annotation.type === "comment" && <button type="button" class="text-sky-700" aria-label={t("コメントを編集", "Edit comment")} onClick$={() => editAnnotation(annotation)}><Icon name="Pencil" size={15} /></button>}
                      <button type="button" class="text-red-700" aria-label={t("注釈を削除", "Delete annotation")} onClick$={() => deleteAnnotation(annotation)}><Icon name="Trash2" size={15} /></button>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </section>
      </div>
    </main>
  );
});
export const head: DocumentHead = { title: "論文 | PaperLens" };
