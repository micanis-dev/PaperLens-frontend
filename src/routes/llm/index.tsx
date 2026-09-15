import { component$ } from "@builder.io/qwik";
import { Link, type DocumentHead } from "@builder.io/qwik-city";
import { AppShell } from "~/components/app-shell";
import { Icon } from "~/components/icon";
import { localize, useLocale } from "~/lib/i18n";

/** Keep old bookmarks useful while translation stays beside its source PDF. */
export default component$(() => {
  const locale = useLocale();
  const t = (ja: string, en: string) => localize(locale.value, ja, en);

  return (
    <AppShell>
      <section class="app-page max-w-4xl">
        <div class="border border-slate-200 bg-white p-6 sm:p-10">
          <span class="flex size-11 items-center justify-center bg-sky-100 text-sky-700">
            <Icon name="Languages" size={22} />
          </span>
          <h1 class="mt-6 text-2xl font-bold tracking-[-0.03em]">
            {t(
              "翻訳はPDFリーダーで使えます",
              "Translation is in the PDF reader",
            )}
          </h1>
          <p class="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            {t(
              "論文を開き、右側の翻訳パネルから現在のページや選択した文章を翻訳できます。接続先は設定画面で選べます。",
              "Open a paper and use the translation panel beside it to translate the current page or selected text. Choose your AI connection in Settings.",
            )}
          </p>
          <div class="mt-7 flex flex-wrap gap-3">
            <Link href="/" class="button primary">
              <Icon name="Library" size={17} />
              {t("論文を開く", "Open a paper")}
            </Link>
            <Link href="/settings/#ai-connection" class="button">
              <Icon name="Settings2" size={17} />
              {t("AI接続を設定", "Configure AI")}
            </Link>
          </div>
        </div>
      </section>
    </AppShell>
  );
});

export const head: DocumentHead = { title: "翻訳 | PaperLens" };
