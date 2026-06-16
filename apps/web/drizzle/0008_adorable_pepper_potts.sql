CREATE TABLE `content_objects` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`refcount` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size` integer NOT NULL,
	`etag` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`message` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_hash`) REFERENCES `content_objects`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asset_versions_asset_idx` ON `asset_versions` (`asset_id`);--> statement-breakpoint
CREATE INDEX `asset_versions_content_hash_idx` ON `asset_versions` (`content_hash`);--> statement-breakpoint
ALTER TABLE `assets` ADD `current_version_id` text REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE set null;
