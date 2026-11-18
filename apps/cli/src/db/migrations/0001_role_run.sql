CREATE TABLE `role_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team` text NOT NULL,
	`role` text NOT NULL,
	`thread_id` text,
	`t3_host` text NOT NULL,
	`started_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`item_count` integer,
	`context_tokens` integer,
	`ended_at` text,
	`end_reason` text,
	FOREIGN KEY (`team`) REFERENCES `project_group`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_role_run_open` ON `role_run` (`team`,`role`) WHERE ended_at IS NULL;