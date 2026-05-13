import { serverOnly$ } from "vite-env-only/macros";

function read(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const env = serverOnly$({
  DATABASE_URL: read("DATABASE_URL"),
  BETTER_AUTH_SECRET: read("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: read("BETTER_AUTH_URL", "http://localhost:3000"),
  GITHUB_CLIENT_ID: read("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: read("GITHUB_CLIENT_SECRET"),
})!;
