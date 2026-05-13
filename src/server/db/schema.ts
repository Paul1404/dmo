import { boolean, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const watchedRepos = pgTable(
  "watched_repos",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repoOwner, table.repoName] })],
);

export const mergeJobs = pgTable("merge_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  mergeMethod: text("merge_method").notNull(),
  status: text("status").notNull(),
  totalCount: integer("total_count").notNull(),
  mergedCount: integer("merged_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
});

export const mergeJobItems = pgTable(
  "merge_job_items",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => mergeJobs.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    title: text("title").notNull(),
    htmlUrl: text("html_url").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    waitingSince: timestamp("waiting_since"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.prNumber] })],
);

export const dependabotTemplates = pgTable("dependabot_templates", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  yamlContent: text("yaml_content").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const orchestratorRuns = pgTable("orchestrator_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  totalCount: integer("total_count").notNull(),
  syncedCount: integer("synced_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  error: text("error"),
  templateSnapshot: text("template_snapshot").notNull(),
  commitMessage: text("commit_message").notNull(),
  prTitle: text("pr_title").notNull(),
  prBody: text("pr_body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
});

export const orchestratorRunItems = pgTable(
  "orchestrator_run_items",
  {
    runId: text("run_id")
      .notNull()
      .references(() => orchestratorRuns.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    status: text("status").notNull(),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    branchName: text("branch_name"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.repoOwner, table.repoName] })],
);
