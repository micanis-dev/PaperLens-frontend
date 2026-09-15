import {
  $,
  component$,
  isDev,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, type DocumentHead, useLocation } from "@builder.io/qwik-city";
import { Icon } from "~/components/icon";
import {
  apiBaseURL,
  getDevTestUsers,
  registerPassword,
  type DevTestUser,
} from "~/lib/api";
import { getSetting } from "~/lib/storage";
import { localize, type Locale } from "~/lib/i18n";

const ssoProviders = ["apple", "google", "github"] as const;

export default component$(() => {
  const locale = useSignal<Locale>("ja");
  const testUsers = useSignal<DevTestUser[]>([]);
  const email = useSignal("");
  const password = useSignal("");
  const busy = useSignal(false);
  const error = useSignal("");
  const location = useLocation();
  const returnTo = (() => { const value = location.url.searchParams.get("returnTo"); return value && value.startsWith("/") && !value.startsWith("//") ? value : "/"; })();
  // Registration preferences are stored in the browser.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    try {
      locale.value =
        (await getSetting("uiLanguage", "ja")) === "en" ? "en" : "ja";
      document.documentElement.lang = locale.value;
    } catch {
      locale.value = "ja";
    }
    if (isDev) {
      try {
        testUsers.value = (await getDevTestUsers()).users;
      } catch {
        testUsers.value = [];
      }
    }
  });
  const register = $(async () => {
    error.value = "";
    busy.value = true;
    try {
      await registerPassword(email.value.trim(), password.value);
      window.location.assign(returnTo);
    } catch (caught) {
      error.value =
        caught instanceof Error
          ? caught.message
          : localize(
              locale.value,
              "登録できませんでした",
              "Could not create the account",
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
              "PaperLensを始める",
              "Create your PaperLens account",
            )}
          </h1>
          <p class="mt-3 text-sm leading-6 text-slate-500">
            {localize(
              locale.value,
              "メールアドレスとパスワード、またはSSOで登録できます。",
              "Register with an email and password, or with SSO.",
            )}
          </p>
        </div>
        <form preventdefault:submit onSubmit$={register} class="mt-7">
          <label>
            {localize(locale.value, "メールアドレス", "Email address")}
            <input
              class="mt-2 w-full"
              type="email"
              required
              autoComplete="email"
              value={email.value}
              onInput$={(_, el) => { email.value = el.value; error.value = ""; }}
            />
          </label>
          <label class="mt-4 block">
            {localize(
              locale.value,
              "パスワード（12文字以上）",
              "Password (12+ characters)",
            )}
            <input
              class="mt-2 w-full"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password.value}
              onInput$={(_, el) => { password.value = el.value; error.value = ""; }}
            />
          </label>
          <button
            type="submit"
            class="button primary mt-5 w-full"
            disabled={
              busy.value || !email.value.trim() || password.value.length < 12
            }
          >
            {busy.value
              ? localize(locale.value, "登録中…", "Creating…")
              : localize(
                  locale.value,
                  "メールアドレスで登録",
                  "Create with email",
                )}
          </button>
        </form>
        <div class="my-6 flex items-center gap-3 text-xs text-slate-400">
          <span class="h-px flex-1 bg-slate-200" />
          {localize(locale.value, "またはSSO", "or continue with SSO")}
          <span class="h-px flex-1 bg-slate-200" />
        </div>
        <div class="grid gap-2 sm:grid-cols-3">
          {ssoProviders.map((provider) => (
            <a
              key={provider}
              class="button subtle text-xs"
              href={`${apiBaseURL}/v1/auth/${provider}/signup`}
            >
              {provider === "apple"
                ? "Apple"
                : provider === "google"
                  ? "Google"
                  : "GitHub"}
            </a>
          ))}
        </div>
        {error.value && (
          <p
            class="mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            {error.value}
          </p>
        )}
        {isDev && testUsers.value.length > 0 && (
          <p class="mt-4 text-center text-xs text-slate-400">
            {localize(
              locale.value,
              "開発環境ではログイン画面からテストユーザーを選べます",
              "In development, choose a test user from the login screen",
            )}
          </p>
        )}
        <Link
          href="/login/"
          class="mt-7 block text-center text-sm text-slate-500 hover:text-slate-950"
        >
          {localize(
            locale.value,
            "すでにアカウントをお持ちですか？ログイン",
            "Already have an account? Log in",
          )}
        </Link>
      </section>
    </main>
  );
});

export const head: DocumentHead = { title: "新規登録 | PaperLens" };
