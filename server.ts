import { join } from "node:path";
import handler from "./dist/server/server.js";

const clientDir = join(import.meta.dir, "dist/client");
const port = Number(process.env.PORT) || 3000;

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

    return handler.fetch(req);
  },
});

console.log(`listening on :${port}`);
