-- Scrub-preview sprite sheets: one JPEG per video holding a grid of small frames, and the grid's geometry.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_kind_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check CHECK (kind IN ('thumbnail', 'subtitle', 'rendition', 'sprite'));
ALTER TABLE media_metadata ADD COLUMN sprite JSONB;
