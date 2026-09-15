import { openDB, unwrap, type DBSchema, type IDBPDatabase } from "idb";
import type {
  Annotation,
  PaperDocument,
  PaperFile,
  Translation,
  TranslationDraft,
} from "./domain";

interface PaperLensDB extends DBSchema {
  papers: {
    key: string;
    value: PaperDocument;
    indexes: { "by-updated-at": string; "by-title": string };
  };
  files: {
    key: string;
    value: PaperFile;
  };
  annotations: { key: string; value: Annotation; indexes: { "by-document": string } };
  translations: { key: string; value: Translation; indexes: { "by-document": string } };
  settings: { key: string; value: { key: string; value: unknown } };
}

let database: Promise<IDBPDatabase<PaperLensDB>> | undefined;
let readOnly = false;
const DATABASE_VERSION = 3;
export const MAX_LOCAL_PAPERS = 5_000;

export function isStorageReadOnly() {
  return readOnly;
}

function assertWritable() {
  if (readOnly) {
    throw new Error("端末内データを更新できないため読み取り専用です。先にバックアップを作成し、ブラウザの保存設定を確認してください。");
  }
}

/** Browser-only IndexedDB boundary. PDF bytes never pass through a base64 string. */
export function getPaperLensDB() {
  if (typeof window === "undefined") {
    throw new Error("PaperLens local storage is only available in a browser");
  }

  database ??= openDB<PaperLensDB>("paperlens", DATABASE_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      const papers = db.objectStoreNames.contains("papers")
        ? transaction.objectStore("papers")
        : db.createObjectStore("papers", { keyPath: "id" });
      if (!papers.indexNames.contains("by-updated-at")) papers.createIndex("by-updated-at", "updatedAt");
      if (!papers.indexNames.contains("by-title")) papers.createIndex("by-title", "title");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "documentId" });
      if (!db.objectStoreNames.contains("annotations")) {
        const store = db.createObjectStore("annotations");
        store.createIndex("by-document", "documentId");
      } else {
        const store = transaction.objectStore("annotations");
        if (!store.indexNames.contains("by-document")) store.createIndex("by-document", "documentId");
      }
      if (!db.objectStoreNames.contains("translations")) {
        const store = db.createObjectStore("translations");
        store.createIndex("by-document", "documentId");
      } else {
        const store = transaction.objectStore("translations");
        if (!store.indexNames.contains("by-document")) store.createIndex("by-document", "documentId");
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      // Version 3 is a non-destructive data migration. Older records already
      // have the same shape, but normalizing the schema marker here makes the
      // local format explicit for future migrations and keeps the operation
      // inside the IndexedDB upgrade transaction.
      if (oldVersion < 3) {
        // Do not use idb's promise cursor API from an upgrade callback: an
        // upgrade transaction may auto-commit before that promise chain runs.
        // The native request keeps every update inside this versionchange
        // transaction and an exception aborts the migration atomically.
        const cursorRequest = unwrap(papers).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value as PaperDocument;
          if (value.schemaVersion !== 1)
            cursor.update({ ...value, schemaVersion: 1 });
          cursor.continue();
        };
      }
    },
  }).catch(async (error) => {
    // An aborted upgrade leaves the previous database version intact. Open
    // that version without requesting an upgrade so users can still export
    // their data and recover it in another profile.
    readOnly = true;
    try {
      return await openDB<PaperLensDB>("paperlens");
    } catch {
      throw error;
    }
  });

  return database;
}

export async function listPapers() {
  return (await getPaperLensDB()).getAll("papers");
}

export async function getPaper(id: string) {
  return (await getPaperLensDB()).get("papers", id);
}

export async function getPaperFile(id: string) {
  return (await getPaperLensDB()).get("files", id);
}

export async function savePaper(paper: PaperDocument, file?: PaperFile) {
	assertWritable();
  const db = await getPaperLensDB();
  // Qwik exposes store values as proxies; normalize them before IndexedDB's
  // structured-clone boundary so requests cannot retain a reactive proxy.
  const storedPaper = { schemaVersion: 1, ...JSON.parse(JSON.stringify(paper)) } as PaperDocument;
  const storedFile = file ? {
    documentId: file.documentId,
    file: file.file.slice(0, file.file.size, file.file.type),
    sha256: file.sha256,
    textByPage: file.textByPage ? Object.fromEntries(Object.entries(file.textByPage)) : undefined,
  } satisfies PaperFile : undefined;
  const tx = db.transaction(["papers", "files"], "readwrite");
  try {
    if (!(await tx.objectStore("papers").get(paper.id)) && (await tx.objectStore("papers").count()) >= MAX_LOCAL_PAPERS) {
      tx.abort();
      throw new Error(`このブラウザには最大${MAX_LOCAL_PAPERS.toLocaleString()}件まで登録できます。不要な論文を削除してから追加してください。`);
    }
    await tx.objectStore("papers").put(storedPaper);
    if (storedFile) await tx.objectStore("files").put(storedFile);
    await tx.done;
  } catch (error) {
    if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "UnknownError")) {
      throw new Error("ブラウザの保存領域が不足しています。不要な論文を削除するか、バックアップ後に再試行してください。");
    }
    throw error;
  }
}

export async function savePaperBundle(paper: PaperDocument, file: PaperFile | undefined, annotations: Annotation[], translations: Translation[]) {
	return savePaperBundles([{ paper, file, annotations, translations }]);
}

