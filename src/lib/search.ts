export type SearchIndexEntry = { documentId: string; pageNumber: number; text: string; kind: "pdf" | "note" | "translation" };
export type SearchDocument = { documentId: string; entries: { pageNumber: number; text: string; kind: SearchIndexEntry["kind"] }[] };

export function buildSearchIndex(papers: SearchDocument[]) {
  return new Promise<SearchIndexEntry[]>((resolve, reject) => {
    const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ type: string; entries?: SearchIndexEntry[] }>) => {
      if (event.data.type !== "done") return;
      worker.terminate();
      resolve(event.data.entries || []);
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("全文検索インデックスを作成できませんでした。")); };
    worker.postMessage({ type: "index", papers });
  });
}
