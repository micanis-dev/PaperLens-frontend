type Request = { type: "index"; papers: { documentId: string; entries: { pageNumber: number; text: string; kind: "pdf" | "note" | "translation" }[] }[] };

self.onmessage = (event: MessageEvent<Request>) => {
  if (event.data.type !== "index") return;
  const entries = event.data.papers.flatMap((paper) => paper.entries.map((entry) => ({ documentId: paper.documentId, ...entry })));
  self.postMessage({ type: "done", entries });
};

export {};
