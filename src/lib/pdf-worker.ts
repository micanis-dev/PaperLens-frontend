import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

type Request = { type: "inspect"; buffer: ArrayBuffer };

const MAX_PAGES = 2_000;
const MAX_PAGE_TEXT = 100_000;

function extractAbstract(textByPage: Record<number, string>) {
  const firstPages = Object.keys(textByPage)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((page) => textByPage[page])
    .filter(Boolean)
    .join("\n\n");
  const match = firstPages.match(/(?:^|\n|\s)(?:abstract|summary)\s*[:.\-]?\s*([\s\S]{40,}?)(?=\s+(?:keywords?|key words?|introduction|1\s*[.\-:]\s*introduction)\b|$)/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, 10_000);
}

function extractPublicationYear(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type !== "inspect") return;
  try {
    const pdf = await getDocument({ data: event.data.buffer, disableWorker: true }).promise;
    if (pdf.numPages > MAX_PAGES) throw new Error(`登録できるPDFは${MAX_PAGES.toLocaleString()}ページまでです。`);
    if (pdf.isPureXfa) throw new Error("XFAフォームPDFは初期版では登録できません。");
    // PDF.js rejects password-protected files while opening. The internal
    // encryption marker additionally lets us fail closed for encrypted/DRM
    // documents that do not expose a usable password prompt.
    if ((pdf as unknown as { _pdfInfo?: { encrypted?: boolean } })._pdfInfo?.encrypted) throw new Error("暗号化またはDRMで保護されたPDFは登録できません。");
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} })) as { info?: Record<string, unknown> };
    const textByPage: Record<number, string> = {};
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: { str?: string }) => item.str || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > MAX_PAGE_TEXT) throw new Error(`${pageNumber}ページの本文が${MAX_PAGE_TEXT.toLocaleString()}文字を超えています。`);
      textByPage[pageNumber] = text;
      self.postMessage({ type: "progress", page: pageNumber, pages: pdf.numPages });
    }
    self.postMessage({
      type: "done",
      pages: pdf.numPages,
      title: typeof metadata.info?.Title === "string" ? metadata.info.Title : "",
      author: typeof metadata.info?.Author === "string" ? metadata.info.Author : "",
      abstract: extractAbstract(textByPage),
      publicationYear: extractPublicationYear(metadata.info?.CreationDate) || extractPublicationYear(metadata.info?.ModDate),
      textByPage,
    });
  } catch (error) {
    const pdfError = error as { name?: string; message?: string };
    const message = pdfError.name === "PasswordException"
      ? "パスワードで保護されたPDFは登録できません。"
      : pdfError.name === "InvalidPDFException"
        ? "破損または未対応のPDFです。標準的な静的PDFを選択してください。"
        : pdfError.message || "PDFを読み込めませんでした";
    self.postMessage({ type: "error", message });
  }
};

export {};
