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
  clearLocalData,
  getPaperLensDB,
  getSetting,
  isStorageReadOnly,
  listPapers,
  savePaperBundles,
  saveSetting,
} from "~/lib/storage";
import { exportBackupZip, importBackupZip, inspectBackupZip } from "~/lib/backup";
import {
  checkManagedAccess,
  cancelAccountDeletion,
  apiBaseURL,
  getAccount,
  getLinkedIdentities,
  logoutManagedSession,
  requestAccountDeletion,
  unlinkIdentity,
  type AccountDeletion,
  type LinkedIdentity,
} from "~/lib/api";
import {
  getSessionProvider,
  rememberProviderSettings,
  testProvider,
  validateProviderUrl,
} from "~/lib/llm";
import {
  managedModels,
  paperDocumentSchema,
  providerFamilyForMode,
  type ProviderSettings,
} from "~/lib/domain";
import { localize, useLocale } from "~/lib/i18n";

const defaultProvider: ProviderSettings = {
  mode: "local",
  model: "",
  baseUrl: "http://127.0.0.1:11434/v1",
  targetLanguage: "ja",
  connected: false,
};

function normalizeStoredProvider(provider: ProviderSettings): ProviderSettings {
  // Remove the old built-in local default, but never overwrite a connected
  // user's explicit model choice.
  if (!provider.connected && provider.model === "llama3.2") {
    return { ...provider, model: "" };
  }
  return provider;
}

