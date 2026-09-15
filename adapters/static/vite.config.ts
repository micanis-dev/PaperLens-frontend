import { cloudflarePagesAdapter } from "@builder.io/qwik-city/adapters/cloudflare-pages/vite";
import { extendConfig } from "@builder.io/qwik-city/vite";
import baseConfig from "../../vite.config";

// The reader and library are browser-owned, but paper ids are created locally
// and therefore cannot be enumerated at build time. Use the Worker-compatible
// Qwik City adapter so dynamic paper routes are SSR'd instead of falling back
// to the root library HTML.
export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rollupOptions: {
      input: ["@qwik-city-plan", "src/entry.cloudflare-pages.tsx"],
    },
  },
  plugins: [
    cloudflarePagesAdapter({ origin: "https://paperlens.micanis.dev" }),
  ],
}));
