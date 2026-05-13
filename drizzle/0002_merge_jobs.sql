CREATE TABLE "merge_job_items" (
	"job_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"title" text NOT NULL,
	"html_url" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"waiting_since" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merge_job_items_job_id_pr_number_pk" PRIMARY KEY("job_id","pr_number")
);
--> statement-breakpoint
CREATE TABLE "merge_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"merge_method" text NOT NULL,
	"status" text NOT NULL,
	"total_count" integer NOT NULL,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "merge_job_items" ADD CONSTRAINT "merge_job_items_job_id_merge_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."merge_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_jobs" ADD CONSTRAINT "merge_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;