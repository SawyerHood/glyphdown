ALTER TABLE `docs` ADD `filename` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill: every doc's canonical filename = slugified title + '.md'.
-- Mirrors slugifyDocStem in @glyphdown/protocol: lowercase, every
-- non-[a-z0-9] run collapsed to one '-', edge dashes trimmed, 'untitled'
-- fallback. The recursive `walk` lowercases and maps the title one character
-- at a time (non-ASCII compares above 'z' under BINARY collation, so it maps
-- to '-' exactly like the JS [^a-z0-9] class); `collapsed` squeezes dash
-- runs to a fixed point; `named` trims and applies the fallback.
WITH RECURSIVE
  walk(id, rest, acc) AS (
    SELECT id, lower(title), '' FROM docs
    UNION ALL
    SELECT id, substr(rest, 2),
      acc || CASE
        WHEN (substr(rest, 1, 1) >= 'a' AND substr(rest, 1, 1) <= 'z')
          OR (substr(rest, 1, 1) >= '0' AND substr(rest, 1, 1) <= '9')
        THEN substr(rest, 1, 1) ELSE '-' END
    FROM walk WHERE rest <> ''
  ),
  collapsed(id, slug) AS (
    SELECT id, acc FROM walk WHERE rest = ''
    UNION ALL
    SELECT id, replace(slug, '--', '-') FROM collapsed WHERE slug LIKE '%--%'
  ),
  named AS MATERIALIZED (
    SELECT id, CASE WHEN trim(slug, '-') = '' THEN 'untitled' ELSE trim(slug, '-') END AS slug
    FROM collapsed WHERE slug NOT LIKE '%--%'
  )
UPDATE docs SET filename = (SELECT slug || '.md' FROM named WHERE named.id = docs.id);--> statement-breakpoint
-- Dedupe within each scope (same folder_id, or per-owner root), LIVE docs
-- only (soft-deleted docs release their name, matching the partial unique
-- indexes below). Deterministic: rows are ranked by (created_at, id) and
-- every duplicate after the first gets a '-<rank>' suffix. Three passes
-- because a suffixed name can itself collide with a pre-existing base name
-- (titles "Foo", "Foo", "Foo 2" → foo, foo-2, foo-2 → second pass splits the
-- new tie the same deterministic way).
WITH ranked AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY owner_user_id, COALESCE(folder_id, ''), filename
    ORDER BY created_at, id
  ) AS rn
  FROM docs WHERE deleted_at IS NULL
)
UPDATE docs
SET filename = substr(filename, 1, length(filename) - 3) || '-' || (SELECT rn FROM ranked WHERE ranked.id = docs.id) || '.md'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
WITH ranked AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY owner_user_id, COALESCE(folder_id, ''), filename
    ORDER BY created_at, id
  ) AS rn
  FROM docs WHERE deleted_at IS NULL
)
UPDATE docs
SET filename = substr(filename, 1, length(filename) - 3) || '-' || (SELECT rn FROM ranked WHERE ranked.id = docs.id) || '.md'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
WITH ranked AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY owner_user_id, COALESCE(folder_id, ''), filename
    ORDER BY created_at, id
  ) AS rn
  FROM docs WHERE deleted_at IS NULL
)
UPDATE docs
SET filename = substr(filename, 1, length(filename) - 3) || '-' || (SELECT rn FROM ranked WHERE ranked.id = docs.id) || '.md'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
-- Safety net for adversarial title sets that still collide after three
-- passes: append the doc's own id (a UUID — lowercase hex + dashes, already
-- inside the filename charset), which is unique by construction.
WITH ranked AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY owner_user_id, COALESCE(folder_id, ''), filename
    ORDER BY created_at, id
  ) AS rn
  FROM docs WHERE deleted_at IS NULL
)
UPDATE docs
SET filename = substr(filename, 1, length(filename) - 3) || '-' || id || '.md'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX `docs_folder_filename_unique` ON `docs` (`folder_id`,`filename`) WHERE folder_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `docs_root_filename_unique` ON `docs` (`owner_user_id`,`filename`) WHERE folder_id IS NULL AND deleted_at IS NULL;
