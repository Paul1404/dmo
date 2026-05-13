CREATE TABLE "watched_repos" (
	"user_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "watched_repos_user_id_repo_owner_repo_name_pk" PRIMARY KEY("user_id","repo_owner","repo_name")
);
--> statement-breakpoint
ALTER TABLE "watched_repos" ADD CONSTRAINT "watched_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;