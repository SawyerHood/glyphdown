CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`folder_id` text,
	`doc_id` text,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`etag` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_id`) REFERENCES `docs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_folder_filename_idx` ON `assets` (`folder_id`,`filename`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_doc_filename_idx` ON `assets` (`doc_id`,`filename`);