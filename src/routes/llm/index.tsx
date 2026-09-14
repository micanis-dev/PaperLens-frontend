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
  const translationController = useSignal<AbortController>();
  const managedTranslationID = useSignal("");
  const draftKey = useSignal("");
  const resetDraft = $(() => {
    // A settings or scope change invalidates any in-flight result as well as
    // the visible draft. Aborting the fetch lets the managed SSE request
    // release its reservation through the request context.
    translationController.value?.abort();
    translationController.value = undefined;
    managedTranslationID.value = "";
    managedSegments.value = [];
    draftKey.value = "";
    translation.value = "";
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
      if (!segments.length) return;
      try {
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
    const withoutKey = { ...settings.value };
    delete withoutKey.apiKey;
    settings.value = { ...settings.value, connected: false };
    await saveSetting("provider", withoutKey);
    message.value =
      "設定を保存しました。APIキーは保存せず、このセッション中だけ使用します。接続確認を実行してください。";
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
    if (!paper || !settings.value.connected) return;
    busy.value = "tags";
    message.value = "タグ候補を生成しています…";
    try {
      candidates.value = await generateTags(providerSettings, {
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
      });
      message.value = "候補を確認して採用してください。";
    } catch (e) {
      message.value = e instanceof Error ? e.message : "タグ生成に失敗しました";
    } finally {
      busy.value = "";
    }
  });
  const acceptTags = $(async () => {
    const paper = papers.value.find((item) => item.id === selectedId.value);
    if (!paper) return;
    const updated = {
      ...paper,
      tags: [...new Set([...paper.tags, ...candidates.value].filter(Boolean))],
      updatedAt: new Date().toISOString(),
    };
    await savePaper(updated);
    papers.value = papers.value.map((item) =>
      item.id === paper.id ? updated : item,
    );
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
      if (scope.value === "selection")
        selected = [
          { page: pageNumber.value, text: selectedText.value.slice(0, 20_000) },
        ];
      else if (scope.value === "page")
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
      const max = scope.value === "all" ? 500_000 : 100_000;
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
                translation.value = [...managedSegments.value]
                  .sort(
                    (a, b) =>
                      a.pageNumber - b.pageNumber ||
                      (a.sequence || 0) - (b.sequence || 0),
                  )
                  .map((segment) => segment.translatedText)
                  .join("\n\n");
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
              translation.value = managedSegments.value
                .map((item) => item.translatedText)
                .join("\n\n");
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
        managedSegments.value = generated.segments;
        void persistDraft(paper.id, draftKey.value, managedSegments.value);
      } else {
        const file = await getPaperFile(paper.id);
        const pages = Object.entries(file?.textByPage || {})
          .map(([page, text]) => ({ page: Number(page), text }))
          .filter((item) => item.text.trim())
          .sort((a, b) => a.page - b.page);
        let selected: { page: number; text: string }[];
        if (scope.value === "selection")
          selected = [
            {
              page: pageNumber.value,
              text: selectedText.value.slice(0, 20_000),
            },
          ];
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
        } else
          selected = pages.filter((item) => item.page === pageNumber.value);
        if (!selected.length || !selected.some((item) => item.text.trim()))
          throw new Error("翻訳するテキストがありません。");
        if (
          selected.reduce((total, item) => total + item.text.length, 0) >
          100_000
        )
          throw new Error("翻訳対象は100,000文字以内にしてください。");
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
          translation.value = translatedSegments
            .map((segment) => segment.translatedText)
            .join("\n\n");
          void persistDraft(paper.id, draftKey.value, managedSegments.value);
          message.value = `翻訳中… ${index + 1} / ${selected.length} ページ`;
        }
        managedSegments.value = translatedSegments;
        void persistDraft(paper.id, draftKey.value, managedSegments.value);
        translation.value = translatedSegments
          .map((segment) => segment.translatedText)
          .join("\n\n");
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
    if (!paper || !translation.value) return;
    const item: Translation = {
      id: crypto.randomUUID(),
      documentId: paper.id,
      language: settings.value.targetLanguage,
      markdown: translation.value,
      source: "llm",
      updatedAt: new Date().toISOString(),
      revision: 1,
      segments: managedSegments.value.length
        ? managedSegments.value
        : undefined,
    };
    await saveTranslation(item);
    await removeTranslationDraft(paper.id).catch(() => undefined);
    draftKey.value = "";
    message.value = "翻訳をローカルへ保存しました。論文詳細から編集できます。";
  });
  return (
    <AppShell>
      <section class="app-page max-w-5xl space-y-8">
        <div class="page-heading">
          <h1 class="text-3xl font-bold tracking-[-0.04em]">
            {t("LLM操作", "LLM workspace")}
          </h1>
        </div>
        <section class="form-layout border border-slate-200 bg-white p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <h2 class="font-bold">{t("接続状態", "Connection status")}</h2>
            <span
              class={`border px-3 py-1 text-xs font-semibold ${settings.value.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
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
                onChange$={(_, el) => {
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
              <input
                value={settings.value.model}
                onInput$={(_, el) => {
                  settings.value = {
                    ...settings.value,
                    model: el.value,
                    connected: false,
                  };
                  void resetDraft();
                }}
              />
            </label>
            {(settings.value.mode === "local" ||
              settings.value.mode === "openai-compatible") && (
              <label class="sm:col-span-2">
                Base URL
                <input
                  value={settings.value.baseUrl}
                  onInput$={(_, el) => {
                    settings.value = {
                      ...settings.value,
                      baseUrl: el.value,
                      connected: false,
                    };
                    void resetDraft();
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
                {t(
                  "APIキー（任意・保存しない）",
                  "API key (optional, never saved)",
                )}
                <input
                  type="password"
                  autoComplete="off"
                  value={getSessionProvider()?.apiKey || ""}
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
            <label>
              {t("翻訳先言語", "Target language")}
              <select
                value={settings.value.targetLanguage}
                onChange$={(_, el) => {
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
          <div class="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" class="button" onClick$={saveSettings}>
              <Icon name="Save" size={16} />
              {t("設定を保存", "Save settings")}
            </button>
            <button
              type="button"
              class="button primary"
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
        </section>
        <p
          class="border-l-2 border-sky-400 bg-sky-50 p-4 text-sm leading-6 text-sky-900"
          role="status"
        >
          {message.value ||
            t(
              "接続後に生成操作を利用できます。",
              "Generation is available after connecting.",
            )}
        </p>
        <section class="form-layout border border-slate-200 bg-white p-6">
          <div class="grid gap-4 sm:grid-cols-2">
            <label>
              {t("対象論文", "Paper")}
              <select
                value={selectedId.value}
                onChange$={(_, el) => {
                  selectedId.value = el.value;
                  void resetDraft();
                  void loadDraft(el.value);
                }}
                disabled={!papers.value.length}
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
            </label>
            <label>
              {t("基本タグ（カンマ区切り）", "Base tags (comma-separated)")}
              <input
                value={basicTags.value}
                placeholder="NLP, HCI, systems"
                onInput$={(_, el) => (basicTags.value = el.value)}
                onBlur$={() => saveSetting("basicTags", basicTags.value)}
              />
            </label>
          </div>
        </section>
        <div class="grid gap-6 lg:grid-cols-2">
          <section class="border border-slate-200 bg-white p-6">
            <div class="flex items-center justify-between">
              <h2 class="font-bold">{t("タグ候補", "Tag suggestions")}</h2>
              <button
                type="button"
                class="button primary"
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
            <div class="mt-5 flex min-h-32 flex-wrap content-start gap-2 border border-dashed border-slate-300 p-4">
              {candidates.value.length ? (
                candidates.value.map((tag, index) => (
                  <label
                    key={`${tag}-${index}`}
                    class="flex-row items-center gap-2 border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-900"
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
          </section>
          <section class="border border-slate-200 bg-white p-6">
            <div class="flex items-center justify-between gap-3">
              <h2 class="font-bold">{t("本文翻訳", "Translate paper")}</h2>
              <div class="flex gap-2">
                {settings.value.mode === "paperlens-managed" && (
                  <button
                    type="button"
                    class="button"
                    disabled={
                      !settings.value.connected ||
                      !selectedId.value ||
                      !!busy.value
                    }
                    onClick$={estimateManaged}
                  >
                    {t("見積もり", "Estimate")}
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
                <button
                  type="button"
                  class="button primary"
                  disabled={
                    !settings.value.connected ||
                    !selectedId.value ||
                    !!busy.value
                  }
                  onClick$={makeTranslation}
                >
                  <Icon name="Sparkles" size={16} />
                  {busy.value === "translation"
                    ? t("生成中…", "Generating…")
                    : t("翻訳生成", "Generate translation")}
                </button>
              </div>
            </div>
            {estimate.value && settings.value.mode === "paperlens-managed" && (
              <p class="mt-4 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm text-sky-900">
                {t("送信前見積もり", "Preflight estimate")}:{" "}
                {estimate.value.estimatedCredits} {t("クレジット", "credits")}（
                {t("入力", "input")}{" "}
                {estimate.value.inputTokens.toLocaleString()} /{" "}
                {t("出力見込み", "estimated output")}{" "}
                {estimate.value.estimatedOutputTokens.toLocaleString()}{" "}
                {t("トークン", "tokens")}）
              </p>
            )}
            <div class="mt-5 grid gap-3 sm:grid-cols-3">
              <label>
                {t("対象範囲", "Scope")}
                <select
                  value={scope.value}
                  onChange$={(_, el) => {
                    scope.value = el.value as typeof scope.value;
                    void resetDraft();
                  }}
                >
                  <option value="selection">
                    {t("選択範囲", "Selection")}
                  </option>
                  <option value="page">
                    {t("現在ページ", "Current page")}
                  </option>
                  <option value="range">{t("ページ範囲", "Page range")}</option>
                  <option value="all">{t("論文全体", "Whole paper")}</option>
                </select>
              </label>
              {scope.value !== "selection" && (
                <label>
                  {t("開始ページ", "Start page")}
                  <input
                    type="number"
                    min={1}
                    value={pageNumber.value}
                    onInput$={(_, el) => {
                      pageNumber.value = Number(el.value) || 1;
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
                    onInput$={(_, el) => {
                      endPage.value = Number(el.value) || 1;
                      void resetDraft();
                    }}
                  />
                </label>
              )}
            </div>
            {scope.value === "selection" && (
              <label class="mt-3">
                {t(
                  "PDFからコピーした選択範囲",
                  "Selected text copied from PDF",
                )}
                <textarea
                  rows={5}
                  value={selectedText.value}
                  onInput$={(_, el) => {
                    selectedText.value = el.value;
                    void resetDraft();
                  }}
                  placeholder={t(
                    "PDF本文の選択範囲を貼り付けます（最大20,000文字）",
                    "Paste selected PDF text (up to 20,000 characters)",
                  )}
                />
              </label>
            )}
            <textarea
              class="mt-3 min-h-64 w-full font-mono text-sm"
              value={translation.value}
              onInput$={(_, el) => (translation.value = el.value)}
              placeholder={t(
                "生成結果のプレビュー",
                "Generated result preview",
              )}
            />
            <button
              type="button"
              class="button mt-4"
              disabled={!translation.value.trim()}
              onClick$={saveGeneratedTranslation}
            >
              <Icon name="Save" size={16} />
              {t("確認して保存", "Review and save")}
            </button>
          </section>
        </div>
      </section>
    </AppShell>
  );
});
export const head: DocumentHead = { title: "LLM操作 | PaperLens" };
