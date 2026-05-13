import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { log } from "~/server/logger";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool);

const startedAt = Date.now();
log.info("running migrations");
try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  log.info("migrations done", { durationMs: Date.now() - startedAt });
} catch (err) {
  log.error("migrations failed", { err, durationMs: Date.now() - startedAt });
  await pool.end().catch(() => {});
  process.exit(1);
}

await pool.end();
process.exit(0);
