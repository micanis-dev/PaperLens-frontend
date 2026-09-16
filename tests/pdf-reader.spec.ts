import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { buildSourceTranslationSegments } from "../src/lib/translation-segments";
import { streamManagedTranslation } from "../src/lib/api";

const encoder = new TextEncoder();

test("splits multi-page translation input deterministically", async () => {
  const segments = await buildSourceTranslationSegments({
    documentId: "paper",
    startPage: 2,
    endPage: 3,
    fallbackText: "unused",
    requestKey: "request-1",
    textByPage: { 2: "a".repeat(12_001), 3: "page three" },
  });

  expect(segments.map(({ pageNumber, order }) => ({ pageNumber, order }))).toEqual([
    { pageNumber: 2, order: 0 },
    { pageNumber: 2, order: 1 },
    { pageNumber: 3, order: 2 },
  ]);
  expect(segments.map((segment) => segment.text.length)).toEqual([
    12_000,
    1,
    10,
  ]);
  expect(segments.map((segment) => segment.textHash)).toEqual([
    "34f8bc846ceca5054db0a22380147ceb23c90f4522daa21ea0b4c597bbd2f620",
    "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    "60a1419be88c7111da0bb9419487a48c4b370f47cac4a13348155b0aa3f60f41",
  ]);
});

