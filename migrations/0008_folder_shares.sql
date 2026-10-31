-- A share link can point at a whole folder (browse + download files + download as zip) instead of a single file.
ALTER TABLE shared_links ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE shared_links ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE CASCADE;
ALTER TABLE shared_links ADD CONSTRAINT shared_links_one_target CHECK ((file_id IS NULL) <> (folder_id IS NULL));
CREATE INDEX shared_links_folder_idx ON shared_links (folder_id) WHERE folder_id IS NOT NULL;
