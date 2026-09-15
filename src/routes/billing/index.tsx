import { component$, $, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { Link, type DocumentHead } from "@builder.io/qwik-city";
import { AppShell } from "~/components/app-shell";
import { Icon } from "~/components/icon";
import {
  BillingPlan,
  changeBillingPlan,
  createCheckout,
  createPortal,
  getBilling,
  getCredits,
  getPlans,
  getUsage,
  PaperLensApiError,
  type CreditBalance,
} from "~/lib/api";
import { localize, useLocale } from "~/lib/i18n";

const planNames: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  ultra: "Ultra",
};

export default component$(() => {
  const locale = useLocale();
  const configured = useSignal(false);
  const currentPlan = useSignal("free");
  const subscriptionStatus = useSignal("active");
  const plans = useSignal<BillingPlan[]>([]);
  const customer = useSignal(false);
  const loading = useSignal(true);
  const busy = useSignal("");
  const message = useSignal("");
  const signedOut = useSignal(false);
  const loadError = useSignal("");
  const pendingPlan = useSignal("");
  const credits = useSignal<CreditBalance>();
  const consumed = useSignal(0);
  const periodEnd = useSignal("");

  // Billing state is loaded after the client session is available.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    try {
      const [billing, catalog, creditResponse, usageResponse] =
        await Promise.all([getBilling(), getPlans(), getCredits(), getUsage()]);
      configured.value = billing.configured;
      currentPlan.value =
        billing.plan?.id || billing.subscription?.planId || "free";
      subscriptionStatus.value =
        billing.subscriptionStatus || billing.subscription?.status || "active";
      plans.value = catalog.plans;
      customer.value = Boolean(billing.subscription?.providerCustomerId);
      pendingPlan.value = billing.subscription?.pendingPlanId || "";
      periodEnd.value = billing.subscription?.currentPeriodEnd || "";
      credits.value = creditResponse.credits;
      consumed.value = usageResponse.usage.creditsConsumed;
    } catch (error) {
      signedOut.value =
        error instanceof PaperLensApiError &&
        error.details.code === "unauthorized";
      message.value =
        error instanceof Error
          ? error.message
          : "課金情報を読み込めませんでした";
      loadError.value = message.value;
      currentPlan.value = "";
      subscriptionStatus.value = "";
      plans.value = [];
    } finally {
      loading.value = false;
    }
  });

  const checkout = $(async (plan: BillingPlan) => {
    if (plan.id === "free") return;
    busy.value = plan.id;
    message.value = "Stripe Checkoutを準備しています…";
    try {
      const result = await createCheckout(plan.id);
      window.location.assign(result.checkout.url);
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : "Checkoutを開始できませんでした";
    } finally {
      busy.value = "";
    }
  });

  const portal = $(async () => {
    busy.value = "portal";
    try {
      const result = await createPortal();
      window.location.assign(result.url);
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : "請求ポータルを開けませんでした";
    } finally {
      busy.value = "";
    }
  });

  const changePlan = $(async (plan: BillingPlan) => {
    const current = plans.value.find((item) => item.id === currentPlan.value);
    const priceChange = current ? plan.monthlyPriceYen - current.monthlyPriceYen : 0;
    const renewal = periodEnd.value
      ? new Intl.DateTimeFormat(locale.value === "en" ? "en-US" : "ja-JP", { dateStyle: "medium" }).format(new Date(periodEnd.value))
      : "";
    const currentName = planNames[currentPlan.value] || currentPlan.value;
    const targetName = planNames[plan.id] || plan.id;
    const priceText = `¥${plan.monthlyPriceYen.toLocaleString()} (${priceChange >= 0 ? "+" : "−"}¥${Math.abs(priceChange).toLocaleString()})`;
    const rank: Record<string, number> = { free: 0, plus: 1, pro: 2, ultra: 3 };
    const upgrade = (rank[plan.id] ?? 0) > (rank[currentPlan.value] ?? 0);
    const timing = upgrade
      ? (locale.value === "en" ? "Upgrade applies immediately; Stripe may charge a prorated difference now." : "アップグレードは即時適用され、Stripeから日割り差額が請求される場合があります。")
      : (locale.value === "en" ? "Downgrade applies at the next renewal." : "ダウングレードは次回更新時に適用されます。");
    const confirmation = locale.value === "en"
      ? "Change from " + currentName + " to " + targetName + "? Monthly price: " + priceText + ". " + timing + (renewal ? " Current period ends " + renewal + "." : "")
      : currentName + "から" + targetName + "へ変更しますか？月額: " + priceText + "。" + timing + (renewal ? `現在の契約期間は${renewal}までです。` : "");
    if (!window.confirm(confirmation)) return;
    busy.value = plan.id;
    message.value = "プラン変更を受け付けています…";
    try {
      const result = await changeBillingPlan(plan.id);
      currentPlan.value = result.subscription.planId || currentPlan.value;
      pendingPlan.value = result.subscription.pendingPlanId || "";
      subscriptionStatus.value = result.subscription.status || subscriptionStatus.value;
      message.value = result.subscription.pendingPlanId
        ? "ダウングレードを次回更新時に予約しました。"
        : "アップグレードをStripeへ依頼しました。Webhook反映後に有効になります。";
    } catch (error) {
      message.value =
        error instanceof Error
          ? error.message
          : "プラン変更を開始できませんでした";
    } finally {
      busy.value = "";
    }
  });

  if (loading.value)
    return (
      <AppShell>
        <p class="text-sm text-slate-500">
          {localize(
            locale.value,
            "課金情報を読み込んでいます…",
            "Loading billing information…",
          )}
        </p>
      </AppShell>
    );
  if (signedOut.value)
    return (
      <AppShell>
        <section class="border border-slate-200 bg-white p-8">
          <h1 class="text-2xl font-bold">
            {localize(locale.value, "課金管理", "Billing")}
          </h1>
          <p class="mt-3 text-sm text-slate-500">
            {localize(
              locale.value,
              "プランを管理するにはログインしてください。",
              "Log in to manage your plan.",
            )}
          </p>
          <Link href="/login/" class="button primary mt-6">
            {localize(locale.value, "ログイン", "Log in")}
          </Link>
        </section>
      </AppShell>
    );
  if (loadError.value)
    return (
      <AppShell>
        <section class="border border-red-200 bg-red-50 p-8" role="alert">
          <h1 class="text-2xl font-bold">{localize(locale.value, "課金情報を取得できません", "Could not load billing information")}</h1>
          <p class="mt-3 text-sm text-red-800">{loadError.value}</p>
          <button type="button" class="button mt-6" onClick$={() => window.location.reload()}>{localize(locale.value, "再読み込み", "Retry")}</button>
        </section>
      </AppShell>
    );
  return (
    <AppShell>
      <section class="app-page max-w-5xl space-y-8">
        <div class="page-heading">
          <h1 class="text-3xl font-bold tracking-[-0.04em]">
            {localize(locale.value, "プランと課金", "Plans & billing")}
          </h1>
        </div>
        {message.value && (
          <p
            class="border-l-2 border-sky-400 bg-sky-50 p-4 text-sm text-sky-900"
            role="status"
          >
            {message.value}
          </p>
        )}
        {!configured.value && (
          <p class="border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            {localize(
              locale.value,
              "Stripeが未設定のため、Checkoutと請求ポータルは現在利用できません。開発環境では決済処理を開始しません。",
              "Checkout and the billing portal are unavailable because Stripe is not configured.",
            )}
          </p>
        )}
        {credits.value && (
          <section class="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-3">
            <div class="bg-white p-5">
              <p class="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                {localize(locale.value, "利用可能", "Available")}
              </p>
              <p class="mt-2 text-2xl font-bold">
                {credits.value.available.toLocaleString()}
              </p>
              <p class="mt-1 text-xs text-slate-500">
                {localize(locale.value, "クレジット", "credits")}
              </p>
            </div>
            <div class="bg-white p-5">
              <p class="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                {localize(locale.value, "使用済み", "Consumed")}
              </p>
              <p class="mt-2 text-2xl font-bold">
                {consumed.value.toLocaleString()}
              </p>
              <p class="mt-1 text-xs text-slate-500">
                {localize(
                  locale.value,
                  "現在の集計期間",
                  "Current accounting period",
                )}
              </p>
            </div>
            <div class="bg-white p-5">
              <p class="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                {localize(locale.value, "有効期限", "Expires")}
              </p>
              <p class="mt-2 text-sm font-bold">
                {new Intl.DateTimeFormat(
                  locale.value === "en" ? "en-US" : "ja-JP",
                  { dateStyle: "medium" },
                ).format(new Date(credits.value.expiresAt))}
              </p>
              <p class="mt-1 text-xs text-slate-500">
                {localize(locale.value, "予約中", "Reserved")}:{" "}
                {credits.value.reserved.toLocaleString()}
              </p>
            </div>
          </section>
        )}
        <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.value.map((plan) => (
            <article
              key={plan.id}
              class={`border bg-white p-5 ${plan.id === currentPlan.value ? "border-sky-400" : "border-slate-200"}`}
            >
              <div class="flex items-center justify-between gap-2">
                <h2 class="font-bold">{planNames[plan.id] || plan.id}</h2>
                {plan.id === currentPlan.value && (
                  <span class="border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] text-sky-800">
                    {localize(locale.value, "現在のプラン", "Current plan")}
                  </span>
                )}
              </div>
              <p class="mt-5 text-2xl font-bold">
                ¥{plan.monthlyPriceYen.toLocaleString()}
                <span class="text-xs font-normal text-slate-500">
                  {" "}
                  / {localize(locale.value, "月", "month")}
                </span>
              </p>
              <p class="mt-3 text-sm text-slate-600">
                {plan.monthlyCredits.toLocaleString()}{" "}
                {localize(locale.value, "クレジット / 月", "credits / month")}
              </p>
              <p class="mt-1 text-xs text-slate-500">
                {localize(locale.value, "1回", "Per request")}{" "}
                {plan.perRequestLimit.toLocaleString()} ·{" "}
                {localize(locale.value, "同時", "Concurrent")}{" "}
                {plan.concurrentLimit}
              </p>
              {plan.id !== "free" && (
                <button
                  type="button"
                  class="button primary mt-5 w-full"
                  disabled={
                    !configured.value ||
                    !!busy.value ||
                    plan.id === currentPlan.value
                  }
                  onClick$={() =>
                    customer.value && currentPlan.value !== "free"
                      ? changePlan(plan)
                      : checkout(plan)
                  }
                >
                  {busy.value === plan.id
                    ? localize(locale.value, "準備中…", "Preparing…")
                    : plan.id === currentPlan.value
                      ? localize(locale.value, "契約中", "Subscribed")
                      : customer.value && currentPlan.value !== "free"
                        ? localize(locale.value, "プランを変更", "Change plan")
                        : "Checkout"}
                </button>
              )}
              {plan.id === "free" &&
                currentPlan.value !== "free" &&
                customer.value && (
                  <button
                    type="button"
                    class="button mt-5 w-full"
                    disabled={!!busy.value}
                    onClick$={() => changePlan(plan)}
                  >
                    {busy.value === plan.id
                      ? localize(locale.value, "予約中…", "Scheduling…")
                      : localize(
                          locale.value,
                          "Freeへ変更",
                          "Downgrade to Free",
                        )}
                  </button>
                )}
            </article>
          ))}
        </section>
        <section class="border border-slate-200 bg-white p-6">
          <h2 class="font-bold">
            {localize(locale.value, "契約状態", "Subscription status")}
          </h2>
          <dl class="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt class="text-slate-500">
                {localize(locale.value, "状態", "Status")}
              </dt>
              <dd class="mt-1 font-semibold">{subscriptionStatus.value}</dd>
            </div>
            {periodEnd.value && <div><dt class="text-slate-500">{localize(locale.value, "次回更新日", "Next renewal")}</dt><dd class="mt-1 font-semibold">{new Intl.DateTimeFormat(locale.value === "en" ? "en-US" : "ja-JP", { dateStyle: "medium" }).format(new Date(periodEnd.value))}</dd></div>}
            <div>
              <dt class="text-slate-500">
                {localize(locale.value, "現在のプラン", "Current plan")}
              </dt>
              <dd class="mt-1 font-semibold">
                {planNames[currentPlan.value] || currentPlan.value}
              </dd>
            </div>
            <div>
              <dt class="text-slate-500">
                Stripe {localize(locale.value, "顧客", "customer")}
              </dt>
              <dd class="mt-1 font-semibold">
                {customer.value
                  ? localize(locale.value, "登録済み", "Active")
                  : localize(locale.value, "未登録", "Not registered")}
              </dd>
            </div>
          </dl>
          {customer.value && (
            <button
              type="button"
              class="button mt-5"
              disabled={!!busy.value}
              onClick$={portal}
            >
              <Icon name="CreditCard" size={16} />
              {localize(
                locale.value,
                "Stripe請求ポータルを開く",
                "Open Stripe billing portal",
              )}
            </button>
          )}
        </section>
        {pendingPlan.value && (
          <p class="border-l-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
            {localize(
              locale.value,
              "次回更新時に",
              "Scheduled for next renewal: ",
            )}
            {planNames[pendingPlan.value] || pendingPlan.value}
            {localize(
              locale.value,
              "へ変更されます。現在の契約期間中は現プランを利用できます。",
              ". The current plan remains available during this billing period.",
            )}
          </p>
        )}
      </section>
    </AppShell>
  );
});

export const head: DocumentHead = { title: "プランと課金 | PaperLens" };
