-- Reflection feature: snapshot the issue title/url onto each rating (so the
-- personal history views can render it after the pending row is gone) and add an
-- optional free-text diary note. Mirrors the new columns in worker/src/db/schema.sql.
ALTER TABLE ratings ADD COLUMN notes TEXT;
ALTER TABLE ratings ADD COLUMN title TEXT;
ALTER TABLE ratings ADD COLUMN url TEXT;
