ALTER TABLE `folders` ADD `kind` text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `folders_vault_name_unique` ON `folders` (`owner_user_id`,lower(name)) WHERE kind = 'vault';--> statement-breakpoint
ALTER TABLE `user_prefs` ADD `default_vault_id` text REFERENCES folders(id);