import { component$, $, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { Link, type DocumentHead } from "@builder.io/qwik-city";
import { Icon } from "~/components/icon";
import { apiBaseURL, requestMagicLink } from "~/lib/api";
import { getSetting } from "~/lib/storage";
import { localize, type Locale } from "~/lib/i18n";

export default component$(() => {
  const locale = useSignal<Locale>("ja");
  useVisibleTask$(async () => {
    try {
      locale.value =
        (await getSetting("uiLanguage", "ja")) === "en" ? "en" : "ja";
    } catch {
      locale.value = "ja";
    }
    document.documentElement.lang = locale.value;
  });
  const email = useSignal("");
  const busy = useSignal(false);
  const message = useSignal("");
  const error = useSignal("");
  const devLink = useSignal("");
  const send = $(async () => {
    message.value = "";
    error.value = "";
    devLink.value = "";
    const normalizedEmail = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      error.value = localize(
        locale.value,
        "有効なメールアドレスを入力してください",
        "Enter a valid email address",
      );
      return;
    }
    busy.value = true;
    try {
      const result = await requestMagicLink(normalizedEmail);
      message.value = localize(
        locale.value,
        "ログインリンクを送信しました",
        "Login link sent",
      );
      if (result.devToken)
        devLink.value = `${apiBaseURL}/v1/auth/magic-link/verify?token=${encodeURIComponent(result.devToken)}`;
    } catch (caught) {
      error.value =
        caught instanceof Error
          ? caught.message
          : localize(
              locale.value,
              "ログインリンクを送信できませんでした",
              "Could not send the login link",
            );
    } finally {
      busy.value = false;
    }
  });
  return (
    <main class="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-12">
      <section class="w-full max-w-md border border-slate-200 bg-white p-7 shadow-xl">
        <Link href="/" class="flex items-center gap-3 text-lg font-bold">
          <span class="flex size-9 items-center justify-center bg-slate-950 text-white">
            <Icon name="BookOpen" size={18} />
          </span>
          PaperLens
        </Link>
        <div class="mt-10">
          <h1 class="text-2xl font-bold tracking-[-0.04em]">
            {localize(
              locale.value,
              "PaperLensにログイン",
              "Log in to PaperLens",
            )}
          </h1>
        </div>
        <a
          class="button mt-7 flex w-full"
          href={`${apiBaseURL}/v1/auth/google`}
        >
          <Icon name="Globe" size={16} />
          {localize(locale.value, "Googleでログイン", "Log in with Google")}
        </a>
        <div class="my-7 flex items-center gap-3 text-xs text-slate-400">
          <span class="h-px flex-1 bg-slate-200" />
          {localize(locale.value, "または", "or")}
          <span class="h-px flex-1 bg-slate-200" />
        </div>
        <form preventdefault:submit onSubmit$={send}>
          <label>
            {localize(locale.value, "メールアドレス", "Email address")}
            <input
              class="mt-2 w-full"
              type="email"
              autoComplete="email"
              required
              value={email.value}
              aria-invalid={error.value ? "true" : undefined}
              aria-describedby={error.value ? "email-error" : undefined}
              onInput$={(_, el) => {
                email.value = el.value;
                error.value = "";
              }}
              placeholder="you@example.com"
            />
          </label>
          <button
            type="submit"
            class="button primary mt-4 w-full"
            disabled={busy.value || !email.value.trim()}
          >
            {busy.value
              ? localize(locale.value, "送信中…", "Sending…")
              : localize(
                  locale.value,
                  "マジックリンクを送る",
                  "Send magic link",
                )}
          </button>
        </form>
        {error.value && (
          <p
            id="email-error"
            class="mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            {error.value}
          </p>
        )}
        {message.value && (
          <p
            class="mt-5 border-l-2 border-sky-400 bg-sky-50 p-3 text-sm leading-6 text-sky-900"
            role="status"
          >
            {message.value}
          </p>
        )}
        {devLink.value && (
          <a
            class="mt-3 block break-all text-xs text-sky-700 underline"
            href={devLink.value}
          >
            {localize(
              locale.value,
              "開発用ログインリンクを開く",
              "Open development login link",
            )}
          </a>
        )}
        <Link
          href="/"
          class="mt-7 block text-center text-sm text-slate-500 hover:text-slate-950"
        >
          {localize(locale.value, "ライブラリへ戻る", "Back to library")}
        </Link>
      </section>
    </main>
  );
});

export const head: DocumentHead = { title: "ログイン | PaperLens" };
