import {
  $,
  component$,
  noSerialize,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, type DocumentHead, useNavigate } from "@builder.io/qwik-city";
import { AppShell } from "~/components/app-shell";
import { Icon } from "~/components/icon";
import type { PaperDocument } from "~/lib/domain";
import { inspectPdf, sha256 } from "~/lib/pdf";
import { listPapers, MAX_LOCAL_PAPERS, savePaper } from "~/lib/storage";
import { localize, useLocale } from "~/lib/i18n";

type UploadItem = {
  id: string;
  fileName: string;
  state: string;
  progress: number;
  paper: PaperDocument;
  authorsInput: string;
  textByPage: Record<number, string>;
  hash: string;
  error?: string;
  fieldErrors?: {
    title?: string;
    authors?: string;
    abstract?: string;
  };
  duplicate?: boolean;
  done: boolean;
  skipped?: boolean;
};
const validatePaper = (paper: PaperDocument, english: boolean) => {
  const errors: UploadItem["fieldErrors"] = {};
  if (!paper.title.trim())
    errors.title = english ? "Enter a title" : "タイトルを入力してください";
  else if (paper.title.trim().length > 500)
    errors.title = english
      ? "Keep the title within 500 characters"
      : "タイトルは500文字以内で入力してください";
  if (paper.authors.some((author) => author.length > 300))
    errors.authors = english
      ? "Keep each author within 300 characters"
      : "著者名は1名あたり300文字以内で入力してください";
  if ((paper.abstract?.length || 0) > 100_000)
    errors.abstract = english
      ? "Keep the abstract within 100,000 characters"
      : "概要は100,000文字以内で入力してください";
  return errors;
};

