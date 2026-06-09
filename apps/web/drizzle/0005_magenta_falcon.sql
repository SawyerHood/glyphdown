CREATE TABLE `invites` (
	`token` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_by` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);--> statement-breakpoint
CREATE INDEX `invites_target_idx` ON `invites` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `invites_inviter_idx` ON `invites` (`invited_by`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_notifications` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
