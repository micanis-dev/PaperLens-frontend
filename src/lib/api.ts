export type TranslationMode =
  | "paperlens-managed"
  | "openai"
  | "google"
  | "anthropic"
  | "openai-compatible"
  | "local";

export type TranslationSegment = {
  id: string;
  pageNumber: number;
  order: number;
  text: string;
  textHash: string;
};

export type TranslationRequest = {
  documentId: string;
  sourceLanguage: string | "auto";
  targetLanguage: string;
  model?: string;
  segments: TranslationSegment[];
  glossary?: { source: string; translation: string }[];
  preserveFormatting: boolean;
};

export type TranslationResult = {
  requestId: string;
  segments: {
    id: string;
    pageNumber: number;
    sequence?: number;
    translatedText: string;
    sourceTextHash: string;
    sourceText?: string;
  }[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    creditsUsed: number;
  };
  provider: {
    mode: TranslationMode;
    name: string;
    model: string;
  };
  warnings: string[];
};

export type ApiErrorCode = "unauthorized" | "forbidden" | "insufficient_credits" | "rate_limited" | "request_too_large" | "provider_unavailable" | "translation_failed" | "idempotency_conflict" | "invalid_request";

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
};

export type ManagedTranslationEvent =
  | { type: "started"; data: { translationId: string; status: string } }
  | { type: "segment"; data: TranslationResult["segments"][number] }
  | { type: "usage"; data: TranslationResult["usage"] }
  | { type: "completed"; data: { result?: TranslationResult; status: string } }
  | { type: "failed"; data: ApiError };

export class PaperLensApiError extends Error {
  readonly details: ApiError;
  readonly status: number;

  constructor(status: number, details: ApiError) {
    super(details.message);
    this.name = "PaperLensApiError";
    this.status = status;
    this.details = details;
  }
}

export const apiBaseURL = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseURL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    throw new PaperLensApiError(response.status, body as ApiError);
  }
  return body as T;
}

export function estimateTranslation(payload: TranslationRequest) {
  return request<{ requestId: string; estimate: { model: string; inputTokens: number; estimatedOutputTokens: number; estimatedCredits: number } }>(
    "/v1/translations/estimate",
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function startManagedTranslation(payload: TranslationRequest, idempotencyKey: string) {
  return request<{ requestId: string; translation: { id: string; status: string; result?: TranslationResult } }>(
    "/v1/translations",
    { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) },
  );
}

export async function checkManagedAccess() {
  return request<{ requestId: string; account: { userId: string; plan: { id: string } } }>("/v1/account");
}

export type AccountDeletion = { requestedAt: string; executeAt: string };

export function getAccount() {
  return request<{ requestId: string; account: { userId: string; plan: { id: string }; subscription: string }; deletion?: AccountDeletion }>("/v1/account");
}

export function requestAccountDeletion() {
  return request<{ requestId: string; deletion: AccountDeletion }>("/v1/account/deletion", { method: "POST", body: "{}" });
}

export function cancelAccountDeletion() {
  return request<{ requestId: string; canceled: boolean }>("/v1/account/deletion/cancel", { method: "POST", body: "{}" });
}

export function cancelManagedTranslation(id: string) {
  return request<{ requestId: string; translation: { id: string; status: string } }>(`/v1/translations/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

export type BillingPlan = {
  id: string;
  monthlyPriceYen: number;
  priceVersion: string;
  monthlyCredits: number;
  dailyCredits: number;
  perRequestLimit: number;
  concurrentLimit: number;
  priority: string;
};

export type BillingSubscription = {
  id: string;
  planId: string;
  status: string;
  currentPeriodEnd?: string;
  graceUntil?: string;
  cancelAtPeriodEnd: boolean;
  providerCustomerId?: string;
  pendingPlanId?: string;
  pendingPlanAt?: string;
};

export function getBilling() {
  return request<{ requestId: string; configured: boolean; plan?: BillingPlan; subscriptionStatus?: string; subscription?: BillingSubscription }>("/v1/billing");
}

export function getPlans() {
  return request<{ requestId: string; plans: BillingPlan[] }>("/v1/plans");
}

export type CreditBalance = {
  planId: string;
  available: number;
  reserved: number;
  expiresAt: string;
  rateVersion: string;
};

export function getCredits() {
  return request<{ requestId: string; credits: CreditBalance }>("/v1/credits");
}

export function getUsage() {
  return request<{ requestId: string; usage: { creditsConsumed: number; creditsReserved: number } }>("/v1/usage");
}

export function createCheckout(planId: string) {
  return request<{ requestId: string; checkout: { id: string; url: string } }>("/v1/checkout", { method: "POST", body: JSON.stringify({ planId }) });
}

export function createPortal() {
  return request<{ requestId: string; url: string }>("/v1/portal", { method: "POST", body: "{}" });
}

export function changeBillingPlan(planId: string) {
  return request<{ requestId: string; subscription: BillingSubscription }>("/v1/billing/change-plan", { method: "POST", body: JSON.stringify({ planId }) });
}

export function logoutManagedSession() {
  return request<{ requestId: string; loggedOut: boolean }>("/v1/auth/logout", { method: "POST" });
}

export function registerPassword(email: string, password: string) {
  return request<{ requestId: string; registered: boolean }>("/v1/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function loginPassword(email: string, password: string) {
  return request<{ requestId: string; loggedIn: boolean }>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export type LinkedIdentity = { provider: "apple" | "google" | "github" };

export function getLinkedIdentities() {
  return request<{ requestId: string; identities: LinkedIdentity[] }>("/v1/auth/identities");
}

export function unlinkIdentity(provider: LinkedIdentity["provider"]) {
  return request<{ requestId: string; unlinked: boolean }>(`/v1/auth/identities/${encodeURIComponent(provider)}`, { method: "DELETE", body: "{}" });
}

export function requestMagicLink(email: string) {
  return request<{ requestId: string; sent: boolean; devToken?: string }>("/v1/auth/magic-link", { method: "POST", body: JSON.stringify({ email }) });
}

export type DevTestUser = { id: string; label: string };

export function getDevTestUsers() {
  return request<{ requestId: string; users: DevTestUser[] }>("/v1/auth/test-users");
}

export function loginAsDevTestUser(userID: string) {
  return request<{ requestId: string; user: DevTestUser }>(`/v1/auth/test-users/${encodeURIComponent(userID)}`, { method: "POST", body: "{}" });
}

export async function streamManagedTranslation(
  payload: TranslationRequest,
  idempotencyKey: string,
  onEvent?: (event: ManagedTranslationEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${apiBaseURL}/v1/translations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const body = await response.json() as ApiError;
    throw new PaperLensApiError(response.status, body);
  }
  if (!response.body) throw new Error("PaperLens LLMのストリームが利用できません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: TranslationResult | undefined;
  const consume = (chunk: string) => {
    buffer += chunk;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = block.match(/^event:\s*(\S+)/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data) as unknown;
      if (event === "completed") completed = (parsed as { result?: TranslationResult }).result;
      onEvent?.({ type: event as ManagedTranslationEvent["type"], data: parsed } as ManagedTranslationEvent);
      if (event === "failed") {
        const details = parsed as ApiError;
        throw new PaperLensApiError(502, details);
      }
    }
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    consume(decoder.decode(next.value, { stream: true }));
  }
  consume(decoder.decode());
  return completed;
}
