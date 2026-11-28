CREATE TABLE `scheduled_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_expr` text NOT NULL,
	`target_kind` text NOT NULL,
	`team` text,
	`role` text,
	`prompt` text,
	`command` text,
	`cwd` text,
	`host` text,
	`respect_good_night` integer DEFAULT 1 NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_status` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`team`) REFERENCES `project_group`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scheduled_job_name` ON `scheduled_job` (`name`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_job_due` ON `scheduled_job` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `scheduled_job_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`host` text,
	`exit_code` integer,
	`output_tail` text,
	`role_message_id` integer,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_job`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_job_run_job` ON `scheduled_job_run` (`job_id`,`id`);