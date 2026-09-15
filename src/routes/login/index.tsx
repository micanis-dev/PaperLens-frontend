import {
  component$,
  $,
  isDev,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { Link, type DocumentHead, useNavigate } from "@builder.io/qwik-city";
import { Icon } from "~/components/icon";
import {
  apiBaseURL,
  getDevTestUsers,
  loginAsDevTestUser,
  loginPassword,
  type DevTestUser,
} from "~/lib/api";
import { getSetting } from "~/lib/storage";
import { localize, type Locale } from "~/lib/i18n";

export default component$(() => {
  const locale = useSignal<Locale>("ja");
  // Login preferences are stored in the browser.
  // eslint-disable-next-line qwik/no-use-visible-task
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
  const password = useSignal("");
  const busy = useSignal(false);
  const error = useSignal("");
  const testUsers = useSignal<DevTestUser[]>([]);
  const testUserBusy = useSignal("");
  const navigate = useNavigate();
  const send = $(async () => {
    error.value = "";
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
      await loginPassword(normalizedEmail, password.value);
      window.location.assign("/");
    } catch (caught) {
      error.value =
        caught instanceof Error
          ? caught.message
          : localize(
              locale.value,
              "ログインできませんでした",
              "Could not log in",
            );
    } finally {
      busy.value = false;
    }
  });
  const loginAsTestUser = $(async (user: DevTestUser) => {
    testUserBusy.value = user.id;
    error.value = "";
    try {
      await loginAsDevTestUser(user.id);
      await navigate("/");
    } catch (caught) {
      error.value =
        caught instanceof Error
          ? caught.message
          : "Could not log in as the test user";
    } finally {
      testUserBusy.value = "";
    }
  });
  // Complete the browser redirect after hydration.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    if (!isDev) return;
    try {
      testUsers.value = (await getDevTestUsers()).users;
    } catch {
      testUsers.value = [];
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
        <form preventdefault:submit onSubmit$={send} class="mt-7">
          <label>
            {localize(locale.value, "メールアドレス", "Email address")}
            <input
              class="mt-2 w-full"
              type="email"
              autoComplete="email"
              required
              value={email.value}
              aria-invalid={error.value ? "true" : undefined}
              onInput$={(_, el) => {
                email.value = el.value;
                error.value = "";
              }}
              placeholder="you@example.com"
            />
          </label>
          <label class="mt-4 block">
            {localize(locale.value, "パスワード", "Password")}
            <input
              class="mt-2 w-full"
              type="password"
              autoComplete="current-password"
              required
              value={password.value}
              onInput$={(_, el) => {
                password.value = el.value;
                error.value = "";
              }}
            />
          </label>
          <button
            type="submit"
            class="button primary mt-5 w-full"
            disabled={busy.value || !email.value.trim() || !password.value}
          >
            {busy.value
              ? localize(locale.value, "ログイン中…", "Logging in…")
              : localize(
                  locale.value,
                  "メールアドレスでログイン",
                  "Log in with email",
                )}
          </button>
        </form>
        <div class="my-6 flex items-center gap-3 text-xs text-slate-400">
          <span class="h-px flex-1 bg-slate-200" />
          {localize(locale.value, "またはSSO", "or continue with SSO")}
          <span class="h-px flex-1 bg-slate-200" />
        </div>
        <div class="grid gap-2 sm:grid-cols-3">
          {(["apple", "google", "github"] as const).map((provider) => (
            <a
              key={provider}
              class="button subtle text-xs"
              href={`${apiBaseURL}/v1/auth/${provider}`}
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
            id="email-error"
            class="mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            {error.value}
          </p>
        )}
        {isDev && testUsers.value.length > 0 && (
          <aside class="mt-7 border-t border-dashed border-amber-300 pt-5">
            <p class="text-xs font-bold uppercase tracking-[0.12em] text-amber-700">
              {localize(
                locale.value,
                "開発用テストユーザー",
                "Development test users",
              )}
            </p>
            <div class="mt-3 grid grid-cols-2 gap-2">
              {testUsers.value.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  class="button subtle text-xs"
                  disabled={Boolean(testUserBusy.value)}
                  onClick$={() => loginAsTestUser(user)}
                >
                  {testUserBusy.value === user.id ? "…" : user.label}
                </button>
              ))}
            </div>
          </aside>
        )}
        <Link
          href="/register/"
          class="mt-5 block text-center text-sm text-sky-700 hover:text-sky-950"
        >
          {localize(locale.value, "新規登録はこちら", "Create a new account")}
        </Link>
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
