export type SourceTranslationSegment = {
  id: string;
  pageNumber: number;
  order: number;
  text: string;
  textHash: string;
};

const hashText = async (text: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** Build provider-safe source segments while retaining their PDF page. */
export async function buildSourceTranslationSegments(options: {
  documentId: string;
  startPage: number;
  endPage?: number;
  fallbackText: string;
  textByPage?: Record<number, string>;
  requestKey: string;
}) {
  const endPage = options.endPage || options.startPage;
  const segments: SourceTranslationSegment[] = [];
  if (endPage > options.startPage && options.textByPage) {
    for (let pageNumber = options.startPage; pageNumber <= endPage; pageNumber++) {
      const pageText = options.textByPage[pageNumber]?.trim() || "";
      for (let offset = 0; offset < pageText.length; offset += 12_000) {
        const text = pageText.slice(offset, offset + 12_000);
        segments.push({
          id: `${options.documentId}:${pageNumber}:range:${offset}:${options.requestKey}`,
          pageNumber,
          order: segments.length,
          text,
          textHash: await hashText(text),
        });
      }
    }
  }
  if (!segments.length) {
    segments.push({
      id: `${options.documentId}:${options.startPage}:inline:${options.requestKey}`,
      pageNumber: options.startPage,
      order: 0,
      text: options.fallbackText,
      textHash: await hashText(options.fallbackText),
    });
  }
  return segments;
}
