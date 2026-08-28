import { Hono } from "hono";

const FAVICON_TTL = 60 * 60 * 24; // 24h

export const faviconRoutes = () => {
  const app = new Hono();

  // GET /
  app.get("/", async (c) => {
    const domain = c.req.query("domain");

    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return new Response(null, { status: 400 });
    }

    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

    try {
      const res = await fetch(url);
      if (!res.ok) return new Response(null, { status: 502 });

      const contentType = res.headers.get("content-type") ?? "image/png";
      const body = await res.arrayBuffer();

      return new Response(body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": `public, max-age=${FAVICON_TTL}, immutable`,
        },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  });

  return app;
};
