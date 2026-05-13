import { join, resolve } from "node:path";
import handler from "./dist/server/server.js";

const clientDir = resolve(import.meta.dir, "dist/client");
const port = Number(process.env.PORT) || 3000;

const ROOT_STATIC = new Set([
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-16.png",
  "/favicon-32.png",
  "/favicon-48.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  "/robots.txt",
]);

Bun.serve({
  port,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(join(clientDir, url.pathname));
      if (await file.exists()) {
        return new Response(file, {
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        });
      }
    }

    if (ROOT_STATIC.has(url.pathname)) {
      const file = Bun.file(join(clientDir, url.pathname));
      if (await file.exists()) {
        return new Response(file, {
          headers: { "cache-control": "public, max-age=86400" },
        });
      }
    }

    return handler.fetch(req);
  },
});

console.log(`listening on :${port}`);
