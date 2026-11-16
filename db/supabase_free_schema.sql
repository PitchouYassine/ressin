-- ============================================================================
-- RECAP STUDIO AI — SUPABASE FREE PLAN SCHEMA (ZERO-COST ARCHITECTURE)
-- Run this script once in your Supabase Free Project -> SQL Editor.
-- Works within Supabase Free Tier:
--   • PostgreSQL Database: 500 MB limit
--   • Authentication: Free Email/Password
--   • Storage: 1 GB total, 50 MB max single file
--   • Realtime: 2M messages/mo, 200 concurrent connections
-- ============================================================================

-- 1. Cloud Projects Table (stores project JSON + captions + sync metadata)
CREATE TABLE IF NOT EXISTS public.recap_projects (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_data JSONB NOT NULL,
  asset_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_version BIGINT NOT NULL DEFAULT 1,
  last_device_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recap_projects_user_updated
  ON public.recap_projects(user_id, updated_at DESC);

ALTER TABLE public.recap_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own recap projects" ON public.recap_projects;
CREATE POLICY "Users can view own recap projects"
  ON public.recap_projects FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own recap projects" ON public.recap_projects;
CREATE POLICY "Users can insert own recap projects"
  ON public.recap_projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own recap projects" ON public.recap_projects;
CREATE POLICY "Users can update own recap projects"
  ON public.recap_projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own recap projects" ON public.recap_projects;
CREATE POLICY "Users can delete own recap projects"
  ON public.recap_projects FOR DELETE
  USING (auth.uid() = user_id);

-- 2. Deduplicated Cloud Assets Registry (prevents duplicate uploads via SHA-256)
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
  UNIQUE(user_id, sha256)
);

ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.recap_cloud_assets
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recap_cloud_assets_user_sha
  ON public.recap_cloud_assets(user_id, sha256);

ALTER TABLE public.recap_cloud_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can view own cloud assets"
  ON public.recap_cloud_assets FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can insert own cloud assets"
  ON public.recap_cloud_assets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can update own cloud assets"
  ON public.recap_cloud_assets FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own cloud assets" ON public.recap_cloud_assets;
CREATE POLICY "Users can delete own cloud assets"
  ON public.recap_cloud_assets FOR DELETE
  USING (auth.uid() = user_id);

-- 2b. Relational Project <-> Cloud Asset Mapping (full cross-project asset relationships)
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
  UNIQUE(user_id, project_id, local_url)
);

CREATE INDEX IF NOT EXISTS idx_recap_project_assets_proj
  ON public.recap_project_assets(user_id, project_id);

ALTER TABLE public.recap_project_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can view own project assets"
  ON public.recap_project_assets FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can insert own project assets"
  ON public.recap_project_assets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can update own project assets"
  ON public.recap_project_assets FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own project assets" ON public.recap_project_assets;
CREATE POLICY "Users can delete own project assets"
  ON public.recap_project_assets FOR DELETE
  USING (auth.uid() = user_id);

-- 3. Private Storage Bucket capped at 50 MB per object (Supabase Free Plan limit)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('recap-media', 'recap-media', FALSE, 52428800)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = 52428800,
      public = FALSE;

DROP POLICY IF EXISTS "Users read own media objects" ON storage.objects;
CREATE POLICY "Users read own media objects"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users upload own media objects" ON storage.objects;
CREATE POLICY "Users upload own media objects"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users update own media objects" ON storage.objects;
CREATE POLICY "Users update own media objects"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users delete own media objects" ON storage.objects;
CREATE POLICY "Users delete own media objects"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'recap-media'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 4. Enable Supabase Realtime on recap_projects for multi-device sync
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'recap_projects'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.recap_projects;
  END IF;
END $$;
