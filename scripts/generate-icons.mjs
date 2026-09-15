import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Preserve the original artwork; all icon sizes share these exact paths.
const source = await readFile(
  new URL("../読解する頁.svg", import.meta.url),
  "utf8",
);
const paths = source
  .match(/<path\b[^>]*\/>/g)
  .join("")
  .replaceAll('fill="#4a4636"', 'fill="url(#paper)"');
const svg = (
  rounded = false,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <title>PaperLens</title>
  <defs>
    <linearGradient id="ground" x1="128" y1="0" x2="896" y2="1024" gradientUnits="userSpaceOnUse">
      <stop stop-color="#38BDF8"/><stop offset=".52" stop-color="#0EA5E9"/><stop offset="1" stop-color="#0369A1"/>
    </linearGradient>
    <radialGradient id="light" cx="0" cy="0" r="1" gradientTransform="translate(260 80) rotate(60) scale(900 820)" gradientUnits="userSpaceOnUse">
      <stop stop-color="#E0F2FE" stop-opacity=".16"/><stop offset="1" stop-color="#E0F2FE" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="paper" x1="20" y1="8" x2="45" y2="56" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#F0F9FF"/>
    </linearGradient>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy=".8" stdDeviation=".8" flood-color="#075985" flood-opacity=".20"/>
    </filter>
    <clipPath id="tile"><rect width="1024" height="1024" rx="${rounded ? 224 : 0}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <path fill="url(#ground)" d="M0 0h1024v1024H0z"/>
    <path fill="url(#light)" d="M0 0h1024v1024H0z"/>
    <g transform="translate(102.3488 101.6488) scale(12.8)" filter="url(#shadow)">${paths}</g>
  </g>
</svg>\n`;

const publicDir = new URL("../public/", import.meta.url);
await mkdir(new URL("icons/", publicDir), { recursive: true });
await writeFile(new URL("icons/app-icon.svg", publicDir), svg());
await writeFile(new URL("favicon.svg", publicDir), svg(true));
await writeFile(new URL("icons/paperlens-sky-v1.svg", publicDir), svg(true));
const browser = await chromium.launch({ headless: true });
try {
  for (const [file, size] of [
    ["icons/paperlens-sky-v1-32.png", 32],
    ["icons/app-icon-1024.png", 1024],
    ["icons/icon-512.png", 512],
    ["icons/icon-192.png", 192],
    ["apple-touch-icon.png", 180],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg(size === 32)}`,
    );
    await page.screenshot({
      path: new URL(file, publicDir).pathname,
      omitBackground: false,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
