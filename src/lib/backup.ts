import { getPaperFile, listAnnotations, listPapers, listTranslations, savePaperBundles, type PaperBundle } from "./storage";
import { annotationSchema, paperDocumentSchema, translationSchema, type Annotation, type PaperDocument, type Translation } from "./domain";
import { sha256 } from "./pdf";

const MAX_BACKUP_BYTES = 1_024 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 50_000;

/** Read the user-visible contents of a ZIP before any IndexedDB write. The
 * full importer still performs all validation; this lightweight pass exists
 * solely to make the confirmation dialog concrete. */
export async function inspectBackupZip(file: File) {
  const { unzipSync, strFromU8 } = await import("fflate");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const manifest = entries["manifest.json"] ? JSON.parse(strFromU8(entries["manifest.json"])) as { paperIds?: unknown[] } : undefined;
  const ids = Array.isArray(manifest?.paperIds) ? manifest.paperIds.filter((id): id is string => typeof id === "string") : [];
  const titles = ids.map((id) => {
    try {
      const raw = entries[`papers/${id}.json`];
      const paper = raw ? JSON.parse(strFromU8(raw)) as { title?: string; fileName?: string } : {};
      return paper.title || paper.fileName || id;
    } catch {
      return id;
    }
  });
  return { count: ids.length, ids, titles };
}

export async function exportBackupZip(options?: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }) {
  const { strToU8 } = await import("fflate");
  const throwIfAborted = () => {
    if (options?.signal?.aborted)
      throw new DOMException("バックアップ生成をキャンセルしました", "AbortError");
  };
  throwIfAborted();
  const papers = await listPapers();
  throwIfAborted();
  const files: Record<string, Uint8Array> = {};
  const manifest = { schemaVersion: 1, exportedAt: new Date().toISOString(), paperIds: papers.map((paper) => paper.id) };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  let total = files["manifest.json"].byteLength;
  for (const paper of papers) {
    throwIfAborted();
    files[`papers/${paper.id}.json`] = strToU8(JSON.stringify(paper));
    const file = await getPaperFile(paper.id);
    throwIfAborted();
    if (file) {
      files[`papers/${paper.id}.pdf`] = new Uint8Array(await file.file.arrayBuffer());
      throwIfAborted();
      files[`papers/${paper.id}.text.json`] = strToU8(JSON.stringify({ sha256: file.sha256, textByPage: file.textByPage || {} }));
    }
    files[`annotations/${paper.id}.json`] = strToU8(JSON.stringify(await listAnnotations(paper.id)));
    throwIfAborted();
    files[`translations/${paper.id}.json`] = strToU8(JSON.stringify(await listTranslations(paper.id)));
    throwIfAborted();
    total = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
    if (total > MAX_BACKUP_BYTES) throw new Error("一括ZIPエクスポートの上限は合計1GBです。論文単位に分割してください。");
  }
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("./backup-worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const finish = () => { if (!settled) { settled = true; worker.terminate(); options?.signal?.removeEventListener("abort", cancel); } };
    const cancel = () => { if (settled) return; worker.postMessage({ type: "cancel" }); finish(); reject(new DOMException("バックアップ生成をキャンセルしました", "AbortError")); };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    // Abort may have happened between the last preparation check and the
    // listener registration. EventTarget does not replay an earlier abort.
    if (options?.signal?.aborted) { cancel(); return; }
    worker.onmessage = (event: MessageEvent<{ type: string; archive?: Uint8Array; message?: string; completed?: number; total?: number }>) => {
      if (event.data.type === "progress") { options?.onProgress?.(event.data.completed || 0, event.data.total || 0); return; }
      finish();
      if (event.data.type === "done" && event.data.archive) resolve(new Blob([event.data.archive], { type: "application/zip" }));
      else reject(new Error(event.data.message || "ZIPを生成できませんでした"));
    };
    worker.onerror = () => { finish(); reject(new Error("ZIPを生成できませんでした")); };
    const transfer = Object.values(files).map((bytes) => bytes.buffer as ArrayBuffer);
    worker.postMessage({ type: "zip", files }, transfer);
  });
}

