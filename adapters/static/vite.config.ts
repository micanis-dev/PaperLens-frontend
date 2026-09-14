import { staticAdapter } from "@builder.io/qwik-city/adapters/static/vite";
import { extendConfig } from "@builder.io/qwik-city/vite";
import baseConfig from "../../vite.config";

// The reader and library are browser-owned, so the production shell is
// generated as static files and can be served independently by a CDN.
export default extendConfig(baseConfig, () => ({
  build: { ssr: true, rollupOptions: { input: ["@qwik-city-plan"] } },
  plugins: [
    staticAdapter({ origin: "https://paperlens.micanis.dev" }),
  ],
}));
