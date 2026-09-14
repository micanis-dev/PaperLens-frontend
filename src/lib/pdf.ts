import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

export type PdfInspection = {
  pages: number;
  title: string;
  author: string;
  abstract: string;
  publicationYear?: number;
  textByPage: Record<number, string>;
};

export async function sha256(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inspectPdf(file: Blob, onProgress?: (page: number, pages: number) => void) {
  return new Promise<PdfInspection>((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<PdfInspection & { type: string; message?: string; page?: number }>) => {
      if (event.data.type === "progress") onProgress?.(event.data.page ?? 0, event.data.pages);
      if (event.data.type === "done") {
        worker.terminate();
        resolve(event.data);
      }
      if (event.data.type === "error") {
        worker.terminate();
        reject(new Error(event.data.message || "PDFを読み込めませんでした"));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("PDFの解析に失敗しました。標準的な静的PDFか確認してください。"));
    };
    void file.arrayBuffer().then((buffer) => worker.postMessage({ type: "inspect", buffer }, [buffer])).catch(reject);
  });
}

export async function loadPdf(file: Blob) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
}