const emptyPaper = (
  file: File,
  inspection: {
    title: string;
    author: string;
    abstract?: string;
    publicationYear?: number;
  },
): PaperDocument => ({
  schemaVersion: 1,
  id: crypto.randomUUID(),
  fileName: file.name,
  fileSize: file.size,
  fileType: "application/pdf",
  title: inspection.title || file.name.replace(/\.pdf$/i, ""),
  authors: inspection.author
    ? inspection.author.split(/[,;]\s*/).filter(Boolean)
    : [],
  abstract: inspection.abstract || undefined,
  publicationYear: inspection.publicationYear,
  tags: [],
  favorite: false,
  rating: 0,
  readingStatus: "unread",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export default component$(() => {
  const locale = useLocale();
  const nav = useNavigate();
  const items = useStore<UploadItem[]>([]);
  const busy = useSignal(false);
  const drag = useSignal(false);
  const notice = useSignal("");
  const noticeIsError = useSignal(false);
  const renderTick = useSignal(0);
  const fileRefs = useSignal(noSerialize(new Map<string, File>()));
  const uploadMounted = useSignal(true);
  // File references exist only for the lifetime of the browser view.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    cleanup(() => {
      uploadMounted.value = false;
      fileRefs.value?.clear();
    });
  });
  const addFiles = $(async (selected: File[]) => {
    if (busy.value) return;
    notice.value = "";
    noticeIsError.value = false;
    busy.value = true;
    try {
      if (navigator.storage?.estimate) {
        const storage = await navigator.storage.estimate();
        const usageRatio = storage.quota
          ? (storage.usage || 0) / storage.quota
          : 0;
        if (usageRatio >= 0.95) {
          noticeIsError.value = true;
          notice.value =
            "保存容量が不足しています。不要な論文を削除してください。";
          return;
        }
      }
      const existing = await listPapers();
      const pendingCount = items.filter(
        (item) => !item.done && !item.skipped,
      ).length;
      if (existing.length + pendingCount + selected.length > MAX_LOCAL_PAPERS) {
        noticeIsError.value = true;
        notice.value = `登録上限は${MAX_LOCAL_PAPERS.toLocaleString()}件です。不要な論文を削除してください。`;
        return;
      }
      const existingHashes = new Set(
        existing.map((paper) => paper.contentHash).filter(Boolean),
      );
      const seenHashes = new Set([
        ...existingHashes,
        ...items.map((item) => item.hash).filter(Boolean),
      ]);
      for (const file of selected) {
        if (!uploadMounted.value) return;
        const inspection = {
          title: "",
          author: "",
          abstract: "",
          publicationYear: undefined as number | undefined,
          textByPage: {} as Record<number, string>,
        };
        const paper = emptyPaper(file, inspection);
        fileRefs.value?.set(paper.id, file);
        const item: UploadItem = {
          id: paper.id,
          fileName: file.name,
          state: "準備中",
          progress: 0,
          paper,
          authorsInput: "",
          textByPage: {},
          hash: "",
          done: false,
        };
        items.push(item);
        try {
          if (
            file.type !== "application/pdf" &&
            !file.name.toLowerCase().endsWith(".pdf")
          )
            throw new Error("PDFファイルを選択してください。");
          if (file.size > 200 * 1024 * 1024)
            throw new Error("1ファイルの上限は200MBです。");
          item.state = "PDFを解析中";
          const result = await inspectPdf(file, (page, pages) => {
            item.progress = Math.round((page / pages) * 100);
          });
          item.textByPage = result.textByPage;
          item.paper.title = result.title || item.paper.title;
          item.paper.authors = result.author
            ? result.author.split(/[,;]\s*/).filter(Boolean)
            : [];
          item.authorsInput = result.author || "";
          item.paper.abstract = result.abstract || item.paper.abstract;
          item.paper.publicationYear =
            result.publicationYear || item.paper.publicationYear;
          item.hash = await sha256(file);
          item.paper.contentHash = item.hash;
          item.duplicate = seenHashes.has(item.hash);
          seenHashes.add(item.hash);
          item.progress = 100;
          item.state = item.duplicate ? "重複の可能性" : "確認待ち";
        } catch (error) {
          fileRefs.value?.delete(item.id);
          item.state = "登録不可";
          item.error =
            error instanceof Error
              ? error.message
              : "PDFを解析できませんでした";
        }
      }
    } catch (error) {
      noticeIsError.value = true;
      notice.value =
        error instanceof Error
          ? error.message
          : "PDFを保存できません。ブラウザの保存設定を確認してください。";
    } finally {
      busy.value = false;
    }
  });
  const handleUploadClick = $(async (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-upload-action]",
    );
    if (!target) return;
    if (target.dataset.uploadAction === "all") {
      let hasValidationError = false;
      for (const item of items) {
        if (item.done || item.skipped || item.duplicate || item.error) continue;
        item.paper.title = item.paper.title.trim();
        item.fieldErrors = validatePaper(item.paper, locale.value === "en");
        if (Object.keys(item.fieldErrors).length) hasValidationError = true;
      }
      if (hasValidationError) {
        noticeIsError.value = true;
        notice.value = localize(
          locale.value,
          "入力内容を確認してください",
          "Check the highlighted fields",
        );
        renderTick.value++;
        return;
      }
      busy.value = true;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const file = fileRefs.value?.get(item.id);
        if (item.done || item.skipped || item.duplicate || item.error || !file)
          continue;
        try {
          await savePaper(item.paper, {
            documentId: item.paper.id,
            file,
            sha256: item.hash,
            textByPage: item.textByPage,
          });
          fileRefs.value?.delete(item.id);
          items.splice(i, 1, { ...item, state: "登録済み", done: true });
        } catch (error) {
          fileRefs.value?.delete(item.id);
          items.splice(i, 1, {
            ...item,
            state: "保存失敗",
            error:
              error instanceof Error ? error.message : "保存できませんでした",
          });
        }
      }
      busy.value = false;
      renderTick.value++;
      noticeIsError.value = items.some((item) => item.error);
      notice.value = noticeIsError.value
        ? localize(
            locale.value,
            "保存できなかった論文があります",
            "Some papers could not be saved",
          )
        : localize(locale.value, "論文を登録しました", "Papers registered");
      return;
    }
    const index = Number(target.dataset.index);
    const item = items[index];
    const force = target.dataset.uploadAction === "force";
    if (target.dataset.uploadAction === "skip") {
      if (item) {
        fileRefs.value?.delete(item.id);
        item.skipped = true;
        item.done = true;
        item.state = "スキップ";
      }
      return;
    }
    if (!item || item.done || item.error || (item.duplicate && !force)) return;
    item.paper.title = item.paper.title.trim();
    item.fieldErrors = validatePaper(item.paper, locale.value === "en");
    if (Object.keys(item.fieldErrors).length) {
      noticeIsError.value = true;
      notice.value = localize(
        locale.value,
        "入力内容を確認してください",
        "Check the highlighted fields",
      );
      renderTick.value++;
      return;
    }
    const file = fileRefs.value?.get(item.id);
    if (!file) {
      item.state = "保存不可";
      item.error =
        "元ファイルを保持できませんでした。もう一度選択してください。";
      return;
    }
    items.splice(index, 1, { ...item, state: "保存中" });
    renderTick.value++;
    notice.value = "";
    try {
      await savePaper(item.paper, {
        documentId: item.paper.id,
        file,
        sha256: item.hash,
        textByPage: item.textByPage,
      });
      fileRefs.value?.delete(item.id);
      items.splice(index, 1, { ...item, state: "登録済み", done: true });
      renderTick.value++;
      noticeIsError.value = false;
      notice.value = localize(
        locale.value,
        "論文を登録しました",
        "Paper registered",
      );
    } catch (error) {
      fileRefs.value?.delete(item.id);
      const message =
        error instanceof Error ? error.message : "保存できませんでした";
      items.splice(index, 1, { ...item, state: "保存失敗", error: message });
      renderTick.value++;
      noticeIsError.value = true;
      notice.value = `保存失敗: ${message}`;
    }
  });
  return (
    <AppShell>
      <section
        class="app-page max-w-6xl space-y-7"
        data-render-tick={renderTick.value}
        onClick$={handleUploadClick}
      >
        <div class="page-heading">
          <h1 class="text-3xl font-bold tracking-[-0.04em]">
            {localize(locale.value, "論文を追加", "Add papers")}
          </h1>
        </div>
        <label
          class={`flex min-h-48 cursor-pointer flex-col items-center justify-center border-2 border-dashed px-6 text-center transition ${drag.value ? "border-sky-400 bg-sky-50" : "border-slate-300 bg-slate-50 hover:border-sky-400"}`}
          onDragOver$={(event) => {
            event.preventDefault();
            drag.value = true;
          }}
          onDragLeave$={() => (drag.value = false)}
          onDrop$={async (event) => {
            event.preventDefault();
            drag.value = false;
            await addFiles(Array.from(event.dataTransfer?.files || []));
          }}
        >
          <input
            class="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            disabled={busy.value}
            onChange$={async (_, target) => {
              if (target.files) await addFiles(Array.from(target.files));
              target.value = "";
            }}
          />
          <span class="flex size-12 items-center justify-center bg-sky-100 text-sky-700">
            <Icon name="Upload" size={25} />
          </span>
          <strong class="mt-4 text-base">
            {localize(
              locale.value,
              "PDFを選択、またはここへドロップ",
              "Choose PDFs or drop them here",
            )}
          </strong>
          <span class="mt-2 text-sm text-slate-500">
            {localize(locale.value, "PDF・最大200MB", "PDF · 200MB max")}
          </span>
        </label>
        {notice.value && (
          <p
            role={noticeIsError.value ? "alert" : "status"}
            class={
              noticeIsError.value
                ? "border border-red-200 bg-red-50 p-4 text-sm text-red-700"
                : "border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800"
            }
          >
            {notice.value}
          </p>
        )}
        {items.length > 0 && (
          <div class="flex items-center justify-between border-b border-slate-200 pb-3">
            <span data-upload-count class="text-sm text-slate-500">
              {items.filter((item) => item.done).length} / {items.length}{" "}
              {localize(locale.value, "件を登録", "registered")}
            </span>
            <button
              type="button"
              class="button primary"
              data-upload-action="all"
              disabled={
                busy.value ||
                items.every(
                  (item) =>
                    item.done || item.skipped || item.duplicate || !!item.error,
                )
              }
            >
              <Icon name="Check" size={16} />
              {localize(
                locale.value,
                "重複なしを一括登録",
                "Register non-duplicates",
              )}
            </button>
          </div>
        )}
        <div class="space-y-4">
          {items.map((item, index) => (
            <article
              key={item.id}
              class="border border-slate-200 bg-white p-6 sm:p-8"
            >
              <div class="flex items-start justify-between gap-4">
                <div class="flex min-w-0 items-center gap-3">
                  <Icon name="FileText" size={20} class="text-sky-600" />
                  <div class="min-w-0">
                    <h2 class="truncate font-semibold">{item.fileName}</h2>
                    <p data-upload-state class="mt-1 text-xs text-slate-400">
                      {item.state}
                      {item.progress > 0 && item.progress < 100
                        ? ` · ${item.progress}%`
                        : ""}
                    </p>
                  </div>
                </div>
                <span
                  data-upload-badge
                  class="shrink-0 border border-slate-200 px-2 py-1 text-xs text-slate-500"
                >
                  {item.done
                    ? localize(locale.value, "完了", "Done")
                    : item.state}
                </span>
              </div>
              {!item.done && !item.error && (
                <div data-upload-form class="mt-7 space-y-6">
                  <label class="block text-sm font-semibold">
                    <span class="mb-2 block">
                      {localize(locale.value, "タイトル", "Title")}
                    </span>
                    <input
                      class="h-14 w-full px-4 text-lg font-medium"
                      value={item.paper.title}
                      aria-invalid={
                        item.fieldErrors?.title ? "true" : undefined
                      }
                      aria-describedby={
                        item.fieldErrors?.title
                          ? `upload-title-error-${item.id}`
                          : undefined
                      }
                      onInput$={(_, target) => {
                        item.paper.title = target.value;
                        if (item.fieldErrors?.title)
                          item.fieldErrors = {
                            ...item.fieldErrors,
                            title: undefined,
                          };
                      }}
                    />
                    {item.fieldErrors?.title && (
                      <span
                        id={`upload-title-error-${item.id}`}
                        role="alert"
                        class="mt-2 block text-sm font-normal text-red-700"
                      >
                        {item.fieldErrors.title}
                      </span>
                    )}
                  </label>
                  <label class="block text-sm font-semibold">
                    <span class="mb-2 block">
                      {localize(
                        locale.value,
                        "著者（カンマ区切り）",
                        "Authors (comma-separated)",
                      )}
                    </span>
                    <input
                      class="h-14 w-full px-4 text-base"
                      value={item.authorsInput}
                      aria-invalid={
                        item.fieldErrors?.authors ? "true" : undefined
                      }
                      onInput$={(_, target) => {
                        item.authorsInput = target.value;
                        item.paper.authors = item.authorsInput
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean);
                        if (item.fieldErrors?.authors)
                          item.fieldErrors = {
                            ...item.fieldErrors,
                            authors: undefined,
                          };
                      }}
                    />
                    {item.fieldErrors?.authors && (
                      <span
                        role="alert"
                        class="mt-2 block text-sm font-normal text-red-700"
                      >
                        {item.fieldErrors.authors}
                      </span>
                    )}
                  </label>
                  <label class="block text-sm font-semibold">
                    <span class="mb-2 block">
                      {localize(
                        locale.value,
                        "概要（任意）",
                        "Abstract (optional)",
                      )}
                    </span>
                    <textarea
                      class="min-h-64 w-full resize-y px-4 py-3 text-base leading-7"
                      rows={9}
                      value={item.paper.abstract || ""}
                      aria-invalid={
                        item.fieldErrors?.abstract ? "true" : undefined
                      }
                      onInput$={(_, target) => {
                        item.paper.abstract = target.value;
                        if (item.fieldErrors?.abstract)
                          item.fieldErrors = {
                            ...item.fieldErrors,
                            abstract: undefined,
                          };
                      }}
                    />
                    {item.fieldErrors?.abstract && (
                      <span
                        role="alert"
                        class="mt-2 block text-sm font-normal text-red-700"
                      >
                        {item.fieldErrors.abstract}
                      </span>
                    )}
                  </label>
                </div>
              )}
              {item.error && (
                <p
                  role="alert"
                  class="mt-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                  {item.error}
                </p>
              )}
              {item.duplicate && !item.done && (
                <div class="mt-4 flex flex-wrap items-center gap-3 border-l-2 border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
                  <span>
                    {localize(
                      locale.value,
                      "同じPDFハッシュの論文が既にあります。",
                      "A paper with the same PDF hash already exists.",
                    )}
                  </span>
                  <button
                    type="button"
                    class="button"
                    data-upload-action="force"
                    data-index={index}
                  >
                    {localize(
                      locale.value,
                      "別の論文として登録",
                      "Register as a separate paper",
                    )}
                  </button>
                  <button
                    type="button"
                    class="button subtle"
                    data-upload-action="skip"
                    data-index={index}
                  >
                    {localize(locale.value, "スキップ", "Skip")}
                  </button>
                </div>
              )}
              {!item.done && !item.duplicate && !item.error && (
                <div class="mt-4 flex justify-end">
                  <button
                    type="button"
                    class="button primary"
                    data-upload-action="register"
                    data-index={index}
                  >
                    {localize(
                      locale.value,
                      "この論文を登録",
                      "Register this paper",
                    )}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        <div class="flex justify-between">
          <Link href="/" class="button subtle">
            {localize(locale.value, "ライブラリへ戻る", "Back to library")}
          </Link>
          {items.length > 0 &&
            items.every((item) => item.done || item.skipped) && (
              <button
                type="button"
                class="button primary"
                onClick$={() => nav("/")}
              >
                {localize(locale.value, "ライブラリを開く", "Open library")}
              </button>
            )}
        </div>
      </section>
    </AppShell>
  );
});
export const head: DocumentHead = { title: "論文を追加 | PaperLens" };
