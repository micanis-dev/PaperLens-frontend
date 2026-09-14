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
import { exportBackupZip, importBackupZip } from "~/lib/backup";
import { paperDocumentSchema } from "~/lib/domain";
import {
  cancelAccountDeletion,
  getAccount,
  logoutManagedSession,
  requestAccountDeletion,
  type AccountDeletion,
} from "~/lib/api";
import { localize, useLocale } from "~/lib/i18n";

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
  const deletion = useSignal<AccountDeletion>();
  const accountState = useSignal<"unknown" | "signed-out" | "ready">("unknown");
  const deletionBusy = useSignal(false);
  useVisibleTask$(async () => {
    try {
      language.value = await getSetting("uiLanguage", "ja");
      viewMode.value = await getSetting("viewMode", "continuous");
    } catch {
      storageState.value = "unavailable";
      storageInfo.value = "このブラウザではIndexedDBを利用できません";
      return;
    }
    try {
      await getPaperLensDB();
      storageState.value = isStorageReadOnly() ? "unavailable" : "ready";
    } catch {
      storageState.value = "unavailable";
      storageInfo.value = "このブラウザではIndexedDBを利用できません";
      return;
    }
    if (!navigator.storage?.estimate)
      storageInfo.value = "このブラウザでは使用量を取得できません";
    else {
      const estimate = await navigator.storage.estimate();
      const ratio = estimate.quota ? (estimate.usage || 0) / estimate.quota : 0;
      storageInfo.value = `${Math.round((estimate.usage || 0) / 1024 / 1024)}MB 使用 / ${estimate.quota ? `${Math.round(estimate.quota / 1024 / 1024)}MB` : "上限不明"}${isStorageReadOnly() ? " · 読み取り専用" : ratio >= 0.95 ? " · 新規登録停止" : ratio >= 0.8 ? " · 容量に注意" : ""}`;
    }
    try {
      const response = await getAccount();
      deletion.value = response.deletion;
      accountState.value = "ready";
    } catch {
      accountState.value = "signed-out";
    }
  });
  const save = $(async () => {
    try {
      await Promise.all([
        saveSetting("uiLanguage", language.value),
        saveSetting("viewMode", viewMode.value),
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
    try {
      if (file.name.toLowerCase().endsWith(".zip")) {
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
    }
  });
  const clearData = $(async () => {
    if (
      !window.confirm(
        "ローカルライブラリ、PDF、翻訳、注釈をすべて削除しますか？この操作は元に戻せません。",
      )
    )
      return;
    try {
      await clearLocalData();
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
      <section class="mx-auto max-w-4xl space-y-8">
        <h1 class="text-3xl font-bold tracking-[-0.04em]">
          {t("設定", "Settings")}
        </h1>
        <section class="border border-slate-200 bg-white p-6">
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
            <h2 class="font-bold">{t("ローカル保存", "Local storage")}</h2>
            <span
              class={`border px-2.5 py-1 text-xs font-bold ${storageState.value === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : storageState.value === "unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}
            >
              {storageState.value === "ready"
                ? t("IndexedDB 有効", "IndexedDB available")
                : storageState.value === "unavailable"
                  ? isStorageReadOnly()
                    ? t("読み取り専用", "Read-only")
                    : t("IndexedDB 非対応", "IndexedDB unavailable")
                  : t("確認中…", "Checking…")}
            </span>
          </div>
          <div class="mt-5 border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p>
              {t("保存領域", "Storage")}: {storageInfo.value}
            </p>
          </div>
        </section>
        <section class="border border-slate-200 bg-white p-6">
          <div class="flex items-start justify-between gap-4">
            <h2 class="font-bold">{t("LLM接続", "LLM connection")}</h2>
            <Link href="/llm/" class="button">
              <Icon name="Sparkles" size={16} />
              {t("LLM画面を開く", "Open LLM workspace")}
            </Link>
          </div>
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
          </div>
          <button type="button" class="button" onClick$={logout}>
            {t("ログアウト", "Log out")}
          </button>
        </section>
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
          <h2 class="font-bold">{t("データ管理", "Data management")}</h2>
          <p class="mt-1 text-sm text-slate-500">
            {t(
              "JSONはメタデータのみ、ZIPはPDF・抽出本文・メタデータ・翻訳・注釈を含めてバックアップします。合計1GBまでです。",
              "JSON contains metadata only. ZIP includes PDFs, extracted text, metadata, translations, and annotations, up to 1GB.",
            )}
          </p>
          {exportController.value && (
            <div
              class="mt-4 flex items-center gap-3 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm text-sky-900"
              role="status"
            >
              <span>
                {t("ZIPを生成中…", "Creating ZIP…")} {exportProgress.value}%
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
          <div class="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              class="button primary"
              disabled={!!exportController.value}
              onClick$={exportZip}
            >
              <Icon name="Download" size={16} />
              {t("一括ZIPエクスポート", "Export ZIP backup")}
            </button>
            <button type="button" class="button" onClick$={exportData}>
              <Icon name="Download" size={16} />
              {t("JSONエクスポート", "Export JSON")}
            </button>
            <button
              type="button"
              class="button"
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
                if (target.files?.[0]) void importData(target.files[0]);
              }}
            />
            <button
              type="button"
              class="button text-red-600"
              onClick$={clearData}
            >
              <Icon name="Trash2" size={16} />
              {t("すべて削除", "Delete all local data")}
            </button>
          </div>
        </section>
        <div class="flex items-center justify-end gap-4">
          <span class="text-sm text-emerald-700" role="status">
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
