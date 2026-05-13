import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool);

const startedAt = Date.now();
console.log("running migrations");
try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log(`migrations done in ${Date.now() - startedAt}ms`);
} catch (err) {
  console.error("migrations failed", err);
  await pool.end().catch(() => {});
  process.exit(1);
}

await pool.end();
process.exit(0);