export async function importBackupZip(file: File) {
  const { unzipSync, strFromU8 } = await import("fflate");
  if (file.size > MAX_BACKUP_BYTES) throw new Error("インポートできるバックアップは1GBまでです。");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const entryList = Object.entries(entries);
  if (entryList.length > MAX_BACKUP_ENTRIES) throw new Error("バックアップ内のファイル数が上限を超えています。");
  const uncompressedBytes = entryList.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  if (uncompressedBytes > MAX_BACKUP_BYTES) throw new Error("展開後のバックアップが1GBを超えています。");
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("バックアップのmanifest.jsonがありません。");
  let manifest: { schemaVersion?: number; paperIds?: unknown[] };
  try { manifest = JSON.parse(strFromU8(manifestBytes)) as typeof manifest; } catch { throw new Error("バックアップのmanifest.jsonが不正です。"); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.paperIds) || manifest.paperIds.some((id) => typeof id !== "string")) throw new Error("このバックアップ形式には対応していません。新しいPaperLensで作成されたファイルか確認してください。");
  const paperEntries = Object.entries(entries).filter(([path]) => /^papers\/[^/.]+\.json$/.test(path));
  if (paperEntries.length !== manifest.paperIds.length || new Set(manifest.paperIds as string[]).size !== paperEntries.length) throw new Error("バックアップの論文一覧が不整合です。");
  const bundles: PaperBundle[] = [];
  for (const [path, bytes] of paperEntries) {
    let raw: unknown;
    try { raw = JSON.parse(strFromU8(bytes)); } catch { throw new Error(`バックアップ内の論文メタデータが不正です: ${path}`); }
    const parsed = paperDocumentSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`バックアップ内の論文メタデータが不正です: ${path}`);
    const paper = parsed.data as PaperDocument;
    if (!manifest.paperIds.includes(paper.id) || path !== `papers/${paper.id}.json`) throw new Error(`バックアップ内の論文IDが不整合です: ${paper.id}`);
    const id = paper.id;
    const pdf = entries[`papers/${id}.pdf`];
    if (pdf && pdf.byteLength > 200 * 1024 * 1024) throw new Error(`バックアップ内のPDFが200MBを超えています: ${id}`);
    if (pdf && pdf.byteLength !== paper.fileSize) throw new Error(`バックアップ内のPDFサイズがメタデータと一致しません: ${id}`);
    let extracted: { sha256?: string; textByPage?: Record<number, string> } | undefined;
    try { extracted = entries[`papers/${id}.text.json`] ? JSON.parse(strFromU8(entries[`papers/${id}.text.json`])) as { sha256?: string; textByPage?: Record<number, string> } : undefined; } catch { throw new Error(`バックアップ内の本文インデックスが不正です: ${id}`); }
    if (extracted?.textByPage) {
      const textEntries = Object.entries(extracted.textByPage);
      if (textEntries.length > 2_000 || textEntries.some(([page, text]) => !/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 2_000 || typeof text !== "string" || text.length > 100_000)) {
        throw new Error(`バックアップ内の本文インデックスが不正です: ${id}`);
      }
    }
    const calculatedHash = pdf ? await sha256(new Blob([pdf], { type: "application/pdf" })) : "";
    if (pdf && extracted?.sha256 && extracted.sha256 !== calculatedHash) throw new Error(`バックアップ内のPDFハッシュが不正です: ${id}`);
    if (pdf && paper.contentHash && paper.contentHash !== calculatedHash) throw new Error(`バックアップ内の論文ハッシュが不正です: ${id}`);
    const paperFile = pdf ? { documentId: id, file: new Blob([pdf], { type: "application/pdf" }), sha256: calculatedHash, textByPage: extracted?.textByPage } : undefined;
    let rawAnnotations: unknown = [];
    let rawTranslations: unknown = [];
    try {
      if (entries[`annotations/${id}.json`]) rawAnnotations = JSON.parse(strFromU8(entries[`annotations/${id}.json`])) as unknown;
      if (entries[`translations/${id}.json`]) rawTranslations = JSON.parse(strFromU8(entries[`translations/${id}.json`])) as unknown;
    } catch { throw new Error(`バックアップ内の注釈または翻訳形式が不正です: ${id}`); }
    if (!Array.isArray(rawAnnotations) || !Array.isArray(rawTranslations)) throw new Error(`バックアップ内の注釈または翻訳形式が不正です: ${id}`);
    const annotations: Annotation[] = [];
    for (const candidate of rawAnnotations) {
      const result = annotationSchema.safeParse(candidate);
      if (!result.success || result.data.documentId !== id) throw new Error(`バックアップ内の注釈が不正です: ${id}`);
      annotations.push(result.data);
    }
    const translations: Translation[] = [];
    for (const candidate of rawTranslations) {
      const result = translationSchema.safeParse(candidate);
      if (!result.success || result.data.documentId !== id) throw new Error(`バックアップ内の翻訳が不正です: ${id}`);
      translations.push(result.data);
    }
    bundles.push({ paper, file: paperFile, annotations, translations });
  }
	await savePaperBundles(bundles, { replaceRelated: true });
  return paperEntries.length;
}
