CREATE TABLE "dependabot_templates" (
	"user_id" text PRIMARY KEY NOT NULL,
	"yaml_content" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_run_items" (
	"run_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"status" text NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"branch_name" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "orchestrator_run_items_run_id_repo_owner_repo_name_pk" PRIMARY KEY("run_id","repo_owner","repo_name")
);
--> statement-breakpoint
CREATE TABLE "orchestrator_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"total_count" integer NOT NULL,
	"synced_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"template_snapshot" text NOT NULL,
	"commit_message" text NOT NULL,
	"pr_title" text NOT NULL,
	"pr_body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "dependabot_templates" ADD CONSTRAINT "dependabot_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrator_run_items" ADD CONSTRAINT "orchestrator_run_items_run_id_orchestrator_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."orchestrator_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrator_runs" ADD CONSTRAINT "orchestrator_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;