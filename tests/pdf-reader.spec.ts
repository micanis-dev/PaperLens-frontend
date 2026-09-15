import { expect, test, type Page } from "@playwright/test";

const encoder = new TextEncoder();

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
  await page.getByRole("button", { name: /User LLM \(API\)/ }).click();
  await page.getByLabel("APIプロバイダー").selectOption("openai");
  const model = page.getByLabel("モデル名（必須）");
  await expect(model).toHaveValue("");
  await expect(model).toHaveClass(/border-amber-400/);
  await model.fill("test-model");
  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(page.getByText("APIキーを入力してください")).toBeVisible();

  await page.getByRole("button", { name: /User LLM \(Local\)/ }).click();
  await page.getByLabel("モデル名（必須）").fill("llama3.2");
  await page.locator('input[inputmode="url"]').fill("https://example.com/v1");
  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(
    page.getByText("ローカルLLMの接続先はlocalhostまたはプライベートネットワークに限定してください。"),
  ).toBeVisible();
});
