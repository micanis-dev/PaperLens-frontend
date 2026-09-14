export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const acceptsHTML = (request.headers.get("Accept") || "").includes(
      "text/html",
    );
    if (response.status === 404 && request.method === "GET" && acceptsHTML) {
      const fallback = new URL(request.url);
      fallback.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(fallback, request));
    }
    return response;
  },
};
