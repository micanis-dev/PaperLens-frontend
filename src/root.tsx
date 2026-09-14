import {
  component$,
  isDev,
  useContextProvider,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import { QwikCityProvider, RouterOutlet } from "@builder.io/qwik-city";
import { RouterHead } from "./components/router-head/router-head";
import { getSetting } from "./lib/storage";
import { localeContext, type Locale } from "./lib/i18n";

import "./global.css";
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";

export default component$(() => {
  /**
   * The root of a QwikCity site always start with the <QwikCityProvider> component,
   * immediately followed by the document's <head> and <body>.
   *
   * Don't remove the `<head>` and `<body>` elements.
   */

  const locale = useSignal<Locale>("ja");
  useContextProvider(localeContext, locale);
  useVisibleTask$(async () => {
    try {
      const saved = await getSetting("uiLanguage", "ja");
      locale.value = saved === "en" ? "en" : "ja";
      document.documentElement.lang = locale.value;
    } catch {
      // The shell remains usable when IndexedDB is unavailable; settings will
      // report the storage problem instead of preventing the app from booting.
      document.documentElement.lang = "ja";
    }
    if (!isDev && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`)
        .catch(() => undefined);
    }
  });

  return (
    <QwikCityProvider>
      <head>
        <meta charset="utf-8" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' http: https:; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
        />
        {!isDev && (
          <link
            rel="manifest"
            href={`${import.meta.env.BASE_URL}manifest.json`}
          />
        )}
        <RouterHead />
      </head>
      <body lang={locale.value}>
        <RouterOutlet />
      </body>
    </QwikCityProvider>
  );
});
