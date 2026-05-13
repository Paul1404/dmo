import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "~/server/env";
import * as schema from "./schema";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
export { schema };
