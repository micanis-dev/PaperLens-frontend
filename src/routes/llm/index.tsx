import {
  component$,
  $,
  noSerialize,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, type DocumentHead } from "@builder.io/qwik-city";
import { AppShell } from "~/components/app-shell";
import { Icon } from "~/components/icon";
import {
  supportedLanguages,
  isSupportedLanguage,
  type PaperDocument,
  type ProviderSettings,
  type Translation,
  type TranslationDraft,
  managedModels,
} from "~/lib/domain";
import {
  cancelManagedTranslation,
  checkManagedAccess,
  estimateTranslation,
  streamManagedTranslation,
  type TranslationRequest,
  type TranslationResult,
} from "~/lib/api";
import {
  generateTags,
  generateTranslation,
  getSessionProvider,
  rememberProviderSettings,
  testProvider,
  translateText,
} from "~/lib/llm";
import {
  getPaperFile,
  getSetting,
  listPapers,
  getTranslationDraft,
  removeTranslationDraft,
  savePaper,
  saveSetting,
  saveTranslationDraft,
  saveTranslation,
} from "~/lib/storage";
import { localize, useLocale } from "~/lib/i18n";

const defaultSettings: ProviderSettings = {
  mode: "local",
  model: "llama3.2",
  baseUrl: "http://127.0.0.1:11434/v1",
  targetLanguage: "ja",
  connected: false,
};

function activeProviderSettings(settings: ProviderSettings) {
  const session = getSessionProvider();
  if (!session || session.mode !== settings.mode) return settings;
  return { ...settings, apiKey: session.apiKey };
}