type ConnectionErrors = {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

export default component$(() => {
  const locale = useLocale();
  const t = (japanese: string, english: string) =>
    localize(locale.value, japanese, english);
  const language = useSignal("ja");
  const viewMode = useSignal<"continuous" | "single">("continuous");
  const storageInfo = useSignal("確認中…");
  const storageState = useSignal<"checking" | "ready" | "unavailable">(
    "checking",
  );
  const message = useSignal("");
  const authMessage = useSignal("");
  const importInput = useSignal<HTMLInputElement>();
  const exportController = useSignal<AbortController>();
  const exportProgress = useSignal(0);
  const importBusy = useSignal(false);
  const deletion = useSignal<AccountDeletion>();
  const accountState = useSignal<"unknown" | "signed-out" | "ready">("unknown");
  const accountError = useSignal("");
  const deletionBusy = useSignal(false);
  const linkedIdentities = useSignal<LinkedIdentity[]>([]);
  const identityBusy = useSignal("");
  const provider = useSignal<ProviderSettings>(defaultProvider);
  const apiKey = useSignal("");
  const connectionErrors = useSignal<ConnectionErrors>({});
  const connectionBusy = useSignal(false);
  const connectionMessage = useSignal("");
  const connectionFailed = useSignal(false);
  // Settings depend on browser storage and the current browser session.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    try {
      const [savedLanguage, savedViewMode, savedProvider] = await Promise.all([
        getSetting<string>("uiLanguage", "ja"),
        getSetting<"continuous" | "single">("viewMode", "continuous"),
        getSetting("provider", defaultProvider),
      ]);
      language.value = savedLanguage;
      viewMode.value = savedViewMode;
      provider.value = normalizeStoredProvider(savedProvider);
      apiKey.value = getSessionProvider()?.apiKey || "";
    } catch {
      storageState.value = "unavailable";
      storageInfo.value = "このブラウザでは端末内保存を利用できません";
      return;
    }
    try {
      await getPaperLensDB();
      storageState.value = isStorageReadOnly() ? "unavailable" : "ready";
    } catch {
      storageState.value = "unavailable";
      storageInfo.value = "このブラウザでは端末内保存を利用できません";
      return;
    }
    if (!navigator.storage?.estimate)
      storageInfo.value = "このブラウザでは使用量を取得できません";
    else {
      const estimate = await navigator.storage.estimate();
      const ratio = estimate.quota ? (estimate.usage || 0) / estimate.quota : 0;
      storageInfo.value = `${Math.round((estimate.usage || 0) / 1024 / 1024)}MB / ${estimate.quota ? `${Math.round(estimate.quota / 1024 / 1024)}MB` : "上限不明"}${isStorageReadOnly() ? " · 読み取り専用" : ratio >= 0.95 ? " · 空き容量がありません" : ratio >= 0.8 ? " · 空き容量が少なくなっています" : ""}`;
    }
    try {
      const response = await getAccount();
      deletion.value = response.deletion;
      accountState.value = "ready";
      linkedIdentities.value = (await getLinkedIdentities()).identities;
    } catch (error) {
      if (error instanceof Error && "details" in error && (error as { details?: { code?: string } }).details?.code === "unauthorized") accountState.value = "signed-out";
      else { accountState.value = "unknown"; accountError.value = error instanceof Error ? error.message : "アカウント情報を取得できませんでした"; }
    }
  });
  const updateProvider = $((patch: Partial<ProviderSettings>) => {
    provider.value = { ...provider.value, ...patch, connected: false };
    // Any endpoint/model change invalidates the in-memory verified session.
    // The reader must not continue sending with credentials for an older
    // configuration while the user is editing these fields.
    rememberProviderSettings({ ...provider.value, apiKey: undefined, connected: false });
    connectionErrors.value = {};
    connectionMessage.value = "";
  });
  const connectProvider = $(async () => {
    if (connectionBusy.value) return;
    const errors: ConnectionErrors = {};
    const model = provider.value.model.trim();
    if (!model)
      errors.model = localize(
        locale.value,
        "モデルを入力してください",
        "Enter a model",
      );
    else if (model.length > 200)
      errors.model = localize(
        locale.value,
        "200文字以内で入力してください",
        "Use 200 characters or fewer",
      );

    let baseUrl = provider.value.baseUrl.trim();
    if (
      provider.value.mode === "local" ||
      provider.value.mode === "openai-compatible"
    ) {
      if (!baseUrl)
        errors.baseUrl = localize(
          locale.value,
          "接続先を入力してください",
          "Enter an endpoint",
        );
      else {
        try {
          baseUrl = validateProviderUrl(
            baseUrl,
            provider.value.mode === "local",
          );
        } catch (error) {
          errors.baseUrl =
            error instanceof Error
              ? error.message
              : localize(
                  locale.value,
                  "接続先を確認してください",
                  "Check the endpoint",
                );
        }
      }
    }
    if (
      ["openai", "google", "anthropic"].includes(provider.value.mode) &&
      !apiKey.value.trim()
    )
      errors.apiKey = localize(
        locale.value,
        "APIキーを入力してください",
        "Enter an API key",
      );

    connectionErrors.value = errors;
    if (Object.keys(errors).length) {
      connectionFailed.value = true;
      connectionMessage.value = localize(
        locale.value,
        "入力内容を確認してください。",
        "Check the highlighted fields.",
      );
      return;
    }

    connectionBusy.value = true;
    connectionFailed.value = false;
    connectionMessage.value = localize(
      locale.value,
      "接続を確認しています…",
      "Checking connection…",
    );
    const candidate: ProviderSettings = {
      ...provider.value,
      model,
      baseUrl,
      apiKey: apiKey.value.trim() || undefined,
      connected: true,
    };
    try {
      if (candidate.mode === "paperlens-managed") await checkManagedAccess();
      else {
        let timeout: number | undefined;
        try {
          await Promise.race([
            testProvider(candidate),
            new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error(localize(locale.value, "接続確認がタイムアウトしました。", "Connection check timed out."))), 15_000); }),
          ]);
        } finally { if (timeout) window.clearTimeout(timeout); }
      }
      provider.value = { ...candidate, apiKey: undefined };
      rememberProviderSettings(candidate);
      const canReconnectWithoutSecret =
        candidate.mode === "paperlens-managed" ||
        candidate.mode === "local" ||
        (candidate.mode === "openai-compatible" && !candidate.apiKey);
      await saveSetting("provider", {
        ...candidate,
        apiKey: undefined,
        connected: canReconnectWithoutSecret,
      });
      connectionMessage.value = localize(
        locale.value,
        "接続できました。PDFリーダーで翻訳を利用できます。",
        "Connected. Translation is ready in the PDF reader.",
      );
    } catch (error) {
      provider.value = { ...provider.value, connected: false };
      connectionFailed.value = true;
      connectionMessage.value =
        error instanceof Error
          ? error.message
          : localize(
              locale.value,
              "接続できませんでした。",
              "Could not connect.",
            );
    } finally {
      connectionBusy.value = false;
    }
  });
  const unlinkSSO = $(async (provider: LinkedIdentity["provider"]) => {
    if (!window.confirm(`${provider}のSSO連携を解除しますか？`)) return;
    identityBusy.value = provider;
    try {
      await unlinkIdentity(provider);
      linkedIdentities.value = linkedIdentities.value.filter(
        (item) => item.provider !== provider,
      );
      authMessage.value = `${provider}のSSO連携を解除しました。`;
    } catch (error) {
      authMessage.value =
        error instanceof Error
          ? error.message
          : "SSO連携を解除できませんでした";
    } finally {
      identityBusy.value = "";
    }
  });
  const save = $(async () => {
    try {
      await Promise.all([
        saveSetting("uiLanguage", language.value),
        saveSetting("viewMode", viewMode.value),
        saveSetting("provider", {
          ...provider.value,
          apiKey: undefined,
          // A key-backed provider cannot be restored as connected after a
          // reload because secrets intentionally remain session-only.
          connected:
            provider.value.connected &&
            (provider.value.mode === "paperlens-managed" ||
              provider.value.mode === "local" ||
              (provider.value.mode === "openai-compatible" && !getSessionProvider()?.apiKey)),
        }),
      ]);
      locale.value = language.value === "en" ? "en" : "ja";
      document.documentElement.lang = locale.value;
      message.value =
        locale.value === "en" ? "Settings saved." : "設定を保存しました。";
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : locale.value === "en"
            ? "Could not save settings."
            : "設定を保存できませんでした";
    }
  });
  const exportData = $(async () => {
    const papers = await listPapers();
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      papers,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `paperlens-library-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.value =
      "メタデータをエクスポートしました。PDF本体は論文ごとの元ファイルとして管理されます。";
  });
  const exportZip = $(async () => {
    const controller = new AbortController();
    exportController.value = noSerialize(controller);
    exportProgress.value = 0;
    try {
      const url = URL.createObjectURL(
        await exportBackupZip({
          signal: controller.signal,
          onProgress: (completed, total) => {
            exportProgress.value = total
              ? Math.round((completed / total) * 100)
              : 0;
          },
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `paperlens-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      message.value =
        "PDF・抽出本文・メタデータ・翻訳・注釈をZIPにエクスポートしました。";
    } catch (e) {
      message.value =
        e instanceof DOMException && e.name === "AbortError"
          ? "ZIPエクスポートをキャンセルしました"
          : e instanceof Error
            ? e.message
            : "ZIPエクスポートに失敗しました";
    } finally {
      exportController.value = undefined;
      exportProgress.value = 0;
    }
  });
  const cancelExport = $(() => exportController.value?.abort());
  const importData = $(async (file: File) => {
    const isZip = file.name.toLowerCase().endsWith(".zip");
    importBusy.value = true;
    try {
      if (isZip) {
        const preview = await inspectBackupZip(file);
        const existingIDs = new Set((await listPapers()).map((paper) => paper.id));
        const overwriteCount = preview.ids.filter((id) => existingIDs.has(id)).length;
        const addCount = preview.count - overwriteCount;
        const sample = preview.titles.slice(0, 3).join("、");
        if (!window.confirm(`${file.name}を復元しますか？追加 ${addCount}件・上書き ${overwriteCount}件。${sample ? `対象: ${sample}${preview.count > 3 ? "…" : ""}。` : ""}既存の同じIDの論文情報は上書きされます。`)) return;
        const count = await importBackupZip(file);
        message.value = `${count}件の論文をPDF・メタデータごと復元しました。`;
        return;
      }
      const parsed = JSON.parse(await file.text()) as {
        schemaVersion?: number;
        papers?: unknown[];
      };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.papers))
        throw new Error("PaperLensのバックアップ形式ではありません。");
      if (parsed.papers.length > 5_000)
        throw new Error("バックアップ内の論文数が上限を超えています。");
      const existingIDs = new Set((await listPapers()).map((paper) => paper.id));
      const overwriteCount = parsed.papers.filter((candidate) => {
        const result = paperDocumentSchema.safeParse(candidate);
        return result.success && existingIDs.has(result.data.id);
      }).length;
      const addCount = parsed.papers.length - overwriteCount;
      if (!window.confirm(`${file.name}を復元しますか？追加 ${addCount}件・上書き ${overwriteCount}件。既存の同じIDの論文情報は置き換わります。`)) return;
      const bundles = parsed.papers.map((candidate) => {
        const result = paperDocumentSchema.safeParse(candidate);
        if (!result.success)
          throw new Error("バックアップ内の論文メタデータが不正です。");
        return { paper: result.data, annotations: [], translations: [] };
      });
      await savePaperBundles(bundles);
      message.value = `${parsed.papers.length}件のメタデータを復元しました。PDF本体は元ファイルを再登録してください。`;
    } catch (e) {
      message.value =
        e instanceof Error ? e.message : "インポートに失敗しました";
    } finally {
      importBusy.value = false;
    }
  });
  const clearData = $(async () => {
    if (
      !window.confirm(
        "この端末のライブラリ、PDF、翻訳、注釈、設定をすべて削除しますか？この操作は元に戻せません。バックアップを先に作成してください。",
      )
    )
      return;
    try {
      await clearLocalData();
      storageInfo.value = "0MB";
      provider.value = defaultProvider;
      linkedIdentities.value = [];
      deletion.value = undefined;
      message.value = "ローカルデータを削除しました。";
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : "ローカルデータを削除できませんでした";
    }
  });
  const logout = $(async () => {
    try {
      await logoutManagedSession();
      accountState.value = "signed-out";
      linkedIdentities.value = [];
      deletion.value = undefined;
      authMessage.value =
        "ログアウトしました。ローカルライブラリはそのまま利用できます。";
    } catch (error) {
      authMessage.value =
        error instanceof Error ? error.message : "ログアウトできませんでした";
    }
  });
  const requestDeletion = $(async () => {
    if (
      !window.confirm(
        "アカウントとサーバー上の課金・使用量データを削除予約しますか？24時間以内なら取り消せます。端末内のPDFは削除されません。",
      )
    )
      return;
    deletionBusy.value = true;
    try {
      deletion.value = (await requestAccountDeletion()).deletion;
      authMessage.value = "削除を予約しました。";
    } catch (error) {
      authMessage.value =
        error instanceof Error
          ? error.message
          : "削除予約にはログインし直してください。";
    } finally {
      deletionBusy.value = false;
    }
  });
  const cancelDeletion = $(async () => {
    deletionBusy.value = true;
    try {
      await cancelAccountDeletion();
      deletion.value = undefined;
      authMessage.value = "アカウント削除を取り消しました。";
    } catch (error) {
      authMessage.value =
        error instanceof Error
          ? error.message
          : "アカウント削除を取り消せませんでした";
    } finally {
      deletionBusy.value = false;
    }
  });
  return (
    <AppShell>
      <section class="app-page max-w-4xl space-y-8">
        <div class="page-heading">
          <h1 class="text-3xl font-bold tracking-[-0.04em]">
            {t("設定", "Settings")}
          </h1>
        </div>
        <section class="form-layout border border-slate-200 bg-white p-6">
          <h2 class="font-bold">{t("表示", "Display")}</h2>
          <div class="mt-5 grid gap-5 sm:grid-cols-2">
            <label>
              {t("表示言語", "Language")}
              <select
                value={language.value}
                onChange$={(_, el) => (language.value = el.value)}
              >
                <option value="ja">日本語</option>
                <option value="en">English</option>
              </select>
            </label>
            <label>
              {t("既定のPDF表示", "Default PDF view")}
              <select
                value={viewMode.value}
                onChange$={(_, el) =>
                  (viewMode.value = el.value as typeof viewMode.value)
                }
              >
                <option value="continuous">
                  {t("連続スクロール", "Continuous scroll")}
                </option>
                <option value="single">{t("単ページ", "Single page")}</option>
              </select>
            </label>
          </div>
        </section>
        <section class="border border-slate-200 bg-white p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="font-bold">
                {t("端末内のデータ", "Data on this device")}
              </h2>
              <p class="mt-2 text-sm text-slate-500">
                {t(
                  "PDFとメモはこの端末に保存されます。",
                  "PDFs and notes are stored on this device.",
                )}
              </p>
            </div>
            <span
              class={`border px-2.5 py-1 text-xs font-bold ${storageState.value === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : storageState.value === "unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}
            >
              {storageState.value === "ready"
                ? t("利用できます", "Available")
                : storageState.value === "unavailable"
                  ? isStorageReadOnly()
                    ? t("読み取り専用", "Read-only")
                    : t("利用できません", "Unavailable")
                  : t("確認中…", "Checking…")}
            </span>
          </div>
          <div class="mt-5 border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p>
              {t("使用量", "Used")}: {storageInfo.value}
            </p>
          </div>
        </section>
        <section
          id="ai-connection"
          class="form-layout scroll-mt-6 border border-slate-200 bg-white p-6"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="font-bold">{t("LLM接続", "LLM connection")}</h2>
              <p class="mt-2 text-sm text-slate-500">
                {t(
                  "まず利用先を選び、接続確認後にPDFリーダーから利用できます。",
                  "Choose where to run the LLM first, then connect before using it in the PDF reader.",
                )}
              </p>
            </div>
            <span
              class={`inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-bold ${provider.value.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}
              role="status"
            >
              <span
                class={`size-2 ${provider.value.connected ? "bg-emerald-500" : "bg-amber-400"}`}
                aria-hidden="true"
              />
              {provider.value.connected
                ? t("接続済み", "Connected")
                : t("未接続", "Not connected")}
            </span>
          </div>
          <div class="mt-5 grid gap-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <p class="mb-2 text-sm font-semibold text-slate-800">
                {t("利用先", "LLM destination")}
              </p>
              <div class="grid gap-3 md:grid-cols-3" role="group" aria-label={t("LLM利用先", "LLM destination")}>
                {([
                  {
                    family: "paperlens" as const,
                    label: "PaperLens LLM",
                    description: t("PaperLensへ送信 · クレジットを使用", "Sent to PaperLens · uses credits"),
                    mode: "paperlens-managed" as const,
                  },
                  {
                    family: "user-api" as const,
                    label: "User LLM (API)",
                    description: t("選択したAPIへ直接送信 · 自分のキーを使用", "Sent directly to your API · uses your key"),
                    mode: "openai" as const,
                  },
                  {
                    family: "user-local" as const,
                    label: "User LLM (Local)",
                    description: t("端末内で実行 · 外部クラウドへ送信しない", "Runs locally · not sent to a cloud service"),
                    mode: "local" as const,
                  },
                ] as const).map((item) => {
                  const selected = providerFamilyForMode(provider.value.mode) === item.family;
                  return (
                    <button
                      key={item.family}
                      type="button"
                      class={`border p-4 text-left transition-colors ${selected ? "border-sky-500 bg-sky-50 ring-1 ring-sky-500" : "border-slate-200 bg-white hover:border-slate-400"}`}
                      aria-pressed={selected}
                      disabled={connectionBusy.value}
                      onClick$={() => {
                        updateProvider({
                          mode:
                            item.family === "user-api" && providerFamilyForMode(provider.value.mode) === "user-api"
                              ? provider.value.mode
                              : item.mode,
                          model:
                            item.family === "paperlens"
                              ? "gpt-5.6-terra"
                              : providerFamilyForMode(provider.value.mode) === item.family
                                ? provider.value.model
                                : "",
                          baseUrl:
                            item.family === "user-local"
                              ? "http://127.0.0.1:11434/v1"
                              : provider.value.baseUrl,
                        });
                      }}
                    >
                      <span class="block text-sm font-bold text-slate-950">{item.label}</span>
                      <span class="mt-1 block text-xs leading-5 text-slate-500">{item.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {providerFamilyForMode(provider.value.mode) === "user-api" && (
              <label>
                {t("APIプロバイダー", "API provider")}
                <select
                  value={provider.value.mode}
                  disabled={connectionBusy.value}
                  onChange$={(_, el) =>
                    updateProvider({
                      mode: el.value as ProviderSettings["mode"],
                      model: "",
                    })
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </label>
            )}
            <label>
              {providerFamilyForMode(provider.value.mode) === "paperlens"
                ? t("モデル", "Model")
                : t("モデル名（必須）", "Model name (required)")}
              {provider.value.mode === "paperlens-managed" ? (
                <select
                  value={provider.value.model}
                  disabled={connectionBusy.value}
                  onChange$={(_, el) => updateProvider({ model: el.value })}
                >
                  {managedModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={provider.value.model}
                  maxLength={200}
                  required
                  disabled={connectionBusy.value}
                  class={
                    connectionErrors.value.model
                      ? "border-red-400 bg-red-50"
                      : !provider.value.model.trim()
                        ? "border-amber-400 bg-amber-50"
                        : undefined
                  }
                  aria-invalid={
                    connectionErrors.value.model ? "true" : undefined
                  }
                  aria-describedby={
                    connectionErrors.value.model ? "ai-model-error" : undefined
                  }
                  onInput$={(_, el) => updateProvider({ model: el.value })}
                />
              )}
              {connectionErrors.value.model ? (
                <span
                  id="ai-model-error"
                  class="mt-1 block text-xs font-normal text-red-700"
                  role="alert"
                >
                  {connectionErrors.value.model}
                </span>
              ) : providerFamilyForMode(provider.value.mode) !== "paperlens" &&
                !provider.value.model.trim() ? (
                <span class="mt-1 block text-xs font-normal text-amber-700">
                  {t(
                    "接続先のモデル名を入力してください。",
                    "Enter the model name supported by this endpoint.",
                  )}
                </span>
              ) : null}
            </label>
            {(providerFamilyForMode(provider.value.mode) === "user-local" ||
              provider.value.mode === "openai-compatible") && (
              <label class="sm:col-span-2">
                {t("接続先", "Endpoint")}
                <input
                  inputMode="url"
                  value={provider.value.baseUrl}
                  disabled={connectionBusy.value}
                  aria-invalid={
                    connectionErrors.value.baseUrl ? "true" : undefined
                  }
                  aria-describedby={
                    connectionErrors.value.baseUrl ? "ai-url-error" : undefined
                  }
                  onInput$={(_, el) => updateProvider({ baseUrl: el.value })}
                />
                {connectionErrors.value.baseUrl ? (
                  <span
                    id="ai-url-error"
                    class="mt-1 block text-xs font-normal text-red-700"
                    role="alert"
                  >
                    {connectionErrors.value.baseUrl}
                  </span>
                ) : (
                  <span class="mt-1 block text-xs font-normal text-slate-500">
                    {t(
                      "この端末または信頼できるHTTPS接続先を指定してください。",
                      "Use an endpoint on this device or a trusted HTTPS endpoint.",
                    )}
                  </span>
                )}
              </label>
            )}
            {providerFamilyForMode(provider.value.mode) === "user-api" && (
                <label class="sm:col-span-2">
                  {t(
                    "APIキー（このセッションのみ）",
                    "API key (this session only)",
                  )}
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey.value}
                    disabled={connectionBusy.value}
                    aria-invalid={
                      connectionErrors.value.apiKey ? "true" : undefined
                    }
                    aria-describedby={
                      connectionErrors.value.apiKey ? "ai-key-error" : undefined
                    }
                    onInput$={(_, el) => {
                      apiKey.value = el.value;
                      updateProvider({});
                    }}
                  />
                  {connectionErrors.value.apiKey && (
                    <span
                      id="ai-key-error"
                      class="mt-1 block text-xs font-normal text-red-700"
                      role="alert"
                    >
                      {connectionErrors.value.apiKey}
                    </span>
                  )}
                </label>
              )}
          </div>
          <div class="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              class="button primary"
              disabled={connectionBusy.value}
              onClick$={connectProvider}
            >
              <Icon
                name={provider.value.connected ? "Check" : "RefreshCw"}
                size={16}
              />
              {connectionBusy.value
                ? t("確認中…", "Checking…")
                : t("接続を確認", "Check connection")}
            </button>
            {provider.value.mode === "paperlens-managed" && (
              <Link href="/login/" class="button subtle">
                {t("アカウントを確認", "Check account")}
              </Link>
            )}
          </div>
          {connectionMessage.value && (
            <p
              class={`mt-4 border-l-2 p-3 text-sm ${connectionFailed.value ? "border-red-400 bg-red-50 text-red-800" : "border-emerald-400 bg-emerald-50 text-emerald-800"}`}
              role={connectionFailed.value ? "alert" : "status"}
            >
              {connectionMessage.value}
            </p>
          )}
        </section>
        <section class="flex flex-wrap items-center justify-between gap-4 border border-slate-200 bg-white p-6">
          <div>
            <h2 class="font-bold">
              {t("PaperLensアカウント", "PaperLens account")}
            </h2>
            {authMessage.value && (
              <p class="mt-2 text-sm text-sky-700" role="status">
                {authMessage.value}
              </p>
            )}
            {accountError.value && <p class="mt-2 text-sm text-red-700" role="alert">{accountError.value}</p>}
          </div>
          {accountState.value === "ready" ? (
            <button type="button" class="button" onClick$={logout}>
              {t("ログアウト", "Log out")}
            </button>
          ) : accountState.value === "signed-out" ? (
              <Link href="/login/?returnTo=%2Fsettings%2F" class="button primary">
              {t("ログイン", "Log in")}
            </Link>
          ) : accountError.value ? (
            <button type="button" class="button text-red-700" onClick$={() => window.location.reload()}>{t("再試行", "Retry")}</button>
          ) : (
            <span class="text-sm text-slate-400" role="status">
              {t("確認中…", "Checking…")}
            </span>
          )}
        </section>
        {accountState.value === "ready" && (
          <section class="border border-slate-200 bg-white p-6">
            <h2 class="font-bold">{t("ログイン方法", "Sign-in methods")}</h2>
            <p class="mt-2 text-sm leading-6 text-slate-500">
              {t(
                "メールアドレス・パスワードを基本に、SSOを追加・解除できます。SSO連携には同じメールアドレスの確認が必要です。",
                "Use email and password as the primary method, and add or remove SSO providers. SSO linking requires the same verified email address.",
              )}
            </p>
            <div class="mt-5 grid gap-3 sm:grid-cols-3">
              {(["apple", "google", "github"] as const).map((provider) => {
                const linked = linkedIdentities.value.some(
                  (item) => item.provider === provider,
                );
                return linked ? (
                  <button
                    key={provider}
                    type="button"
                    class="button"
                    disabled={identityBusy.value === provider}
                    onClick$={() => unlinkSSO(provider)}
                  >
                    {identityBusy.value === provider
                      ? "…"
                      : `${provider} · ${t("解除", "Unlink")}`}
                  </button>
                ) : (
                  <a
                    key={provider}
                    class="button subtle text-center"
                    href={`${apiBaseURL}/v1/auth/link/${provider}`}
                  >
                    {provider} · {t("連携", "Link")}
                  </a>
                );
              })}
            </div>
          </section>
        )}
        {accountState.value === "ready" && (
          <section class="border border-red-200 bg-white p-6">
            <h2 class="font-bold text-red-800">
              {t("アカウント削除", "Delete account")}
            </h2>
            <p class="mt-2 text-sm leading-6 text-slate-600">
              {t(
                "サーバー上のアカウント、契約連携、クレジット台帳、翻訳リクエストを削除または匿名化します。ローカルのPDF・論文データは残ります。",
                "The server account, billing links, credit ledger, and translation requests will be deleted or anonymized. Local PDFs and papers remain.",
              )}
            </p>
            {deletion.value ? (
              <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
                <span>
                  {new Intl.DateTimeFormat(
                    locale.value === "en" ? "en-US" : "ja-JP",
                    { dateStyle: "medium", timeStyle: "short" },
                  ).format(new Date(deletion.value.executeAt))}
                  {t(" に削除されます。", " — scheduled for deletion.")}
                </span>
                <button
                  type="button"
                  class="button"
                  disabled={deletionBusy.value}
                  onClick$={cancelDeletion}
                >
                  {t("削除を取り消す", "Cancel deletion")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                class="button mt-5 border-red-300 text-red-700"
                disabled={deletionBusy.value}
                onClick$={requestDeletion}
              >
                {t("アカウント削除を予約", "Schedule account deletion")}
              </button>
            )}
            <p class="mt-3 text-xs text-slate-400">
              {t(
                "削除予約には直近15分以内のOAuthまたはマジックリンク再認証が必要です。",
                "Recent OAuth or magic-link re-authentication within 15 minutes is required.",
              )}
            </p>
          </section>
        )}
        <section class="border border-slate-200 bg-white p-6">
          <h2 class="font-bold">{t("バックアップ", "Backup")}</h2>
          <p class="mt-1 text-sm text-slate-500">
            {t(
              "PDF、翻訳、メモをまとめて保存し、別のブラウザでも復元できます。",
              "Save your PDFs, translations, and notes together, then restore them in another browser.",
            )}
          </p>
          {exportController.value && (
            <div
              class="mt-4 flex items-center gap-3 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm text-sky-900"
              role="status"
            >
              <span>
                {t("バックアップを作成中…", "Creating backup…")}{" "}
                {exportProgress.value}%
              </span>
              <button
                type="button"
                class="button subtle py-1 text-xs"
                onClick$={cancelExport}
              >
                {t("キャンセル", "Cancel")}
              </button>
            </div>
          )}
          {importBusy.value && (
            <p class="mt-4 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm text-sky-900" role="status">
              {t("バックアップを復元しています…", "Restoring backup…")}
            </p>
          )}
          <div class="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              class="button primary"
              disabled={!!exportController.value || importBusy.value}
              onClick$={exportZip}
            >
              <Icon name="Download" size={16} />
              {t("バックアップを作成", "Create backup")}
            </button>
            <button
              type="button"
              class="button"
              disabled={!!exportController.value || importBusy.value}
              onClick$={() => importInput.value?.click()}
            >
              <Icon name="Upload" size={16} />
              {t("バックアップを復元", "Restore backup")}
            </button>
            <input
              ref={importInput}
              class="sr-only"
              type="file"
              accept="application/zip,.zip,application/json,.json"
              onChange$={(_, target) => {
                const selected = target.files?.[0];
                target.value = "";
                if (selected) void importData(selected);
              }}
            />
            <button
              type="button"
              class="button text-red-600"
              onClick$={clearData}
            >
              <Icon name="Trash2" size={16} />
              {t("この端末のデータを削除", "Delete data on this device")}
            </button>
          </div>
          <details class="mt-5 border-t border-slate-200 pt-4">
            <summary class="cursor-pointer text-sm font-semibold text-slate-600">
              {t("詳細な書き出し", "Advanced export")}
            </summary>
            <p class="mt-3 text-xs leading-6 text-slate-500">
              {t(
                "論文情報だけを軽量なJSONファイルとして保存します。PDF本体は含まれません。",
                "Save paper information as a small JSON file. PDF files are not included.",
              )}
            </p>
            <button type="button" class="button mt-3" onClick$={exportData}>
              <Icon name="Download" size={16} />
              {t("論文情報を書き出す", "Export paper information")}
            </button>
          </details>
        </section>
        <div class="settings-action-bar flex items-center justify-end gap-4">
          <span class={`text-sm ${message.value.includes("できません") || message.value.includes("失敗") || message.value.includes("不足") ? "text-red-700" : "text-emerald-700"}`} role={message.value.includes("できません") || message.value.includes("失敗") || message.value.includes("不足") ? "alert" : "status"}>
            {message.value}
          </span>
          <button type="button" class="button primary" onClick$={save}>
            <Icon name="Save" size={16} />
            {t("設定を保存", "Save settings")}
          </button>
        </div>
      </section>
    </AppShell>
  );
});
export const head: DocumentHead = { title: "設定 | PaperLens" };
