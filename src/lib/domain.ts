import { z } from "zod";

export const translationModes = [
  "paperlens-managed",
  "openai",
  "google",
  "anthropic",
  "openai-compatible",
  "local",
] as const;

export type TranslationMode = (typeof translationModes)[number];

export const paperDocumentSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "文書IDの形式が不正です"),
  fileName: z.string().min(1),
  fileSize: z.number().nonnegative(),
  fileType: z.literal("application/pdf"),
  contentHash: z.string().optional(),
  title: z.string(),
  authors: z.array(z.string()),
  abstract: z.string().optional(),
  publicationYear: z.number().int().min(0).max(9999).optional(),
  tags: z.array(z.string()),
  favorite: z.boolean(),
  rating: z.number().int().min(0).max(5),
  readingStatus: z.enum(["unread", "reading", "read"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string().optional(),
  reader: z
    .object({
      page: z.number().int().positive(),
      zoom: z.number().positive(),
      viewMode: z.enum(["continuous", "single"]),
      layout: z.enum(["split", "stack", "pdf", "text"]).optional(),
    })
    .optional(),
});

export type PaperDocument = z.infer<typeof paperDocumentSchema>;

export type Annotation = {
  id: string;
  documentId: string;
  pageNumber: number;
  type: "highlight" | "underline" | "comment" | "note";
  quote?: string;
  content?: string;
  rect?: { x: number; y: number; width: number; height: number };
  createdAt: string;
  updatedAt: string;
};

export const annotationSchema = z.object({
  id: z.string().min(1).max(128),
  documentId: z.string().min(1).max(128),
  pageNumber: z.number().int().min(0),
  type: z.enum(["highlight", "underline", "comment", "note"]),
  quote: z.string().max(20_000).optional(),
  content: z.string().max(100_000).optional(),
  rect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Translation = {
  id: string;
  documentId: string;
  language: string;
  markdown: string;
  source: "manual" | "llm";
  updatedAt: string;
  revision: number;
  segments?: TranslationSegmentResult[];
};

export const translationSchema = z.object({
  id: z.string().min(1).max(128),
  documentId: z.string().min(1).max(128),
  language: z.string().min(2).max(16),
  markdown: z.string().max(500_000),
  source: z.enum(["manual", "llm"]),
  updatedAt: z.string(),
  revision: z.number().int().positive(),
  segments: z.array(z.object({ id: z.string().min(1).max(256), pageNumber: z.number().int().positive(), sequence: z.number().int().positive().optional(), translatedText: z.string().max(100_000), sourceTextHash: z.string().min(1).max(128), sourceText: z.string().max(100_000).optional() })).max(2_000).optional(),
});

export type TranslationSegmentResult = {
  id: string;
  pageNumber: number;
  sequence?: number;
  translatedText: string;
  sourceTextHash: string;
  /** Local-only source snapshot used to detect edits after a translation. */
  sourceText?: string;
};

export type TranslationDraft = {
  documentId: string;
  requestKey: string;
  mode: TranslationMode;
  model: string;
  targetLanguage: string;
  scope: "selection" | "page" | "range" | "all";
  pageNumber: number;
  endPage: number;
  selectedText?: string;
  segments: TranslationSegmentResult[];
  updatedAt: string;
};

export type PaperFile = {
  documentId: string;
  file: Blob;
  sha256: string;
  textByPage?: Record<number, string>;
};

export type ReaderPreferences = {
  page: number;
  zoom: number;
  viewMode: "continuous" | "single";
  layout?: "split" | "stack" | "pdf" | "text";
};

export type ProviderSettings = {
  mode: TranslationMode;
  model: string;
  baseUrl: string;
  apiKey?: string;
  targetLanguage: string;
  connected: boolean;
  checkedAt?: string;
};

export const supportedLanguages = [
  ["ja", "日本語"],
  ["en", "English"],
  ["zh-CN", "中文（简体）"],
  ["zh-TW", "中文（繁体）"],
  ["ko", "한국어"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["es", "Español"],
] as const;

export function isSupportedLanguage(
  value: string,
): value is (typeof supportedLanguages)[number][0] {
  return supportedLanguages.some(([code]) => code === value);
}