export type PaperBundle = { paper: PaperDocument; file?: PaperFile; annotations: Annotation[]; translations: Translation[] };

/** Persist a complete import in one IndexedDB transaction. If any paper or
 * related record fails, the browser keeps the previous library intact. */
export async function savePaperBundles(bundles: PaperBundle[]) {
	assertWritable();
	const db = await getPaperLensDB();
	const tx = db.transaction(["papers", "files", "annotations", "translations"], "readwrite");
	try {
		const existingIDs = new Set(await tx.objectStore("papers").getAllKeys());
		const importedIDs = new Set<string>();
		for (const bundle of bundles) importedIDs.add(bundle.paper.id);
		const newPaperCount = [...importedIDs].filter((id) => !existingIDs.has(id)).length;
		if (existingIDs.size + newPaperCount > MAX_LOCAL_PAPERS) {
			tx.abort();
			throw new Error(`このブラウザには最大${MAX_LOCAL_PAPERS.toLocaleString()}件まで登録できます。不要な論文を削除してから復元してください。`);
		}
		for (const bundle of bundles) {
			const storedPaper = { schemaVersion: 1, ...JSON.parse(JSON.stringify(bundle.paper)) } as PaperDocument;
			const storedFile = bundle.file ? {
				documentId: bundle.file.documentId,
				file: bundle.file.file.slice(0, bundle.file.file.size, bundle.file.file.type),
				sha256: bundle.file.sha256,
				textByPage: bundle.file.textByPage ? Object.fromEntries(Object.entries(bundle.file.textByPage)) : undefined,
			} satisfies PaperFile : undefined;
			await tx.objectStore("papers").put(storedPaper);
			if (storedFile) await tx.objectStore("files").put(storedFile);
			for (const annotation of bundle.annotations) await tx.objectStore("annotations").put(JSON.parse(JSON.stringify(annotation)), annotation.id);
			for (const translation of bundle.translations) await tx.objectStore("translations").put(JSON.parse(JSON.stringify(translation)), translation.id);
		}
		await tx.done;
	} catch (error) {
		if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "UnknownError")) {
			throw new Error("ブラウザの保存領域が不足しています。不要な論文を削除するか、バックアップ後に再試行してください。");
		}
		throw error;
	}
}

export async function removePaper(id: string) {
  assertWritable();
  const db = await getPaperLensDB();
  const tx = db.transaction(["papers", "files", "annotations", "translations"], "readwrite");
  await Promise.all([
    tx.objectStore("papers").delete(id),
    tx.objectStore("files").delete(id),
    tx.objectStore("annotations").index("by-document").openCursor(IDBKeyRange.only(id)).then(async function remove(cursor) {
      if (!cursor) return;
      await cursor.delete();
      return remove(await cursor.continue());
    }),
    tx.objectStore("translations").index("by-document").openCursor(IDBKeyRange.only(id)).then(async function remove(cursor) {
      if (!cursor) return;
      await cursor.delete();
      return remove(await cursor.continue());
    }),
  ]);
  await tx.done;
}

export async function clearLocalData() {
  assertWritable();
  const db = await getPaperLensDB();
  const tx = db.transaction(["papers", "files", "annotations", "translations", "settings"], "readwrite");
  await Promise.all([
    tx.objectStore("papers").clear(),
    tx.objectStore("files").clear(),
    tx.objectStore("annotations").clear(),
    tx.objectStore("translations").clear(),
    tx.objectStore("settings").clear(),
  ]);
  await tx.done;
}

export async function listAnnotations(documentId: string) {
  return (await getPaperLensDB()).getAllFromIndex("annotations", "by-document", documentId);
}

export async function saveAnnotation(annotation: Annotation) {
  assertWritable();
  return (await getPaperLensDB()).put("annotations", annotation, annotation.id);
}

export async function removeAnnotation(id: string) {
  assertWritable();
  return (await getPaperLensDB()).delete("annotations", id);
}

export async function listTranslations(documentId: string) {
  return (await getPaperLensDB()).getAllFromIndex("translations", "by-document", documentId);
}

export async function saveTranslation(translation: Translation) {
  assertWritable();
  return (await getPaperLensDB()).put("translations", translation, translation.id);
}

const translationDraftKey = (documentId: string) =>
  `translation-draft:${documentId}`;

export async function getTranslationDraft(documentId: string) {
  return getSetting<TranslationDraft | undefined>(
    translationDraftKey(documentId),
    undefined,
  );
}

export async function saveTranslationDraft(draft: TranslationDraft) {
  assertWritable();
  return saveSetting(
    translationDraftKey(draft.documentId),
    JSON.parse(JSON.stringify(draft)) as TranslationDraft,
  );
}

export async function removeTranslationDraft(documentId: string) {
  assertWritable();
  return (await getPaperLensDB()).delete("settings", translationDraftKey(documentId));
}

export async function getSetting<T>(key: string, fallback: T) {
  const item = await (await getPaperLensDB()).get("settings", key);
  return (item?.value as T | undefined) ?? fallback;
}

export async function saveSetting(key: string, value: unknown) {
  assertWritable();
  return (await getPaperLensDB()).put("settings", { key, value }, key);
}

/** Remove a browser-local setting completely. This is preferable to storing
 * `undefined`, which IndexedDB can retain as a live key and cause stale drafts
 * to be rediscovered on the next visit. */
export async function removeSetting(key: string) {
  assertWritable();
  return (await getPaperLensDB()).delete("settings", key);
}
