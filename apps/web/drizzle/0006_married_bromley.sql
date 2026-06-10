CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`page` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_created_idx` ON `feedback` (`created_at`);