-- ============================================================================
-- RECAP STUDIO AI — SUPABASE FREE PLAN MIGRATION (SAFE & IDEMPOTENT)
-- Copy and execute this entire script in:
--   Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Safety guarantees:
--   • Never drops or recreates existing tables
--   • Never deletes or overwrites existing data
--   • Never inserts sample/fake projects
--   • Safe to re-run multiple times (idempotent)
--   • Strictly fits Supabase Free Plan limits (500 MB DB, 1 GB Storage, 50 MB/file)
-- ============================================================================

-- 1. public.recap_projects
CREATE TABLE IF NOT EXISTS public.recap_projects (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_data JSONB NOT NULL,
  asset_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_version BIGINT NOT NULL DEFAULT 1,
  last_device_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_recap_projects_sync_version CHECK (sync_version >= 1)
);

ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS project_data JSONB;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS asset_manifest JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS last_device_id TEXT;
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.recap_projects
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_recap_projects_user_updated
  ON public.recap_projects(user_id, updated_at DESC);

ALTER TABLE public.recap_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own recap projects" ON public.recap_projects;
CREATE POLICY "Users can view own recap projects"
  ON public.recap_projects FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own recap projects" ON public.recap_projects;
CREATE POLICY "Users can insert own recap projects"
  ON public.recap_projects FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own recap projects" ON public.recap_projects;
CREATE POLICY "Users can update own recap projects"
  ON public.recap_projects FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own recap projects" ON public.recap_projects;
CREATE POLICY "Users can delete own recap projects"
  ON public.recap_projects FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 2. public.recap_cloud_assets (SHA-256 deduplicated cloud media registry)
CREATE TABLE IF NOT EXISTS public.recap_cloud_assets (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  bucket_path TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  original_local_url TEXT NOT NULL,
  compressed BOOLEAN NOT NULL DEFAULT FALSE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_recap_cloud_assets_size CHECK (size_bytes >= 0)
);

ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS bucket_path TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS asset_kind TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS original_local_url TEXT;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS compressed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_recap_cloud_assets_user_sha
  ON public.recap_cloud_assets(user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_recap_cloud_assets_user_project
  ON public.recap_cloud_assets(user_id, project_id, created_at DESC);

ALTER TABLE public.recap_cloud_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can view own cloud assets"
  ON public.recap_cloud_assets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can insert own cloud assets"
  ON public.recap_cloud_assets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can update own cloud assets"
  ON public.recap_cloud_assets FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can delete own cloud assets"
  ON public.recap_cloud_assets FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 3. public.recap_project_assets (relational link between projects & cloud assets)
CREATE TABLE IF NOT EXISTS public.recap_project_assets (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES public.recap_projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES public.recap_cloud_assets(id) ON DELETE CASCADE,
  local_url TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_size_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_recap_project_assets_size CHECK (verified_size_bytes >= 0)
);

ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES public.recap_projects(id) ON DELETE CASCADE;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS asset_id TEXT REFERENCES public.recap_cloud_assets(id) ON DELETE CASCADE;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS local_url TEXT;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS asset_kind TEXT;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS verified_size_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.recap_project_assets
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_recap_project_assets_unique_url
  ON public.recap_project_assets(user_id, project_id, local_url);
CREATE INDEX IF NOT EXISTS idx_recap_project_assets_proj
  ON public.recap_project_assets(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_recap_project_assets_asset
  ON public.recap_project_assets(user_id, asset_id);

ALTER TABLE public.recap_project_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can view own project assets"
  ON public.recap_project_assets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can insert own project assets"
  ON public.recap_project_assets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can update own project assets"
  ON public.recap_project_assets FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can delete own project assets"
  ON public.recap_project_assets FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 4. Schema privileges for authenticated PostgREST role
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.recap_projects, public.recap_cloud_assets, public.recap_project_assets
  TO authenticated;

-- 5. Private Supabase Storage bucket capped at 50 MB/object (Free Plan limit)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('recap-media', 'recap-media', FALSE, 52428800)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = 52428800,
      public = FALSE;

DROP POLICY IF EXISTS "Users read own media objects" ON storage.objects;
CREATE POLICY "Users read own media objects"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users upload own media objects" ON storage.objects;
CREATE POLICY "Users upload own media objects"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users update own media objects" ON storage.objects;
CREATE POLICY "Users update own media objects"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users delete own media objects" ON storage.objects;
CREATE POLICY "Users delete own media objects"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 6. Enable Supabase Realtime on public.recap_projects for multi-device sync
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'recap_projects'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.recap_projects;
  END IF;
END $$;

-- 7. Immediately refresh PostgREST schema cache so tables are visible right away
NOTIFY pgrst, 'reload schema';