async function hashText(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requestKey(request: unknown) {
  return JSON.stringify(request);
}

const MAX_SELECTION_CHARS = 20_000;
const MAX_TRANSLATION_CHARS = 100_000;

export default component$(() => {
  const locale = useLocale();
  const t = (japanese: string, english: string) =>
    localize(locale.value, japanese, english);
  const settings = useSignal<ProviderSettings>(defaultSettings);
  const papers = useSignal<PaperDocument[]>([]);
  const selectedId = useSignal("");
  const candidates = useSignal<string[]>([]);
  const translation = useSignal("");
  const busy = useSignal("");
  const message = useSignal("");
  const basicTags = useSignal("");
  const scope = useSignal<"selection" | "page" | "range" | "all">("page");
  const pageNumber = useSignal(1);
  const endPage = useSignal(1);
  const selectedText = useSignal("");
  const estimate = useSignal<{
    inputTokens: number;
    estimatedOutputTokens: number;
    estimatedCredits: number;
    requestKey: string;
  }>();
  const managedSegments = useSignal<TranslationResult["segments"]>([]);
  const translationSegmentsValid = useSignal(false);
  const translationEdited = useSignal(false);
  const translationDirty = useSignal(false);
  const translationController = useSignal<AbortController>();
  const managedTranslationID = useSignal("");
  const draftKey = useSignal("");
  const tagGenerationKey = useSignal("");
  const tagCandidatePaperID = useSignal("");
  const resetDraft = $(() => {
    // A settings or scope change invalidates any in-flight result as well as
    // the visible draft. Aborting the fetch lets the managed SSE request
    // release its reservation through the request context.
    translationController.value?.abort();
    translationController.value = undefined;
    managedTranslationID.value = "";
    tagGenerationKey.value = "";
    tagCandidatePaperID.value = "";
    if (busy.value === "tags") busy.value = "";
    managedSegments.value = [];
    translationSegmentsValid.value = false;
    translationEdited.value = false;
    draftKey.value = "";
    translation.value = "";
    translationDirty.value = false;
    estimate.value = undefined;
    candidates.value = [];
  });
  const loadDraft = $(async (documentId: string) => {
    if (!documentId) return;
    let draft: TranslationDraft | undefined;
    try {
      draft = await getTranslationDraft(documentId);
    } catch {
      return;
    }
    if (
      !draft ||
      draft.documentId !== documentId ||
      draft.mode !== settings.value.mode ||
      draft.model !== settings.value.model ||
      draft.targetLanguage !== settings.value.targetLanguage ||
      !["selection", "page", "range", "all"].includes(draft.scope) ||
      !Number.isInteger(draft.pageNumber) ||
      !Number.isInteger(draft.endPage) ||
      !Array.isArray(draft.segments) ||
      !draft.segments.length
    )
      return;
    scope.value = draft.scope;
    pageNumber.value = draft.pageNumber;
    endPage.value = draft.endPage;
    selectedText.value = draft.selectedText || "";
    draftKey.value = draft.requestKey;
    managedSegments.value = draft.segments;
    translationSegmentsValid.value = true;
    translationEdited.value = false;
    translationDirty.value = true;
    translation.value = draft.segments
      .slice()
      .sort(
        (a, b) =>
          a.pageNumber - b.pageNumber || (a.sequence || 0) - (b.sequence || 0),
      )
      .map((segment) => segment.translatedText)
      .join("\n\n");
    message.value = "前回の部分結果を復元しました。翻訳生成から再開できます。";
  });
  const persistDraft = $(
    async (
      paperId: string,
      requestKeyValue: string,
      segments: TranslationDraft["segments"],
    ) => {
      if (
        !segments.length ||
        !translationSegmentsValid.value ||
        draftKey.value !== requestKeyValue
      )
        return;
      try {
        if (
          !translationSegmentsValid.value ||
          draftKey.value !== requestKeyValue
        )
          return;
        await saveTranslationDraft({
          documentId: paperId,
          requestKey: requestKeyValue,
          mode: settings.value.mode,
          model: settings.value.model,
          targetLanguage: settings.value.targetLanguage,
          scope: scope.value,
          pageNumber: pageNumber.value,
          endPage: endPage.value,
          selectedText: selectedText.value || undefined,
          segments,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // A read-only or quota-limited database must not interrupt streaming.
      }
    },
  );
  const confirmDiscardTranslation = $(() => {
    if (!translationDirty.value || !translation.value.trim()) return true;
    return window.confirm(
      locale.value === "en"
        ? "You have an unsaved translation. Changing this setting will discard it. Continue?"
        : "未保存の翻訳結果があります。変更すると結果を破棄します。続けますか？",
    );
  });
  useVisibleTask$(async () => {
    try {
      const [loadedPapers, loadedSettings, tags] = await Promise.all([
        listPapers(),
        getSetting("provider", defaultSettings),
        getSetting("basicTags", ""),
      ]);
      papers.value = loadedPapers;
      selectedId.value = loadedPapers[0]?.id || "";
      settings.value = loadedSettings;
      basicTags.value = tags;
      await loadDraft(selectedId.value);
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : "ローカル保存を利用できないためLLM画面を初期化できませんでした。";
    }
  });
  const saveSettings = $(async () => {
    if (busy.value) return;
    const previous = { ...settings.value };
    const withoutKey = { ...settings.value, connected: false };
    delete withoutKey.apiKey;
    delete withoutKey.checkedAt;
    busy.value = "save";
    settings.value = withoutKey;
    try {
      await saveSetting("provider", withoutKey);
      message.value =
        "設定を保存しました。APIキーは保存せず、このセッション中だけ使用します。接続確認を実行してください。";
    } catch (error) {
      const restored = { ...previous };
      delete restored.apiKey;
      settings.value = restored;
      const detail = error instanceof Error ? ` ${error.message}` : "";
      message.value = localize(
        locale.value,
        `設定を保存できませんでした。読み取り専用状態または保存容量を確認してください。${detail}`,
        `Could not save settings. Check whether browser storage is read-only or full.${detail}`,
      );
    } finally {
      busy.value = "";
    }
  });
  const connect = $(async () => {
    busy.value = "connect";
    const providerSettings = activeProviderSettings(settings.value);
    message.value =
      settings.value.mode === "paperlens-managed"
        ? "PaperLensアカウントを確認しています…"
        : "固定テキストで接続を確認しています…";
    try {
      if (providerSettings.mode === "paperlens-managed")
        await checkManagedAccess();
      else await testProvider(providerSettings);
      const checkedAt = new Date().toISOString();
      settings.value = {
        ...settings.value,
        apiKey: undefined,
        connected: true,
        checkedAt,
      };
      rememberProviderSettings({
        ...providerSettings,
        connected: true,
        checkedAt,
      });
      message.value =
        settings.value.mode === "paperlens-managed"
          ? "PaperLens管理LLMを利用できます。本文は見積もり承認後に送信します。"
          : "接続済みです。論文本文はまだ送信していません。";
    } catch (e) {
      settings.value = { ...settings.value, connected: false };
      message.value = e instanceof Error ? e.message : "接続に失敗しました";
    } finally {
      busy.value = "";
    }
  });
  const makeTags = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    const providerSettings = activeProviderSettings(settings.value);
    if (!paper || !settings.value.connected || busy.value) return;
    const tagPaper = {
      ...paper,
      tags: [
        ...new Set([
          ...basicTags.value
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          ...paper.tags,
        ]),
      ],
    };
    const generationKey = crypto.randomUUID();
    tagGenerationKey.value = generationKey;
    tagCandidatePaperID.value = "";
    candidates.value = [];
    busy.value = "tags";
    message.value = "タグ生成の対象本文を準備しています…";
    let file: Awaited<ReturnType<typeof getPaperFile>>;
    try {
      file = await getPaperFile(paper.id);
    } catch (error) {
      if (tagGenerationKey.value !== generationKey) return;
      tagGenerationKey.value = "";
      busy.value = "";
      message.value =
        error instanceof Error
          ? error.message
          : "タグ生成の対象本文を読み込めませんでした。";
      return;
    }
    const sourceText = Object.values(file?.textByPage || {}).join("\n");
    const sentSourceText = sourceText.slice(0, 18_000);
    const destination =
      providerSettings.mode === "openai"
        ? "https://api.openai.com/v1"
        : providerSettings.mode === "local" ||
            providerSettings.mode === "openai-compatible"
          ? providerSettings.baseUrl
          : providerSettings.mode;
    const preview = sentSourceText.replace(/\s+/g, " ").trim().slice(0, 240);
    if (
      !window.confirm(
        `送信先: ${destination}\n対象論文: ${paper.title || paper.fileName}\n対象本文: タイトル・要旨・PDF本文（${sentSourceText.length.toLocaleString()}文字）\n本文プレビュー: ${preview || "（本文なし）"}${sourceText.length > sentSourceText.length ? "\n※タグ生成へ送信する本文は18,000文字までです。" : ""}\n保存先: PaperLensローカルDBのタグ候補（採用操作後に保存）\nこの内容をタグ生成へ送信しますか？`,
      )
    ) {
      tagGenerationKey.value = "";
      busy.value = "";
      message.value = "タグ生成をキャンセルしました。";
      return;
    }
    if (tagGenerationKey.value !== generationKey) return;
    message.value = "タグ候補を生成しています…";
    try {
      const generated = await generateTags(providerSettings, tagPaper);
      if (tagGenerationKey.value !== generationKey) return;
      candidates.value = generated;
      tagCandidatePaperID.value = paper.id;
      message.value = "候補を確認して採用してください。";
    } catch (e) {
      if (tagGenerationKey.value !== generationKey) return;
      message.value = e instanceof Error ? e.message : "タグ生成に失敗しました";
    } finally {
      if (tagGenerationKey.value === generationKey) {
        tagGenerationKey.value = "";
        busy.value = "";
      }
    }
  });
  const acceptTags = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    if (
      !paper ||
      tagCandidatePaperID.value !== paper.id ||
      !candidates.value.length
    )
      return;
    const updated = {
      ...paper,
      tags: [...new Set([...paper.tags, ...candidates.value].filter(Boolean))],
      updatedAt: new Date().toISOString(),
    };
    try {
      await savePaper(updated);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      message.value = localize(
        locale.value,
        `タグを保存できませんでした。候補は保持していますので、再試行できます。${detail}`,
        `Could not save the tags. The candidates were kept so you can retry.${detail}`,
      );
      return;
    }
    papers.value = papers.value.map((item) =>
      item.id === paper.id ? updated : item,
    );
    candidates.value = [];
    tagCandidatePaperID.value = "";
    message.value = "タグを保存しました。";
  });
  const buildManagedRequests = $(
    async (paper: PaperDocument): Promise<TranslationRequest[]> => {
      const file = await getPaperFile(paper.id);
      const pages = Object.entries(file?.textByPage || {})
        .map(([page, text]) => ({ page: Number(page), text }))
        .filter((item) => item.text.trim())
        .sort((a, b) => a.page - b.page);
      let selected: { page: number; text: string }[];
      if (scope.value === "selection") {
        if (!Number.isInteger(pageNumber.value) || pageNumber.value < 1)
          throw new Error("元PDFのページ番号は1以上の整数で指定してください。");
        if (selectedText.value.length > MAX_SELECTION_CHARS)
          throw new Error(
            `選択範囲が上限（${MAX_SELECTION_CHARS.toLocaleString()}文字）を超えています。本文を分割して再試行してください。`,
          );
        selected = [{ page: pageNumber.value, text: selectedText.value }];
      } else if (scope.value === "page")
        selected = pages.filter((item) => item.page === pageNumber.value);
      else if (scope.value === "range") {
        selected = pages.filter(
          (item) =>
            item.page >= Math.min(pageNumber.value, endPage.value) &&
            item.page <= Math.max(pageNumber.value, endPage.value),
        );
        if (new Set(selected.map((item) => item.page)).size > 20)
          throw new Error(
            "ページ翻訳は最大20ページです。範囲を分割してください。",
          );
      } else selected = pages;
      const total = selected.reduce((sum, item) => sum + item.text.length, 0);
      const max = scope.value === "all" ? 500_000 : MAX_TRANSLATION_CHARS;
      if (!selected.length || !selected.some((item) => item.text.trim()))
        throw new Error("翻訳するテキストがありません。");
      if (total > max)
        throw new Error(
          `翻訳対象が上限（${max.toLocaleString()}文字）を超えています。範囲を分割してください。`,
        );
      const requests: TranslationRequest[] = [];
      for (let start = 0; start < selected.length; start += 500) {
        const batch = selected.slice(start, start + 500);
        const segments = await Promise.all(
          batch.map(async (item, order) => ({
            id: `${paper.id}:${item.page}:${start + order}`,
            pageNumber: item.page,
            order: start + order,
            text: item.text,
            textHash: await hashText(item.text),
          })),
        );
        requests.push({
          documentId: paper.id,
          sourceLanguage: "auto",
          targetLanguage: settings.value.targetLanguage,
          model: settings.value.model,
          segments,
          preserveFormatting: true,
        });
      }
      return requests;
    },
  );
  const estimateManaged = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    if (
      !paper ||
      settings.value.mode !== "paperlens-managed" ||
      !settings.value.connected
    )
      return;
    busy.value = "estimate";
    message.value = "送信前のクレジット見積もりを計算しています…";
    try {
      const requests = await buildManagedRequests(paper);
      const results = await Promise.all(
        requests.map((request) => estimateTranslation(request)),
      );
      const summary = results.reduce(
        (total, result) => ({
          inputTokens: total.inputTokens + result.estimate.inputTokens,
          estimatedOutputTokens:
            total.estimatedOutputTokens + result.estimate.estimatedOutputTokens,
          estimatedCredits:
            total.estimatedCredits + result.estimate.estimatedCredits,
        }),
        { inputTokens: 0, estimatedOutputTokens: 0, estimatedCredits: 0 },
      );
      estimate.value = {
        ...summary,
        requestKey: requestKey(
          requests.length === 1 ? requests[0] : { requests },
        ),
      };
      message.value = `見積もり: ${summary.estimatedCredits}クレジット${requests.length > 1 ? `（${requests.length}回に分割）` : ""}。内容を確認してから、もう一度「翻訳生成」を押してください。`;
    } catch (e) {
      message.value = e instanceof Error ? e.message : "見積もりに失敗しました";
    } finally {
      busy.value = "";
    }
  });
  const makeTranslation = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    const providerSettings = activeProviderSettings(settings.value);
    if (!paper || !settings.value.connected) return;
    if (!isSupportedLanguage(settings.value.targetLanguage)) {
      message.value = "対応していない翻訳先言語です。設定を確認してください。";
      return;
    }
    busy.value = "translation";
    const controller = new AbortController();
    translationController.value = noSerialize(controller);
    // Keep already received segments when a network interruption is retried.
    // Segment IDs are deterministic, so the retry sends only the missing
    // segments and does not duplicate completed local results.
    message.value =
      providerSettings.mode === "paperlens-managed"
        ? "管理LLMへ送信しています…"
        : "接続済みのLLMへ送信しています…";
    try {
      if (providerSettings.mode === "paperlens-managed") {
        const allRequests = await buildManagedRequests(paper);
        const fullRequestKey = requestKey(
          allRequests.length === 1 ? allRequests[0] : { requests: allRequests },
        );
        if (draftKey.value && draftKey.value !== fullRequestKey) {
          managedSegments.value = [];
          translationSegmentsValid.value = false;
          translation.value = "";
          await removeTranslationDraft(paper.id).catch(() => undefined);
        }
        draftKey.value = fullRequestKey;
        const completedIDs = new Set(
          managedSegments.value.map((segment) => segment.id),
        );
        const requests = allRequests
          .map((request) => ({
            ...request,
            segments: request.segments.filter(
              (segment) => !completedIDs.has(segment.id),
            ),
          }))
          .filter((request) => request.segments.length > 0);
        if (!requests.length) {
          translation.value = [...managedSegments.value]
            .sort(
              (a, b) =>
                a.pageNumber - b.pageNumber ||
                (a.sequence || 0) - (b.sequence || 0),
            )
            .map((segment) => segment.translatedText)
            .join("\n\n");
          translationSegmentsValid.value = managedSegments.value.length > 0;
          translationEdited.value = false;
          translationDirty.value = true;
          message.value =
            "受信済みの翻訳結果を表示しています。確認してから保存してください。";
          return;
        }
        const aggregateKey = requestKey(
          requests.length === 1 ? requests[0] : { requests },
        );
        if (!estimate.value || estimate.value.requestKey !== aggregateKey) {
          const results = await Promise.all(
            requests.map((request) => estimateTranslation(request)),
          );
          const summary = results.reduce(
            (total, result) => ({
              inputTokens: total.inputTokens + result.estimate.inputTokens,
              estimatedOutputTokens:
                total.estimatedOutputTokens +
                result.estimate.estimatedOutputTokens,
              estimatedCredits:
                total.estimatedCredits + result.estimate.estimatedCredits,
            }),
            { inputTokens: 0, estimatedOutputTokens: 0, estimatedCredits: 0 },
          );
          estimate.value = { ...summary, requestKey: aggregateKey };
          message.value = `見積もり: ${summary.estimatedCredits}クレジット${requests.length > 1 ? `（${requests.length}回に分割）` : ""}。内容を確認してから、もう一度「翻訳生成」を押してください。`;
          return;
        }
        if (
          !window.confirm(
            `送信先: PaperLens管理LLM\n対象: ${scope.value === "all" ? "論文全体" : scope.value === "range" ? `第${pageNumber.value}〜${endPage.value}ページ` : scope.value === "selection" ? "選択範囲" : `第${pageNumber.value}ページ`}\n見積もり: ${estimate.value.estimatedCredits}クレジット\nこの内容を送信しますか？`,
          )
        ) {
          message.value = "翻訳をキャンセルしました。";
          return;
        }
        for (let batchIndex = 0; batchIndex < requests.length; batchIndex++) {
          const request = requests[batchIndex];
          const key = await hashText(`${aggregateKey}:${batchIndex}`);
          const sourceByID = new Map(
            request.segments.map((segment) => [segment.id, segment.text]),
          );
          const result = await streamManagedTranslation(
            request,
            key,
            (event) => {
              if (event.type === "started")
                managedTranslationID.value = event.data.translationId;
              if (event.type === "segment") {
                managedSegments.value = [
                  ...managedSegments.value,
                  {
                    ...event.data,
                    sourceText: sourceByID.get(event.data.id),
                  },
                ];
                translationSegmentsValid.value = true;
                translationEdited.value = false;
                translation.value = [...managedSegments.value]
                  .sort(
                    (a, b) =>
                      a.pageNumber - b.pageNumber ||
                      (a.sequence || 0) - (b.sequence || 0),
                  )
                  .map((segment) => segment.translatedText)
                  .join("\n\n");
                translationDirty.value = true;
                void persistDraft(
                  paper.id,
                  draftKey.value,
                  managedSegments.value,
                );
                message.value = `翻訳中… ${managedSegments.value.length} / ${requests.reduce((total, item) => total + item.segments.length, 0)} セグメント`;
              } else if (event.type === "usage")
                message.value = `翻訳中… ${event.data.creditsUsed}クレジット使用`;
            },
            controller.signal,
          );
          if (result) {
            managedSegments.value = [
              ...managedSegments.value,
              ...result.segments
                .filter(
                  (segment) =>
                    !managedSegments.value.some(
                      (current) => current.id === segment.id,
                    ),
                )
                .map((segment) => ({
                  ...segment,
                  sourceText: sourceByID.get(segment.id),
                })),
            ];
            translationSegmentsValid.value = true;
            translationEdited.value = false;
            void persistDraft(paper.id, draftKey.value, managedSegments.value);
          }
        }
        translation.value = [...managedSegments.value]
          .sort(
            (a, b) =>
              a.pageNumber - b.pageNumber ||
              (a.sequence || 0) - (b.sequence || 0),
          )
          .map((segment) => segment.translatedText)
          .join("\n\n");
        translationSegmentsValid.value = managedSegments.value.length > 0;
        translationEdited.value = false;
        translationDirty.value = true;
        message.value = "翻訳結果を確認してから保存してください。";
      } else if (scope.value === "all") {
        const allRequests = await buildManagedRequests(paper);
        draftKey.value = requestKey(
          allRequests.length === 1 ? allRequests[0] : { requests: allRequests },
        );
        if (
          !window.confirm(
            `送信先: ${providerSettings.mode === "local" ? providerSettings.baseUrl : providerSettings.mode === "openai-compatible" ? providerSettings.baseUrl : providerSettings.mode}\n対象: 論文全体\nPaperLensクレジット: 消費しません\nこの内容を送信しますか？`,
          )
        ) {
          message.value = "翻訳をキャンセルしました。";
          return;
        }
        const generated = await generateTranslation(
          providerSettings,
          paper,
          (done, total, segment) => {
            if (segment) {
              if (!managedSegments.value.some((item) => item.id === segment.id))
                managedSegments.value = [...managedSegments.value, segment];
              translationSegmentsValid.value = true;
              translationEdited.value = false;
              translation.value = managedSegments.value
                .map((item) => item.translatedText)
                .join("\n\n");
              translationDirty.value = true;
              void persistDraft(
                paper.id,
                draftKey.value,
                managedSegments.value,
              );
            }
            message.value = `翻訳中… ${done} / ${total} ブロック`;
          },
          managedSegments.value,
          controller.signal,
        );
        translation.value = generated.markdown;
        translationDirty.value = true;
        managedSegments.value = generated.segments;
        translationSegmentsValid.value = generated.segments.length > 0;
        translationEdited.value = false;
        void persistDraft(paper.id, draftKey.value, managedSegments.value);
      } else {
        const file = await getPaperFile(paper.id);
        const pages = Object.entries(file?.textByPage || {})
          .map(([page, text]) => ({ page: Number(page), text }))
          .filter((item) => item.text.trim())
          .sort((a, b) => a.page - b.page);
        let selected: { page: number; text: string }[];
        if (scope.value === "selection") {
          if (!Number.isInteger(pageNumber.value) || pageNumber.value < 1)
            throw new Error(
              "元PDFのページ番号は1以上の整数で指定してください。",
            );
          if (selectedText.value.length > MAX_SELECTION_CHARS)
            throw new Error(
              `選択範囲が上限（${MAX_SELECTION_CHARS.toLocaleString()}文字）を超えています。本文を分割して再試行してください。`,
            );
          selected = [{ page: pageNumber.value, text: selectedText.value }];
        } else if (scope.value === "range") {
          selected = pages.filter(
            (item) =>
              item.page >= Math.min(pageNumber.value, endPage.value) &&
              item.page <= Math.max(pageNumber.value, endPage.value),
          );
          if (new Set(selected.map((item) => item.page)).size > 20)
            throw new Error(
              "ページ翻訳は最大20ページです。範囲を分割してください。",
            );
        } else
          selected = pages.filter((item) => item.page === pageNumber.value);
        if (!selected.length || !selected.some((item) => item.text.trim()))
          throw new Error("翻訳するテキストがありません。");
        if (
          selected.reduce((total, item) => total + item.text.length, 0) >
          MAX_TRANSLATION_CHARS
        )
          throw new Error(
            `翻訳対象が上限（${MAX_TRANSLATION_CHARS.toLocaleString()}文字）を超えています。範囲を分割してください。`,
          );
        if (
          !window.confirm(
            `送信先: ${providerSettings.mode === "local" ? providerSettings.baseUrl : providerSettings.mode === "openai-compatible" ? providerSettings.baseUrl : providerSettings.mode}\n対象: ${scope.value === "range" ? `第${pageNumber.value}〜${endPage.value}ページ` : scope.value === "selection" ? "選択範囲" : `第${pageNumber.value}ページ`}\nPaperLensクレジット: 消費しません\nこの内容を送信しますか？`,
          )
        ) {
          message.value = "翻訳をキャンセルしました。";
          return;
        }
        const completedIDs = new Set(
          managedSegments.value.map((segment) => segment.id),
        );
        const directRequests = await buildManagedRequests(paper);
        draftKey.value = requestKey(
          directRequests.length === 1
            ? directRequests[0]
            : { requests: directRequests },
        );
        const translatedSegments: TranslationResult["segments"] = [
          ...managedSegments.value,
        ];
        for (let index = 0; index < selected.length; index++) {
          const item = selected[index];
          const segmentID = `${paper.id}:${item.page}:${scope.value === "range" ? "direct" : "direct"}:${index}`;
          if (completedIDs.has(segmentID)) continue;
          controller.signal.throwIfAborted();
          const translatedText = await translateText(
            providerSettings,
            item.text,
            controller.signal,
          );
          translatedSegments.push({
            id: segmentID,
            pageNumber: item.page,
            translatedText,
            sourceTextHash: await hashText(item.text),
            sourceText: item.text,
          });
          managedSegments.value = [...translatedSegments];
          translationSegmentsValid.value = true;
          translationEdited.value = false;
          translation.value = translatedSegments
            .map((segment) => segment.translatedText)
            .join("\n\n");
          translationDirty.value = true;
          void persistDraft(paper.id, draftKey.value, managedSegments.value);
          message.value = `翻訳中… ${index + 1} / ${selected.length} ページ`;
        }
        managedSegments.value = translatedSegments;
        translationSegmentsValid.value = translatedSegments.length > 0;
        translationEdited.value = false;
        void persistDraft(paper.id, draftKey.value, managedSegments.value);
        translation.value = translatedSegments
          .map((segment) => segment.translatedText)
          .join("\n\n");
        translationDirty.value = true;
      }
    } catch (e) {
      message.value =
        e instanceof DOMException && e.name === "AbortError"
          ? "翻訳をキャンセルしました。受信済みの部分結果を確認・保存できます。"
          : managedSegments.value.length
            ? "接続が切れました。受信済みの部分結果を確認・保存できます。"
            : e instanceof Error
              ? e.message
              : "翻訳生成に失敗しました";
    } finally {
      translationController.value = undefined;
      managedTranslationID.value = "";
      busy.value = "";
    }
  });
  const cancelTranslation = $(async () => {
    const id = managedTranslationID.value;
    if (id) {
      try {
        await cancelManagedTranslation(id);
      } catch {
        /* aborting the stream still releases the reservation */
      }
    }
    translationController.value?.abort();
  });
  const saveGeneratedTranslation = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    if (!paper || !translation.value || !translationDirty.value || busy.value)
      return;
    busy.value = "save";
    try {
      const item: Translation = {
        id: crypto.randomUUID(),
        documentId: paper.id,
        language: settings.value.targetLanguage,
        markdown: translation.value,
        source: "llm",
        updatedAt: new Date().toISOString(),
        revision: 1,
        segments:
          translationSegmentsValid.value && managedSegments.value.length
            ? managedSegments.value
            : undefined,
      };
      await saveTranslation(item);
      await removeTranslationDraft(paper.id).catch(() => undefined);
      draftKey.value = "";
      translationDirty.value = false;
      message.value =
        "翻訳をローカルへ保存しました。論文詳細から編集できます。";
    } catch (error) {
      message.value =
        error instanceof Error
          ? `保存できませんでした：${error.message}`
          : "翻訳を保存できませんでした。";
    } finally {
      busy.value = "";
    }
  });
  const selectedPaper = papers.value.find(
    (paper) => paper.id === selectedId.value,
  );
  const targetLanguageLabel =
    supportedLanguages.find(
      ([code]) => code === settings.value.targetLanguage,
    )?.[1] || settings.value.targetLanguage;
  const scopeLabel =
    scope.value === "all"
      ? t("論文全体", "Whole paper")
      : scope.value === "range"
        ? t(
            `第${pageNumber.value}〜${endPage.value}ページ`,
            `Pages ${pageNumber.value}–${endPage.value}`,
          )
        : scope.value === "selection"
          ? t("選択範囲", "Selected text")
          : t(`第${pageNumber.value}ページ`, `Page ${pageNumber.value}`);
  const destinationLabel =
    settings.value.mode === "paperlens-managed"
      ? t("PaperLens管理LLM", "PaperLens managed LLM")
      : settings.value.mode === "local"
        ? t("ローカルLLM", "Local LLM")
        : settings.value.mode === "openai-compatible"
          ? t("OpenAI互換API", "OpenAI-compatible API")
          : settings.value.mode === "openai"
            ? "OpenAI"
            : settings.value.mode === "google"
              ? "Google"
              : "Anthropic";
  const modelLabel =
    managedModels.find((model) => model.id === settings.value.model)?.label ||
    settings.value.model;
  return (
    <AppShell>
      <section class="llm-workspace">
        <header class="llm-workspace-heading">
          <div>
            <p class="llm-eyebrow">PAPERLENS / LLM</p>
            <h1>
              {t(
                "原文を読み、翻訳を確かめる",
                "Read and review your translation",
              )}
            </h1>
            <p>
              {t(
                "対象と送信先を確認して翻訳し、結果をこの端末に保存します。",
                "Check the source and destination, then review and save on this device.",
              )}
            </p>
          </div>
          <span class="llm-status">
            {settings.value.connected
              ? t("接続確認済み", "Connection verified")
              : t("未接続", "Not connected")}
          </span>
        </header>
        <div class="llm-context form-layout">
          <div>
            {" "}
            <label>
              {t("対象論文", "Paper")}
              <select
                value={selectedId.value}
                onChange$={async (_, el) => {
                  if (!(await confirmDiscardTranslation())) return;
                  selectedId.value = el.value;
                  void resetDraft();
                  void loadDraft(el.value);
                }}
                disabled={!papers.value.length || !!busy.value}
              >
                <option value="">
                  {t("選択してください", "Select a paper")}
                </option>
                {papers.value.map((paper) => (
                  <option key={paper.id} value={paper.id}>
                    {paper.title || paper.fileName}
                  </option>
                ))}
              </select>
              {!papers.value.length && (
                <span class="mt-2 block text-xs font-normal text-amber-700">
                  {t(
                    "先にライブラリへ論文を追加してください。",
                    "Add a paper to your library first.",
                  )}
                </span>
              )}
            </label>
          </div>
          <div>
            <span class="llm-field-label">
              {t("送信先 / モデル", "Destination / model")}
            </span>
            <strong>{destinationLabel}</strong>
            <span>{modelLabel}</span>
            {(settings.value.mode === "local" ||
              settings.value.mode === "openai-compatible") && (
              <span class="llm-endpoint">{settings.value.baseUrl}</span>
            )}
            <a href="#llm-connection" class="accent">
              {t("接続設定", "Connection settings")} ↓
            </a>
          </div>
          <div>
            <span class="llm-field-label">
              {t("翻訳範囲", "Translation scope")}
            </span>
            <strong>
              {scopeLabel}
              {scope.value === "selection" ? ` · p. ${pageNumber.value}` : ""}
            </strong>
            <span>{targetLanguageLabel}</span>
            <span>{t("保存先：この端末", "Saved on this device")}</span>
          </div>
        </div>
        <details id="llm-connection" class="llm-disclosure">
          <summary>
            <span>{t("接続設定", "Connection settings")}</span>
            <span class="llm-disclosure-hint">
              {destinationLabel} ·{" "}
              {settings.value.connected
                ? t("確認済み", "Verified")
                : t("未接続・設定を開く", "Not connected · configure")}
            </span>
          </summary>
          <div class="form-layout llm-disclosure-body">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div class="llm-section-kicker">
                  <h2 class="font-bold">{t("LLMを接続", "Connect an LLM")}</h2>
                </div>
                <p class="mt-2 text-sm leading-6 text-slate-500">
                  {t(
                    "使うLLMと接続先を設定し、接続確認が成功すると生成操作が有効になります。",
                    "Choose a provider and endpoint. Generation becomes available after a successful connection test.",
                  )}
                </p>
              </div>
              <span
                class={`llm-status border px-3 py-1 text-xs font-semibold ${settings.value.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
                aria-label={t("LLM接続状態", "LLM connection status")}
              >
                {settings.value.connected
                  ? t("接続済み", "Connected")
                  : t("未接続", "Not connected")}
              </span>
            </div>
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
              <label>
                {t("接続モード", "Connection mode")}
                <select
                  value={settings.value.mode}
                  disabled={!!busy.value}
                  onChange$={async (_, el) => {
                    if (!(await confirmDiscardTranslation())) return;
                    const mode = el.value as ProviderSettings["mode"];
                    const endpoint =
                      mode === "local"
                        ? "http://127.0.0.1:11434/v1"
                        : mode === "openai-compatible"
                          ? settings.value.baseUrl
                          : "";
                    settings.value = {
                      ...settings.value,
                      mode,
                      connected: false,
                      apiKey:
                        mode === "paperlens-managed"
                          ? undefined
                          : settings.value.apiKey,
                      baseUrl: endpoint,
                      model:
                        mode === "paperlens-managed"
                          ? "gpt-5.6-terra"
                          : settings.value.model,
                    };
                    estimate.value = undefined;
                    void resetDraft();
                  }}
                >
                  <option value="paperlens-managed">PaperLens管理LLM</option>
                  <option value="local">Local OpenAI-compatible</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
              <label>
                {t("モデル名", "Model")}
                {settings.value.mode === "paperlens-managed" ? (
                  <select
                    value={settings.value.model}
                    disabled={!!busy.value}
                    onChange$={async (_, el) => {
                      if (!(await confirmDiscardTranslation())) return;
                      settings.value = {
                        ...settings.value,
                        model: el.value,
                        connected: false,
                      };
                      void resetDraft();
                    }}
                  >
                    {managedModels.map((model) => (
                      <option value={model.id} key={model.id}>
                        {`${model.label}（${model.credits} / 入力1k＋出力1k）`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={settings.value.model}
                    disabled={!!busy.value}
                    onInput$={(_, el) => {
                      settings.value = {
                        ...settings.value,
                        model: el.value,
                        connected: false,
                      };
                      estimate.value = undefined;
                    }}
                    onBlur$={async () => {
                      if (await confirmDiscardTranslation()) void resetDraft();
                    }}
                  />
                )}
              </label>
              {(settings.value.mode === "local" ||
                settings.value.mode === "openai-compatible") && (
                <label class="sm:col-span-2">
                  Base URL
                  <input
                    value={settings.value.baseUrl}
                    disabled={!!busy.value}
                    onInput$={(_, el) => {
                      settings.value = {
                        ...settings.value,
                        baseUrl: el.value,
                        connected: false,
                      };
                      estimate.value = undefined;
                    }}
                    onBlur$={async () => {
                      if (await confirmDiscardTranslation()) void resetDraft();
                    }}
                  />
                  <span class="text-xs font-normal text-slate-400">
                    {t(
                      "HTTPS、localhost、またはプライベートネットワークのみ",
                      "HTTPS, localhost, or a private network only",
                    )}
                  </span>
                </label>
              )}
              {settings.value.mode !== "paperlens-managed" && (
                <label>
                  {t("APIキー（保存しない）", "API key (never saved)")}
                  <input
                    type="password"
                    autoComplete="off"
                    value={getSessionProvider()?.apiKey || ""}
                    disabled={!!busy.value}
                    onInput$={(_, el) => {
                      rememberProviderSettings({
                        ...settings.value,
                        apiKey: el.value,
                      });
                      settings.value = {
                        ...settings.value,
                        apiKey: undefined,
                        connected: false,
                      };
                    }}
                  />
                </label>
              )}
            </div>
            <div class="llm-connection-note mt-5">
              <Icon
                name={
                  settings.value.mode === "paperlens-managed"
                    ? "Check"
                    : "Sparkles"
                }
                size={17}
              />
              <p>
                {settings.value.mode === "paperlens-managed"
                  ? t(
                      "PaperLens管理LLM：本文は見積もり計算のためPaperLens APIへ送信されます。管理LLMへの翻訳送信は確認・承認後です。利用にはログインとクレジットが必要です。",
                      "PaperLens managed LLM: paper text is sent to the PaperLens API to calculate an estimate. It is sent to the managed LLM only after you review and approve. Login and credits are required.",
                    )
                  : settings.value.mode === "local"
                    ? t(
                        "ローカルLLM：本文は指定したlocalhostまたはローカルネットワークの接続先へ送信されます。",
                        "Local LLM: text is sent to the configured localhost or local-network endpoint.",
                      )
                    : t(
                        "自前API：本文は選択したプロバイダーへ送信されます。APIキーは保存しません。",
                        "Your API: paper text is sent to the selected provider. Your API key is never saved.",
                      )}
              </p>
            </div>
            <div class="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                class="button"
                disabled={!!busy.value}
                onClick$={saveSettings}
              >
                <Icon name="Save" size={16} />
                {t("設定を保存", "Save settings")}
              </button>
              <button
                type="button"
                class="button"
                disabled={busy.value === "connect"}
                onClick$={connect}
              >
                <Icon name="RefreshCw" size={16} />
                {busy.value === "connect"
                  ? t("確認中…", "Checking…")
                  : t("接続確認", "Test connection")}
              </button>
              {settings.value.mode === "paperlens-managed" &&
                !settings.value.connected && (
                  <Link href="/login/" class="button subtle">
                    {t("ログインが必要です", "Login required")}
                  </Link>
                )}
            </div>
          </div>
        </details>

        <div class="llm-scope-controls form-layout">
          <label>
            {t("対象範囲", "Scope")}
            <select
              value={scope.value}
              disabled={!!busy.value}
              onChange$={async (_, el) => {
                if (!(await confirmDiscardTranslation())) return;
                scope.value = el.value as typeof scope.value;
                void resetDraft();
              }}
            >
              <option value="selection">{t("選択範囲", "Selection")}</option>
              <option value="page">{t("現在ページ", "Current page")}</option>
              <option value="range">{t("ページ範囲", "Page range")}</option>
              <option value="all">{t("論文全体", "Whole paper")}</option>
            </select>
          </label>
          {scope.value !== "all" && (
            <label>
              {scope.value === "selection"
                ? t("元PDFページ", "Source PDF page")
                : t("開始ページ", "Start page")}
              <input
                type="number"
                min={1}
                step={1}
                value={pageNumber.value}
                disabled={!!busy.value}
                onChange$={async (_, el) => {
                  if (!(await confirmDiscardTranslation())) return;
                  const value = Number(el.value);
                  pageNumber.value =
                    Number.isInteger(value) && value >= 1 ? value : 1;
                  void resetDraft();
                }}
              />
            </label>
          )}
          {scope.value === "range" && (
            <label>
              {t("終了ページ", "End page")}
              <input
                type="number"
                min={1}
                value={endPage.value}
                disabled={!!busy.value}
                onChange$={async (_, el) => {
                  if (!(await confirmDiscardTranslation())) return;
                  endPage.value = Number(el.value) || 1;
                  void resetDraft();
                }}
              />
            </label>
          )}
          <label>
            {t("翻訳先言語", "Target language")}
            <select
              value={settings.value.targetLanguage}
              disabled={!!busy.value}
              onChange$={async (_, el) => {
                if (!(await confirmDiscardTranslation())) return;
                settings.value = {
                  ...settings.value,
                  targetLanguage: el.value,
                };
                estimate.value = undefined;
                void resetDraft();
              }}
            >
              {supportedLanguages.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div class="llm-comparison">
          <section class="llm-source-pane" aria-labelledby="llm-source-heading">
            <header class="llm-pane-heading">
              <div>
                <p class="llm-eyebrow">SOURCE</p>
                <h2 id="llm-source-heading">{t("原文", "Source text")}</h2>
              </div>
              {selectedPaper && (
                <a
                  class="button"
                  href={`/papers/${selectedPaper.id}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("原文PDFを開く ↗", "Open source PDF ↗")}
                </a>
              )}
            </header>
            {scope.value === "selection" && (
              <label class="llm-selection-input">
                {t(
                  "PDFからコピーした選択範囲",
                  "Selected text copied from PDF",
                )}
                <textarea
                  rows={12}
                  value={selectedText.value}
                  disabled={!!busy.value}
                  onInput$={(_, el) => {
                    selectedText.value = el.value;
                    estimate.value = undefined;
                  }}
                  onBlur$={async () => {
                    if (await confirmDiscardTranslation()) void resetDraft();
                  }}
                  placeholder={t(
                    "PDF本文の選択範囲を貼り付けます（最大20,000文字）",
                    "Paste selected PDF text (up to 20,000 characters)",
                  )}
                />
                <span class="mt-2 block text-xs font-normal text-slate-500">
                  {selectedText.value.length.toLocaleString()} /{" "}
                  {MAX_SELECTION_CHARS.toLocaleString()}{" "}
                  {t("文字", "characters")}
                </span>
                {selectedText.value.length > MAX_SELECTION_CHARS && (
                  <span
                    class="mt-1 block text-xs font-normal text-red-700"
                    role="alert"
                  >
                    {t(
                      "上限を超えています。翻訳開始前に本文を分割してください。",
                      "This is over the limit. Split the text before starting translation.",
                    )}
                  </span>
                )}
              </label>
            )}

            {scope.value !== "selection" &&
              (managedSegments.value.some((segment) => segment.sourceText) ? (
                <div class="llm-source-text">
                  {managedSegments.value
                    .filter((segment) => segment.sourceText)
                    .map((segment) => (
                      <article key={segment.id}>
                        <span class="llm-field-label">
                          {t("元PDF", "Source PDF")} · p. {segment.pageNumber}
                        </span>
                        <p>{segment.sourceText}</p>
                      </article>
                    ))}
                </div>
              ) : (
                <div class="llm-empty">
                  <span class="llm-empty-mark">01</span>
                  <h3>
                    {t("原文を手元に、内容を確認", "Keep the source in view")}
                  </h3>
                  <p>
                    {t(
                      "原文PDFを開いて対象ページを確認してください。翻訳の受信後、この欄に取得済みの原文を表示します。",
                      "Open the source PDF to check your pages. Available source text appears here as translation results arrive.",
                    )}
                  </p>
                  {!selectedPaper && (
                    <a class="accent" href="/upload/">
                      {t("PDFを追加する", "Add a PDF")} →
                    </a>
                  )}
                </div>
              ))}
          </section>
          <section class="llm-result-pane" aria-labelledby="llm-result-heading">
            <header class="llm-pane-heading">
              <div>
                <p class="llm-eyebrow">TRANSLATION</p>
                <h2 id="llm-result-heading">
                  {t("翻訳を確認", "Review translation")}
                </h2>
              </div>
              <span class="llm-result-state">
                {busy.value === "translation"
                  ? t("翻訳中", "Translating")
                  : translation.value
                    ? translationDirty.value
                      ? t("未保存", "Unsaved")
                      : t("保存済み", "Saved")
                    : t("結果待ち", "Awaiting result")}
              </span>
            </header>
            <label class="llm-field-label" for="llm-result">
              {targetLanguageLabel} · {t("Markdown編集", "Markdown editor")}
            </label>
            <textarea
              id="llm-result"
              class="llm-result-editor"
              value={translation.value}
              disabled={!!busy.value}
              onInput$={(_, el) => {
                const hadSegments =
                  translationSegmentsValid.value &&
                  managedSegments.value.length > 0;
                translation.value = el.value;
                translationDirty.value = true;
                translationEdited.value = true;
                translationSegmentsValid.value = false;
                managedSegments.value = [];
                draftKey.value = "";
                if (hadSegments || selectedId.value)
                  void removeTranslationDraft(selectedId.value).catch(
                    () => undefined,
                  );
              }}
              placeholder={t(
                "翻訳結果がここに表示されます。確認・編集してから保存してください。",
                "Translation appears here. Review and edit it before saving.",
              )}
            />
            {translationEdited.value && (
              <p class="mt-2 text-xs text-amber-700">
                {t(
                  "本文を編集したため、保存時はMarkdown本文のみを保存し、生成時の段落データは破棄します。",
                  "The text was edited. Saving will keep the Markdown only and discard generated segment data.",
                )}
              </p>
            )}
          </section>
        </div>
        <footer class="llm-action-area">
          <div class="llm-action-summary">
            <div>
              <span class="llm-field-label">{t("費用", "Cost")}</span>
              <strong>
                {settings.value.mode === "paperlens-managed"
                  ? estimate.value
                    ? `${estimate.value.estimatedCredits} ${t("クレジット（見積もり）", "credits (estimated)")}`
                    : t("見積もりが必要です", "Estimate required")
                  : t("PaperLensクレジット消費なし", "No PaperLens credits")}
              </strong>
            </div>
            <div>
              <span class="llm-field-label">
                {t("保存先", "Save destination")}
              </span>
              <span>
                {t("この端末のローカルDB", "Local database on this device")}
              </span>
            </div>
          </div>
          <p class="llm-send-note">
            {settings.value.mode === "paperlens-managed"
              ? t(
                  "見積もりでは対象本文をPaperLens APIへ送ります。管理LLMへの送信は確認・承認後です。",
                  "Estimating sends the selected text to the PaperLens API. Sending to the managed LLM requires approval.",
                )
              : settings.value.mode === "local"
                ? t(
                    "本文は指定したlocalhostまたはLANのLLMへ送信します。",
                    "Text is sent to the configured localhost or LAN endpoint.",
                  )
                : t(
                    "本文は選択したAPIへ直接送信します。Providerの利用料金は別途発生します。",
                    "Text is sent directly to the selected API. Provider charges apply separately.",
                  )}
          </p>
          <div class="llm-translation-actions">
            {settings.value.mode === "paperlens-managed" && (
              <button
                type="button"
                class={
                  !estimate.value && !translationDirty.value
                    ? "button primary"
                    : "button"
                }
                disabled={
                  !settings.value.connected || !selectedId.value || !!busy.value
                }
                onClick$={estimateManaged}
              >
                {busy.value === "estimate"
                  ? t("計算中…", "Calculating…")
                  : estimate.value
                    ? t("再見積もり", "Recalculate")
                    : t("本文を送って見積もる", "Send text for estimate")}
              </button>
            )}
            {busy.value === "translation" && (
              <button
                type="button"
                class="button text-red-700"
                onClick$={cancelTranslation}
              >
                {t("キャンセル", "Cancel")}
              </button>
            )}
            {(settings.value.mode !== "paperlens-managed" ||
              estimate.value ||
              busy.value === "translation") && (
              <button
                type="button"
                class={
                  translation.value.trim() && translationDirty.value
                    ? "button"
                    : "button primary"
                }
                disabled={
                  !settings.value.connected || !selectedId.value || !!busy.value
                }
                onClick$={makeTranslation}
              >
                <Icon name="Sparkles" size={16} />
                {busy.value === "translation"
                  ? t("生成中…", "Generating…")
                  : settings.value.mode === "paperlens-managed" &&
                      estimate.value
                    ? t("確認して送信", "Approve & send")
                    : t("翻訳を開始", "Start translation")}
              </button>
            )}
            <button
              type="button"
              class={
                translation.value.trim() && translationDirty.value
                  ? "button primary"
                  : "button"
              }
              disabled={
                !translation.value.trim() ||
                !translationDirty.value ||
                !!busy.value
              }
              onClick$={saveGeneratedTranslation}
            >
              <Icon name="Save" size={16} />
              {busy.value === "save"
                ? t("保存中…", "Saving…")
                : translationDirty.value
                  ? t("確認して保存", "Review and save")
                  : translation.value.trim()
                    ? t("保存済み", "Saved")
                    : t("結果を保存", "Save result")}
            </button>
          </div>

          {!settings.value.connected && (
            <p class="llm-disabled-note mt-4">
              {t(
                "「接続設定」を開き、接続確認を完了してください。",
                "Open connection settings and verify your connection.",
              )}
            </p>
          )}
          {settings.value.connected && !selectedId.value && (
            <p class="llm-disabled-note mt-4">
              {t(
                "生成するには、対象論文を選択してください。",
                "Select a paper before generating.",
              )}
            </p>
          )}
          {estimate.value && settings.value.mode === "paperlens-managed" && (
            <p class="mt-4 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm text-sky-900">
              {t("クレジット見積もり", "Credit estimate")}:{" "}
              {estimate.value.estimatedCredits} {t("クレジット", "credits")}（
              {t("入力", "input")} {estimate.value.inputTokens.toLocaleString()}{" "}
              / {t("出力見込み", "estimated output")}{" "}
              {estimate.value.estimatedOutputTokens.toLocaleString()}{" "}
              {t("トークン", "tokens")}）
            </p>
          )}

          <p class="llm-feedback" role="status">
            {message.value ||
              t(
                "対象・接続先・範囲を確認して開始してください。",
                "Check your paper, destination and scope to begin.",
              )}
          </p>
        </footer>
        <details class="llm-disclosure llm-tags">
          <summary>
            <span>{t("タグ整理", "Organize tags")}</span>
            <span class="llm-disclosure-hint">
              {t(
                "必要なときに、論文の分類を整える",
                "Organize your paper when needed",
              )}
            </span>
          </summary>
          <div class="llm-disclosure-body form-layout">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="llm-section-kicker">
                  <h2 class="font-bold">
                    {t("タグ候補を整理", "Organize tags")}
                  </h2>
                </div>
                <p class="mt-2 text-sm leading-6 text-slate-500">
                  {t(
                    "候補を選び、採用するタグを論文に保存します。",
                    "Choose suggestions to save as tags for this paper.",
                  )}
                </p>
              </div>
              <button
                type="button"
                class="button"
                disabled={
                  settings.value.mode === "paperlens-managed" ||
                  !settings.value.connected ||
                  !selectedId.value ||
                  !!busy.value
                }
                onClick$={makeTags}
              >
                <Icon name="Sparkles" size={16} />
                {t("生成", "Generate")}
              </button>
            </div>
            {settings.value.mode === "paperlens-managed" && (
              <p class="llm-disabled-note mt-4">
                {t(
                  "タグ候補は自前API・ローカルLLM接続時に利用できます。管理LLMでは本文をタグ生成へ送信しません。",
                  "Tag suggestions are available with your own or local provider. The managed LLM does not receive paper text for tagging.",
                )}
              </p>
            )}
            <label>
              {t("基本タグ（カンマ区切り）", "Base tags (comma-separated)")}
              <input
                value={basicTags.value}
                placeholder="NLP, HCI, systems"
                disabled={!!busy.value}
                onInput$={(_, el) => (basicTags.value = el.value)}
                onBlur$={() => saveSetting("basicTags", basicTags.value)}
              />
            </label>
            <div class="mt-5 flex min-h-32 flex-wrap content-start gap-2 border border-dashed border-slate-300 p-4">
              {candidates.value.length ? (
                candidates.value.map((tag, index) => (
                  <label
                    key={`${tag}-${index}`}
                    class="inline-flex items-center gap-2 border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-900"
                  >
                    <input
                      type="checkbox"
                      checked={true}
                      onChange$={(event) => {
                        if (!(event.target as HTMLInputElement).checked)
                          candidates.value = candidates.value.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          );
                      }}
                    />
                    {tag}
                  </label>
                ))
              ) : (
                <span class="text-sm text-slate-400">
                  {t(
                    "生成結果がここに表示されます。",
                    "Suggestions will appear here.",
                  )}
                </span>
              )}
            </div>
            <button
              type="button"
              class="button mt-4"
              disabled={!candidates.value.length}
              onClick$={acceptTags}
            >
              {t("採用して論文へ保存", "Apply tags to paper")}
            </button>
          </div>
        </details>
      </section>
    </AppShell>
  );
});
export const head: DocumentHead = { title: "LLM操作 | PaperLens" };
