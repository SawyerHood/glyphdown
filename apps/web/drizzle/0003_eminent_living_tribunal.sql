ALTER TABLE `folders` ADD `parent_id` text REFERENCES folders(id);--> statement-breakpoint
CREATE INDEX `folders_parent_idx` ON `folders` (`parent_id`);