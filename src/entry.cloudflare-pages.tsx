import { createQwikCity } from "@builder.io/qwik-city/middleware/cloudflare-pages";
import qwikCityPlan from "@qwik-city-plan";
import render from "./entry.ssr";

// Cloudflare Workers handles dynamic paper ids here while static assets are
// served through the ASSETS binding by Qwik City's middleware.
export const fetch = createQwikCity({ render, qwikCityPlan });