test("treats a canceled managed stream as an abort", async () => {
  const originalFetch = globalThis.fetch;
  const source = [
    "event: started\ndata: {\"translationId\":\"server-1\",\"status\":\"running\"}",
    "event: segment\ndata: {\"id\":\"seg-1\",\"pageNumber\":1,\"translatedText\":\"partial\",\"sourceTextHash\":\"hash\"}",
    "event: completed\ndata: {\"status\":\"canceled\"}",
    "",
  ].join("\n\n");
  globalThis.fetch = (async () =>
    new Response(source, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;
  try {
    await expect(
      streamManagedTranslation(
        {
          documentId: "paper",
          sourceLanguage: "auto",
          targetLanguage: "ja",
          segments: [
            { id: "seg-1", pageNumber: 1, order: 0, text: "source", textHash: "hash" },
          ],
          preserveFormatting: true,
        },
        "request-1",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makePdf(pageCount: number) {
  const fontId = 3 + pageCount * 2;
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${3 + index * 2} 0 R`,
  ).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  for (let index = 0; index < pageCount; index++) {
    const contentId = 4 + index * 2;
    const stream = `BT /F1 20 Tf 72 700 Td (PaperLens page ${index + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(source).length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = encoder.encode(source).length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return source;
}

async function seedPaper(page: Page, pageCount = 30) {
  await page.goto("/");
  const pdf = makePdf(pageCount);
  await page.evaluate(
    async ({ source, pages }) => {
      const request = indexedDB.open("paperlens", 3);
      request.onupgradeneeded = () => {
        const database = request.result;
        const papers = database.createObjectStore("papers", { keyPath: "id" });
        papers.createIndex("by-updated-at", "updatedAt");
        papers.createIndex("by-title", "title");
        database.createObjectStore("files", { keyPath: "documentId" });
        const annotations = database.createObjectStore("annotations");
        annotations.createIndex("by-document", "documentId");
        const translations = database.createObjectStore("translations");
        translations.createIndex("by-document", "documentId");
        database.createObjectStore("settings");
      };
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const blob = new Blob([source], { type: "application/pdf" });
      const now = new Date().toISOString();
      const transaction = database.transaction(["papers", "files"], "readwrite");
      transaction.objectStore("papers").put({
        schemaVersion: 1,
        id: "e2e-pdf",
        fileName: "reader-test.pdf",
        fileSize: blob.size,
        fileType: "application/pdf",
        title: "Reader regression test",
        authors: ["PaperLens"],
        tags: [],
        favorite: false,
        rating: 0,
        readingStatus: "unread",
        createdAt: now,
        updatedAt: now,
        reader: { page: 1, zoom: 1, viewMode: "continuous", layout: "pdf" },
      });
      transaction.objectStore("files").put({
        documentId: "e2e-pdf",
        file: blob,
        sha256: "e2e",
        textByPage: Object.fromEntries(
          Array.from({ length: pages }, (_, index) => [
            index + 1,
            `PaperLens page ${index + 1}`,
          ]),
        ),
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    },
    { source: pdf, pages: pageCount },
  );
  await page.goto("/papers/e2e-pdf/");
  await expect(page.locator("[data-pdf-page-host]").first()).toHaveAttribute(
    "data-rendered",
    "true",
  );
}

async function readPaper(page: Page, id: string) {
  return page.evaluate(async (documentId) => {
    const request = indexedDB.open("paperlens", 3);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      const get = database.transaction("papers").objectStore("papers").get(documentId);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return result;
  }, id);
}

test("renders and virtualizes a long PDF", async ({ page }) => {
  await seedPaper(page);
  await expect(page.locator("canvas").first()).toBeVisible();
  const rendered = await page.locator('[data-pdf-page-host][data-rendered="true"]').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(30);

  await page.getByLabel("PDF内検索").fill("PaperLens page 17");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByLabel("ページ番号")).toHaveValue("17");
  await expect(page.locator('[data-pdf-page-host][data-page="17"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
});

test("keeps zoom, text layer, and view mode in sync", async ({ page }) => {
  await seedPaper(page, 3);
  const host = page.locator("[data-pdf-page-host]").first();
  await expect(host).toHaveAttribute("data-render-key", "1:1");
  await page.getByRole("button", { name: "拡大" }).click();
  await expect(host).toHaveAttribute("data-render-key", "1:1.1");

  const geometry = await host.evaluate((element) => {
    const canvas = element.querySelector("canvas")!.getBoundingClientRect();
    const text = element
      .querySelector<HTMLElement>("[data-pdf-text-layer]")!
      .getBoundingClientRect();
    return { canvasWidth: canvas.width, textWidth: text.width };
  });
  expect(Math.abs(geometry.canvasWidth - geometry.textWidth)).toBeLessThan(1);

  await page.getByRole("combobox", { name: "PDF表示方式" }).selectOption("single");
  await expect(page.locator("[data-pdf-page-shell]")).toHaveCount(1);
  await expect(page.locator("[data-pdf-page-host]")).toHaveAttribute(
    "data-rendered",
    "true",
  );
});

test("fits the first mobile PDF to the available width", async ({ page }) => {
  await seedPaper(page, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/papers/e2e-pdf/");
  const canvas = page.locator("[data-pdf-page-host] canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThanOrEqual(375);
  await expect
    .poll(async () => (await readPaper(page, "e2e-pdf")).reader?.fitMode)
    .toBe("width");
});

test("keeps a manually chosen zoom on mobile re-entry", async ({ page }) => {
  await seedPaper(page, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/papers/e2e-pdf/");
  await expect(page.locator("[data-pdf-page-host] canvas").first()).toBeVisible();

  await page.setViewportSize({ width: 768, height: 812 });
  await page.getByRole("button", { name: "拡大" }).click();
  await expect
    .poll(async () => (await readPaper(page, "e2e-pdf")).reader?.fitMode)
    .toBe("manual");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/papers/e2e-pdf/");
  const canvas = page.locator("[data-pdf-page-host] canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(375);
});

test("recalculates fit width when the reader viewport changes", async ({ page }) => {
  await seedPaper(page, 1);
  await page.getByRole("button", { name: "幅に合わせる" }).first().click();
  await expect
    .poll(async () => (await readPaper(page, "e2e-pdf")).reader?.fitMode)
    .toBe("width");
  await page.setViewportSize({ width: 375, height: 812 });
  const canvas = page.locator("[data-pdf-page-host] canvas").first();
  await expect
    .poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThanOrEqual(375);
  await expect
    .poll(async () => (await readPaper(page, "e2e-pdf")).reader?.fitMode)
    .toBe("width");
});

test("downloads the original PDF from a narrow reader toolbar", async ({ page }) => {
  await seedPaper(page, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  const downloadButton = page.getByRole("button", { name: "PDFをダウンロード" });
  await expect(downloadButton).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("reader-test.pdf");
});

test("copies selected PDF text from the reader action bar", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedPaper(page, 1);
  await page.evaluate(() => {
    const textLayer = document.querySelector<HTMLElement>("[data-pdf-text-layer]");
    if (!textLayer) throw new Error("text layer not found");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(textLayer);
    selection.removeAllRanges();
    selection.addRange(range);
    textLayer.closest("[data-pdf-page-shell]")?.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true }),
    );
  });
  const copyButton = page.getByRole("button", { name: "コピー", exact: true });
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(page.locator('[role="status"]').filter({ hasText: "コピーしました" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("PaperLens page 1");
});

test("downloads a paper directly from the library", async ({ page }) => {
  await seedPaper(page, 1);
  await page.goto("/");
  const downloadButton = page.getByRole("button", { name: "Reader regression testをダウンロード" });
  await expect(downloadButton).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  expect((await downloadPromise).suggestedFilename()).toBe("reader-test.pdf");
});

test("keeps library search and filters in the URL", async ({ page }) => {
  await seedPaper(page, 1);
  await page.goto("/");

  await page.getByPlaceholder("タイトル、著者、概要、本文、タグを検索").fill("Reader");
  await page.getByRole("combobox", { name: "すべての状態" }).selectOption("unread");
  await page.getByRole("combobox", { name: "並び替え" }).selectOption("title");

  await expect.poll(() => new URL(page.url()).search).toBe(
    "?q=Reader&status=unread&sort=title",
  );
});

test("returns focus to the quick-switcher trigger after Escape", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "クイックスイッチャー" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "クイックスイッチャー" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "クイックスイッチャー" });
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(trigger).toBeFocused();
});

test("preserves an existing PDF when restoring a ZIP without one", async ({ page }) => {
  await seedPaper(page, 1);
  const paper = await readPaper(page, "e2e-pdf");
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), paperIds: ["e2e-pdf"] })),
    "papers/e2e-pdf.json": strToU8(JSON.stringify(paper)),
    "annotations/e2e-pdf.json": strToU8("[]"),
    "translations/e2e-pdf.json": strToU8("[]"),
  });

  await page.goto("/settings/");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "metadata-only.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await expect(page.getByText("1件の論文をPDF・メタデータごと復元しました。")).toBeVisible();
  await page.goto("/papers/e2e-pdf/");
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("keeps translation in the reader and hides implementation details", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "メインナビゲーション" })).not.toContainText("LLM");
  await page.goto("/settings/");
  await expect(page.getByRole("heading", { name: "LLM接続" })).toBeVisible();
  await expect(page.getByRole("button", { name: /PaperLens LLM/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /User LLM \(API\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /User LLM \(Local\)/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("IndexedDB");
  await expect(page.getByText("接続済み").or(page.getByText("未接続"))).toBeVisible();
});

test("validates LLM settings before making a request", async ({ page }) => {
  await page.goto("/settings/#ai-connection");
  await page.waitForLoadState("networkidle");
  const apiDestination = page.getByRole("button", { name: /User LLM \(API\)/ });
  await apiDestination.click();
  // Qwik loads the event handler lazily on the first interaction. Waiting for
  // the pressed state makes this smoke test cover the completed UI transition
  // on both the dev server and the deployed Worker.
  await expect(apiDestination).toHaveAttribute("aria-pressed", "true");
  await expect(apiDestination).toHaveClass(/border-sky-500/);
  await page.getByLabel("APIプロバイダー").selectOption("openai");
  const model = page.getByLabel("モデル名（必須）");
  await expect(model).toHaveValue("");
  await expect(model).toHaveClass(/border-amber-400/);
  await model.fill("test-model");
  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(page.getByText("APIキーを入力してください")).toBeVisible();

  const localDestination = page.getByRole("button", { name: /User LLM \(Local\)/ });
  await localDestination.click();
  await expect(localDestination).toHaveAttribute("aria-pressed", "true");
  await expect(localDestination).toHaveClass(/border-sky-500/);
  await page.getByLabel("モデル名（必須）").fill("llama3.2");
  await page.locator('input[inputmode="url"]').fill("https://example.com/v1");
  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(
    page.getByText("ローカルLLMの接続先はlocalhostまたはプライベートネットワークに限定してください。"),
  ).toBeVisible();
});

test("keeps narrow screens inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/upload/", "/llm/", "/settings/"]) {
    await page.goto(path);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(375);
  }
});

test("restores focus when the mobile navigation closes", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "メニューを開く" });
  await trigger.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest("[data-mobile-nav]") !== null,
      ),
    )
    .toBe(true);
  const menuItems = page.locator(
    '[data-mobile-nav] a, [data-mobile-nav] button',
  );
  await menuItems.first().focus();
  await page.keyboard.press("Shift+Tab");
  await expect(menuItems.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
