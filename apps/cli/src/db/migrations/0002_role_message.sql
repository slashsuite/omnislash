CREATE TABLE `role_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team` text NOT NULL,
	`role` text NOT NULL,
	`from_actor` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`body` text NOT NULL,
	`client_key` text,
	`created_at` text NOT NULL,
	`read_at` text,
	`read_by` text,
	`withdrawn_at` text,
	FOREIGN KEY (`team`) REFERENCES `project_group`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_role_message_client_key` ON `role_message` (`client_key`);--> statement-breakpoint
CREATE INDEX `idx_role_message_unread` ON `role_message` (`team`,`role`,`read_at`,`id`);