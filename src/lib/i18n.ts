import { createContextId, useContext } from "@builder.io/qwik";
import type { Signal } from "@builder.io/qwik";

export type Locale = "ja" | "en";
export const localeContext = createContextId<Signal<Locale>>("paperlens.locale");

const messages = {
  ja: {
    library: "ライブラリ", allPapers: "すべての論文", reading: "読書中", unread: "未読", favorite: "お気に入り", llm: "LLM", billing: "プランと課金", management: "管理", settings: "設定", localFirst: "ローカルファースト", localDescription: "PDFとメタデータは端末内に保存されます。", viewStorage: "保存設定を見る →", tabs: "タブ", saving: "端末に保存中", shellTitle: "PaperLens / 研究ライブラリ", searchDestination: "論文・画面を検索…", noDestination: "一致する移動先がありません。", close: "閉じる", quickSwitcher: "クイックスイッチャー", searchNavigation: "移動先を検索", escapeClose: "Escで閉じる · ⌘K / Ctrl+Kで開く", addPaper: "論文を追加", llmOperations: "LLM接続", yourLibrary: "Your library", libraryTitle: "論文ライブラリ", libraryDescription: "読む、探す、必要な箇所だけ翻訳する。", registered: "登録済み", readingCount: "読書中", favoriteCount: "お気に入り", completed: "読了", lastOpened: "最終閲覧", searchLibrary: "タイトル、著者、概要、本文、タグを検索", allStatuses: "すべての状態", allTags: "すべてのタグ", allRatings: "評価すべて", allDates: "期間すべて", favoritesOnly: "お気に入り", clearFilters: "条件をクリア", recent: "最近開いた順", updated: "更新日順", ratingOrder: "評価順", titleOrder: "タイトル順",
  },
  en: {
    library: "Library", allPapers: "All papers", reading: "Reading", unread: "Unread", favorite: "Favorites", llm: "LLM", billing: "Plans & billing", management: "Manage", settings: "Settings", localFirst: "Local-first", localDescription: "PDFs and metadata stay on this device.", viewStorage: "Storage settings →", tabs: "Tabs", saving: "Saved on device", shellTitle: "PaperLens / Research library", searchDestination: "Search papers or screens…", noDestination: "No destinations found.", close: "Close", quickSwitcher: "Quick switcher", searchNavigation: "Search destinations", escapeClose: "Esc to close · ⌘K / Ctrl+K to open", addPaper: "Add paper", llmOperations: "LLM connection", yourLibrary: "Your library", libraryTitle: "Paper library", libraryDescription: "Read, search, and translate the passages you need.", registered: "Registered", readingCount: "Reading", favoriteCount: "Favorites", completed: "Completed", lastOpened: "Last opened", searchLibrary: "Search title, author, abstract, text, or tags", allStatuses: "All statuses", allTags: "All tags", allRatings: "All ratings", allDates: "All dates", favoritesOnly: "Favorites", clearFilters: "Clear filters", recent: "Recently opened", updated: "Recently updated", ratingOrder: "Rating", titleOrder: "Title",
  },
} as const;

export type MessageKey = keyof typeof messages.ja;
export const useLocale = () => useContext(localeContext);
export const message = (locale: Locale, key: MessageKey) => messages[locale][key];
export const localize = (locale: Locale, japanese: string, english: string) => locale === "en" ? english : japanese;
