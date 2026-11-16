import { createClient, RealtimeChannel, Session, SupabaseClient, User } from '@supabase/supabase-js';
import {
  CloudAssetKind,
  CloudAssetManifestEntry,
  CloudAssetRecord,
  CloudStorageUsage,
  CloudUploadTask,
  Project,
  SupabaseFreeConfig,
} from '../types/studio';
import { api, LocalAssetManifestItem } from './api';
import {
  getDeviceId,
  getStoredSupabaseConfig,
  indexedDbStore,
  saveStoredSupabaseConfig,
} from './indexedDbStore';
import { SUPABASE_FREE_LIMITS } from './supabaseFreeLimits';

export const SUPABASE_MEDIA_BUCKET = 'recap-media';
const TUS_CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB chunks (safe within Free Plan 50 MB max)
const EGRESS_STORAGE_KEY = 'recap_studio_session_egress_bytes';

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey = '';

function getTrackedEgressBytes(): number {
  try {
    const raw = window.localStorage.getItem(EGRESS_STORAGE_KEY);
    return raw ? Math.max(0, Number(raw) || 0) : 0;
  } catch {
    return 0;
  }
}

function addTrackedEgressBytes(bytes: number): void {
  if (!bytes || bytes <= 0) return;
  try {
    const next = getTrackedEgressBytes() + bytes;
    window.localStorage.setItem(EGRESS_STORAGE_KEY, String(next));
  } catch {
    // ignore storage errors
  }
}

export function resetTrackedEgressBytes(): void {
  try {
    window.localStorage.removeItem(EGRESS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isSupabaseConfigured(): boolean {
  const cfg = getStoredSupabaseConfig();
  return Boolean(cfg && cfg.url && cfg.anonKey);
}

export function getSupabaseClient(): SupabaseClient | null {
  const cfg = getStoredSupabaseConfig();
  if (!cfg || !cfg.url || !cfg.anonKey) {
    cachedClient = null;
    cachedConfigKey = '';
    return null;
  }
  const key = `${cfg.url}|${cfg.anonKey}`;
  if (!cachedClient || cachedConfigKey !== key) {
    cachedClient = createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 4, // Conserve Supabase Free Realtime quota
        },
      },
    });
    cachedConfigKey = key;
  }
  return cachedClient;
}

export function updateSupabaseConfig(config: SupabaseFreeConfig | null): void {
  saveStoredSupabaseConfig(config);
  cachedClient = null;
  cachedConfigKey = '';
}

export async function getCloudSession(): Promise<{ session: Session | null; user: User | null }> {
  const client = getSupabaseClient();
  if (!client) return { session: null, user: null };
  try {
    const { data } = await client.auth.getSession();
    return { session: data.session, user: data.session?.user ?? null };
  } catch {
    return { session: null, user: null };
  }
}

export async function signUpCloudAccount(email: string, password: string): Promise<{
  user: User | null;
  needsEmailConfirmation: boolean;
}> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Connect your Supabase Free project URL and anon key first.');
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return {
    user: data.user,
    needsEmailConfirmation: Boolean(data.user && !data.session),
  };
}

export async function signInCloudAccount(email: string, password: string): Promise<User | null> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Connect your Supabase Free project URL and anon key first.');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.user;
}

export async function signOutCloudAccount(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  await client.auth.signOut();
}

export async function testSupabaseFreeSchema(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, error: 'Supabase Free credentials are not configured.' };
  try {
    const [projCheck, relCheck] = await Promise.all([
      client.from('recap_projects').select('id').limit(1),
      client.from('recap_project_assets').select('id').limit(1),
    ]);
    if (projCheck.error) {
      return {
        ok: false,
        error: `${projCheck.error.message} — Run the updated Supabase Free SQL Schema in your Supabase SQL Editor first.`,
      };
    }
    if (relCheck.error) {
      return {
        ok: false,
        error: `${relCheck.error.message} — Re-run the updated Supabase Free SQL Schema to enable recap_project_assets relational tracking.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface DbProjectRow {
  id: string;
  user_id: string;
  name: string;
  project_data: Project;
  asset_manifest: Record<string, CloudAssetManifestEntry>;
  sync_version: number;
  last_device_id: string | null;
  updated_at: string;
  created_at: string;
}

interface DbAssetRow {
  id: string;
  user_id: string;
  project_id: string;
  bucket_path: string;
  asset_kind: CloudAssetKind;
  filename: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  original_local_url: string;
  compressed: boolean;
  verified?: boolean;
  verified_at?: string | null;
  created_at: string;
}

export async function fetchCloudStorageUsage(userId: string): Promise<CloudStorageUsage> {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase Free client is not configured.');
  }

  const [assetsRes, projRes] = await Promise.all([
    client
      .from('recap_cloud_assets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    client
      .from('recap_projects')
      .select('id, project_data, updated_at')
      .eq('user_id', userId),
  ]);

  if (assetsRes.error) throw new Error(assetsRes.error.message);
  if (projRes.error) throw new Error(projRes.error.message);

  const assetRows = (assetsRes.data || []) as DbAssetRow[];
  const assets: CloudAssetRecord[] = assetRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    bucketPath: r.bucket_path,
    assetKind: r.asset_kind,
    filename: r.filename,
    mimeType: r.mime_type,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes || 0),
    originalLocalUrl: r.original_local_url,
    compressed: Boolean(r.compressed),
    verified: Boolean(r.verified),
    verifiedAt: r.verified_at || undefined,
    createdAt: r.created_at,
  }));

  const storageUsedBytes = assets.reduce((sum, a) => sum + a.sizeBytes, 0);
  const projectRows = (projRes.data || []) as Array<{ id: string; project_data: unknown }>;
  const dbUsedBytes = projectRows.reduce((sum, row) => {
    try {
      return sum + new Blob([JSON.stringify(row.project_data || {})]).size;
    } catch {
      return sum + 4096;
    }
  }, 0);

  return {
    storageUsedBytes,
    storageLimitBytes: SUPABASE_FREE_LIMITS.storageBytes,
    dbUsedBytes,
    dbLimitBytes: SUPABASE_FREE_LIMITS.dbBytes,
    maxSingleFileBytes: SUPABASE_FREE_LIMITS.maxSingleFileBytes,
    egressTrackedBytes: getTrackedEgressBytes(),
    egressLimitBytes: SUPABASE_FREE_LIMITS.egressBytes,
    fileCount: assets.length,
    projectCount: projectRows.length,
    assets,
  };
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Upload cancelled by user.', 'AbortError');
  }
}

export function isUploadCancelledError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function xhrSend(params: {
  method: 'POST' | 'PUT' | 'PATCH' | 'HEAD';
  url: string;
  headers: Record<string, string>;
  body?: Blob;
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
}): Promise<{ status: number; headers: Map<string, string>; responseText: string }> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException('Upload cancelled by user.', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(params.method, params.url, true);
    for (const [k, v] of Object.entries(params.headers)) {
      xhr.setRequestHeader(k, v);
    }

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException('Upload cancelled by user.', 'AbortError'));
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    if (params.onUploadProgress && params.body) {
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable || params.body) {
          params.onUploadProgress?.(evt.loaded, evt.total || params.body!.size);
        }
      };
    }

    xhr.onload = () => {
      params.signal?.removeEventListener('abort', onAbort);
      const headerMap = new Map<string, string>();
      const rawHeaders = xhr.getAllResponseHeaders();
      for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headerMap.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
        }
      }
      resolve({
        status: xhr.status,
        headers: headerMap,
        responseText: xhr.responseText || '',
      });
    };

    xhr.onerror = () => {
      params.signal?.removeEventListener('abort', onAbort);
      reject(new Error('Network error during Supabase Storage upload.'));
    };

    xhr.onabort = () => {
      params.signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Upload cancelled by user.', 'AbortError'));
    };

    xhr.send(params.body ?? null);
  });
}

async function uploadBlobDirectXhr(params: {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  bucketPath: string;
  blob: Blob;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number, pct: number) => void;
}): Promise<void> {
  const cleanBase = params.supabaseUrl.replace(/\/+$/, '');
  const encodedObject = params.bucketPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const endpoint = `${cleanBase}/storage/v1/object/${SUPABASE_MEDIA_BUCKET}/${encodedObject}`;

  const res = await xhrSend({
    method: 'POST',
    url: endpoint,
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      apikey: params.anonKey,
      'x-upsert': 'true',
      'Content-Type': params.mimeType || 'application/octet-stream',
    },
    body: params.blob,
    signal: params.signal,
    onUploadProgress: (loaded, total) => {
      const denom = Math.max(1, total || params.blob.size);
      const pct = Math.min(100, Math.round((loaded / denom) * 100));
      params.onProgress?.(loaded, params.blob.size, pct);
    },
  });

  if (res.status < 200 || res.status >= 300) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.responseText) as { message?: string; error?: string };
      if (parsed.message || parsed.error) msg = parsed.message || parsed.error || msg;
    } catch {
      if (res.responseText) msg = res.responseText.slice(0, 180);
    }
    throw new Error(`Storage upload failed (${msg})`);
  }
  params.onProgress?.(params.blob.size, params.blob.size, 100);
}

async function uploadBlobResumableTus(params: {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  bucketPath: string;
  blob: Blob;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number, pct: number) => void;
}): Promise<void> {
  const cleanBase = params.supabaseUrl.replace(/\/+$/, '');
  const tusEndpoint = `${cleanBase}/storage/v1/upload/resumable`;
  const metadataHeader = [
    `bucketName ${encodeBase64Utf8(SUPABASE_MEDIA_BUCKET)}`,
    `objectName ${encodeBase64Utf8(params.bucketPath)}`,
    `contentType ${encodeBase64Utf8(params.mimeType || 'application/octet-stream')}`,
    `cacheControl ${encodeBase64Utf8('3600')}`,
  ].join(',');

  const createRes = await xhrSend({
    method: 'POST',
    url: tusEndpoint,
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      apikey: params.anonKey,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(params.blob.size),
      'Upload-Metadata': metadataHeader,
      'x-upsert': 'true',
    },
    signal: params.signal,
  });

  // Fallback gracefully if TUS endpoint is unavailable (e.g. non-TUS proxy)
  if (createRes.status === 404 || createRes.status === 405 || createRes.status === 501) {
    await uploadBlobDirectXhr(params);
    return;
  }

  if (createRes.status < 200 || createRes.status >= 300) {
    throw new Error(`TUS upload initialization failed (HTTP ${createRes.status})`);
  }

  const rawLocation = createRes.headers.get('location') || '';
  if (!rawLocation) {
    await uploadBlobDirectXhr(params);
    return;
  }

  const uploadUrl = rawLocation.startsWith('http')
    ? rawLocation
    : rawLocation.startsWith('/')
    ? `${cleanBase}${rawLocation}`
    : `${tusEndpoint}/${rawLocation}`;

  let offset = 0;
  const total = params.blob.size;

  while (offset < total) {
    throwIfAborted(params.signal);
    const chunkEnd = Math.min(total, offset + TUS_CHUNK_SIZE_BYTES);
    const chunk = params.blob.slice(offset, chunkEnd);

    let attempt = 0;
    let chunkDone = false;
    while (!chunkDone) {
      throwIfAborted(params.signal);
      try {
        const patchRes = await xhrSend({
          method: 'PATCH',
          url: uploadUrl,
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            apikey: params.anonKey,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunk,
          signal: params.signal,
          onUploadProgress: (loaded) => {
            const totalUploaded = Math.min(total, offset + loaded);
            const pct = Math.min(100, Math.round((totalUploaded / Math.max(1, total)) * 100));
            params.onProgress?.(totalUploaded, total, pct);
          },
        });

        if (patchRes.status === 409) {
          // Resync offset via TUS HEAD request
          const headRes = await xhrSend({
            method: 'HEAD',
            url: uploadUrl,
            headers: {
              Authorization: `Bearer ${params.accessToken}`,
              apikey: params.anonKey,
              'Tus-Resumable': '1.0.0',
            },
            signal: params.signal,
          });
          const remoteOffset = Number(headRes.headers.get('upload-offset') || offset);
          offset = Number.isFinite(remoteOffset) ? remoteOffset : chunkEnd;
          chunkDone = true;
          continue;
        }

        if (patchRes.status < 200 || patchRes.status >= 300) {
          throw new Error(`TUS chunk upload failed (HTTP ${patchRes.status})`);
        }

        const nextOffsetHeader = Number(patchRes.headers.get('upload-offset'));
        offset = Number.isFinite(nextOffsetHeader) && nextOffsetHeader > offset ? nextOffsetHeader : chunkEnd;
        const pct = Math.min(100, Math.round((offset / Math.max(1, total)) * 100));
        params.onProgress?.(offset, total, pct);
        chunkDone = true;
      } catch (err) {
        if (isUploadCancelledError(err)) throw err;
        attempt += 1;
        if (attempt >= 2) throw err;
        // Re-check TUS server offset before retrying chunk
        try {
          const headRes = await xhrSend({
            method: 'HEAD',
            url: uploadUrl,
            headers: {
              Authorization: `Bearer ${params.accessToken}`,
              apikey: params.anonKey,
              'Tus-Resumable': '1.0.0',
            },
            signal: params.signal,
          });
          if (headRes.status >= 200 && headRes.status < 300) {
            const remoteOffset = Number(headRes.headers.get('upload-offset') || offset);
            if (Number.isFinite(remoteOffset) && remoteOffset > offset) {
              offset = remoteOffset;
              chunkDone = true;
            }
          }
        } catch {
          // retry original offset
        }
      }
    }
  }
}

async function uploadBlobResumableOrDirect(params: {
  bucketPath: string;
  blob: Blob;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number, pct: number) => void;
}): Promise<void> {
  const cfg = getStoredSupabaseConfig();
  const { session } = await getCloudSession();
  if (!cfg || !session?.access_token) {
    throw new Error('Sign in to your Supabase Free account before uploading.');
  }

  // Use TUS resumable chunked upload for files >= 5 MB, XHR upload with progress for smaller files
  if (params.blob.size >= TUS_CHUNK_SIZE_BYTES) {
    await uploadBlobResumableTus({
      supabaseUrl: cfg.url,
      anonKey: cfg.anonKey,
      accessToken: session.access_token,
      bucketPath: params.bucketPath,
      blob: params.blob,
      mimeType: params.mimeType,
      signal: params.signal,
      onProgress: params.onProgress,
    });
  } else {
    await uploadBlobDirectXhr({
      supabaseUrl: cfg.url,
      anonKey: cfg.anonKey,
      accessToken: session.access_token,
      bucketPath: params.bucketPath,
      blob: params.blob,
      mimeType: params.mimeType,
      signal: params.signal,
      onProgress: params.onProgress,
    });
  }
}

export async function verifyCloudStorageObject(
  client: SupabaseClient,
  bucketPath: string,
  expectedSizeBytes: number
): Promise<{ verified: boolean; verifiedSizeBytes: number }> {
  const signed = await client.storage.from(SUPABASE_MEDIA_BUCKET).createSignedUrl(bucketPath, 120);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`Verification failed: could not issue signed URL for ${bucketPath}.`);
  }

  const headRes = await fetch(signed.data.signedUrl, { method: 'HEAD', cache: 'no-store' });
  if (!headRes.ok) {
    throw new Error(`Verification failed: remote object missing (HTTP ${headRes.status}).`);
  }

  const headLen = Number(headRes.headers.get('content-length') || 0);
  if (headLen > 0) {
    if (headLen !== expectedSizeBytes) {
      throw new Error(
        `Integrity check failed: expected ${expectedSizeBytes} bytes, cloud stored ${headLen} bytes.`
      );
    }
    return { verified: true, verifiedSizeBytes: headLen };
  }

  // Fallback size check via Storage list API if proxy stripped Content-Length
  const slashIdx = bucketPath.lastIndexOf('/');
  const folder = slashIdx > 0 ? bucketPath.slice(0, slashIdx) : '';
  const name = slashIdx >= 0 ? bucketPath.slice(slashIdx + 1) : bucketPath;
  const listRes = await client.storage.from(SUPABASE_MEDIA_BUCKET).list(folder, { search: name });
  const match = (listRes.data || []).find((f) => f.name === name);
  const metaSize = Number(
    (match?.metadata as { size?: number } | undefined)?.size ?? expectedSizeBytes
  );
  if (!match) {
    throw new Error(`Verification failed: ${name} not found in Supabase Storage listing.`);
  }
  if (metaSize !== expectedSizeBytes) {
    throw new Error(
      `Integrity check failed: expected ${expectedSizeBytes} bytes, cloud reported ${metaSize} bytes.`
    );
  }
  return { verified: true, verifiedSizeBytes: metaSize };
}

export interface SyncProjectOptions {
  syncVideoAsset?: boolean; // Full Cloud Mode defaults to true
  syncFinalExport?: boolean; // Full Cloud Mode defaults to true
  syncMediaAssets?: boolean; // Full Cloud Mode defaults to true
  retryUrls?: string[]; // Optional subset of localUrls to retry
  signal?: AbortSignal;
  onTaskUpdate?: (tasks: CloudUploadTask[]) => void;
}

export interface SyncProjectResult {
  project: Project;
  uploadedCount: number;
  deduplicatedCount: number;
  verifiedCount: number;
  skippedLargeAssets: Array<{ filename: string; sizeBytes: number; reason: string }>;
  failedUploads: Array<{ localUrl: string; filename: string; reason: string }>;
  tasks: CloudUploadTask[];
  quotaBlocked: boolean;
  cancelled: boolean;
  message: string;
}

function stripTransientFieldsForCloud(project: Project): Project {
  const { cloudSync: _cs, ...rest } = project;
  return {
    ...rest,
    waveformPeaks: (project.waveformPeaks || []).slice(0, 240),
  };
}

async function upsertProjectAssetRelation(params: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  assetId: string;
  localUrl: string;
  assetKind: CloudAssetKind;
  filename: string;
  verified: boolean;
  verifiedSizeBytes: number;
}): Promise<void> {
  const relId = `${params.projectId.slice(0, 12)}_${params.assetId.slice(0, 16)}_${params.assetKind}`;
  await params.client.from('recap_project_assets').upsert(
    {
      id: relId,
      user_id: params.userId,
      project_id: params.projectId,
      asset_id: params.assetId,
      local_url: params.localUrl,
      asset_kind: params.assetKind,
      filename: params.filename,
      verified: params.verified,
      verified_size_bytes: params.verifiedSizeBytes,
    },
    { onConflict: 'user_id,project_id,local_url' }
  );
}

export async function syncProjectToCloud(
  project: Project,
  options: SyncProjectOptions = { syncVideoAsset: true, syncFinalExport: true, syncMediaAssets: true }
): Promise<SyncProjectResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await indexedDbStore.queuePendingSync({
      projectId: project.id,
      projectName: project.name,
      queuedAt: new Date().toISOString(),
      updatedAt: project.updatedAt,
      reason: 'Device is offline — queued in IndexedDB',
    });
    const offlineProject: Project = {
      ...project,
      cloudSync: {
        ...(project.cloudSync || { syncStatus: 'offline' }),
        syncStatus: 'offline',
        error: 'Device is offline. Edits & media remain safe locally in IndexedDB/disk.',
      },
    };
    await indexedDbStore.saveProjectSnapshot(offlineProject);
    const { project: savedLocal } = await api.updateProject(project.id, {
      cloudSync: offlineProject.cloudSync,
    });
    return {
      project: savedLocal,
      uploadedCount: 0,
      deduplicatedCount: 0,
      verifiedCount: 0,
      skippedLargeAssets: [],
      failedUploads: [],
      tasks: [],
      quotaBlocked: false,
      cancelled: false,
      message: 'Offline: changes queued locally (not yet verified in cloud).',
    };
  }

  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user) {
    await indexedDbStore.queuePendingSync({
      projectId: project.id,
      projectName: project.name,
      queuedAt: new Date().toISOString(),
      updatedAt: project.updatedAt,
      reason: 'Not signed in to Supabase Free Cloud',
    });
    const localOnlyProject: Project = {
      ...project,
      cloudSync: {
        ...(project.cloudSync || { syncStatus: 'local-only' }),
        syncStatus: 'local-only',
        error: 'Sign in to your free Supabase account to store & access project media across devices.',
      },
    };
    const { project: savedLocal } = await api.updateProject(project.id, {
      cloudSync: localOnlyProject.cloudSync,
    });
    return {
      project: savedLocal,
      uploadedCount: 0,
      deduplicatedCount: 0,
      verifiedCount: 0,
      skippedLargeAssets: [],
      failedUploads: [],
      tasks: [],
      quotaBlocked: false,
      cancelled: false,
      message: 'Saved locally only. Connect & sign in to Supabase Free to sync.',
    };
  }

  // 1. Fetch live Free Plan quota usage & deduplication table
  const usage = await fetchCloudStorageUsage(user.id);
  const existingBySha = new Map<string, CloudAssetRecord>();
  for (const a of usage.assets) {
    if (a.sha256) existingBySha.set(a.sha256, a);
  }

  // 2. Discover ALL project media assets on disk
  const manifestRes = await api.getProjectAssetManifest(project.id);
  const allAssets = (manifestRes.assets || []).filter(
    (a) => a.exists && a.sizeBytes > 0 && a.necessaryForCloudSync
  );

  const shouldIncludeAsset = (asset: LocalAssetManifestItem): boolean => {
    if (options.retryUrls && options.retryUrls.length > 0) {
      return options.retryUrls.includes(asset.localUrl);
    }
    if (options.syncMediaAssets === false) return false;
    if (asset.assetKind === 'video' && options.syncVideoAsset === false) return false;
    if (asset.assetKind === 'final-export' && options.syncFinalExport === false) return false;
    return true;
  };

  const targetAssets = allAssets.filter(shouldIncludeAsset);
  const tasks: CloudUploadTask[] = targetAssets.map((a) => ({
    id: `${project.id.slice(0, 8)}_${a.sha256.slice(0, 10) || a.filename}`,
    localUrl: a.localUrl,
    filename: a.filename,
    assetKind: a.assetKind,
    sizeBytes: a.sizeBytes,
    uploadedBytes: 0,
    progressPct: 0,
    status: 'queued',
    sha256: a.sha256,
  }));

  const emitTasks = () => {
    options.onTaskUpdate?.(tasks.map((t) => ({ ...t })));
  };
  emitTasks();

  const cloudAssetsManifest: Record<string, CloudAssetManifestEntry> = {
    ...(project.cloudAssets || {}),
  };
  const skippedLargeAssets: Array<{ filename: string; sizeBytes: number; reason: string }> = [];
  const failedUploads: Array<{ localUrl: string; filename: string; reason: string }> = [];
  let runningStorageBytes = usage.storageUsedBytes;
  let uploadedCount = 0;
  let deduplicatedCount = 0;
  let verifiedCount = 0;
  let quotaBlocked = false;
  let cancelled = false;

  for (let i = 0; i < targetAssets.length; i++) {
    const asset = targetAssets[i];
    const task = tasks[i];

    if (options.signal?.aborted) {
      cancelled = true;
      for (let j = i; j < tasks.length; j++) {
        tasks[j].status = 'cancelled';
        tasks[j].error = 'Cancelled by user before upload started.';
      }
      emitTasks();
      break;
    }

    // SHA-256 Deduplication check (only skip re-upload if cloud copy was actually verified)
    const existingCloud = asset.sha256 ? existingBySha.get(asset.sha256) : undefined;
    if (existingCloud && existingCloud.verified !== false) {
      const nowIso = new Date().toISOString();
      cloudAssetsManifest[asset.localUrl] = {
        localUrl: asset.localUrl,
        bucketPath: existingCloud.bucketPath,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        assetKind: asset.assetKind,
        filename: asset.filename,
        mimeType: asset.mimeType,
        compressed: existingCloud.compressed,
        verified: true,
        verifiedSizeBytes: existingCloud.sizeBytes || asset.sizeBytes,
        verifiedAt: existingCloud.verifiedAt || nowIso,
        syncedAt: nowIso,
      };
      await upsertProjectAssetRelation({
        client,
        userId: user.id,
        projectId: project.id,
        assetId: existingCloud.id,
        localUrl: asset.localUrl,
        assetKind: asset.assetKind,
        filename: asset.filename,
        verified: true,
        verifiedSizeBytes: asset.sizeBytes,
      });
      task.status = 'deduplicated';
      task.progressPct = 100;
      task.uploadedBytes = asset.sizeBytes;
      task.bucketPath = existingCloud.bucketPath;
      emitTasks();
      deduplicatedCount += 1;
      verifiedCount += 1;
      continue;
    }

    // Free Plan 50 MB single-file hard cap
    if (asset.sizeBytes > SUPABASE_FREE_LIMITS.maxSingleFileBytes) {
      const reason = `Exceeds Supabase Free 50 MB single-file limit (${(
        asset.sizeBytes /
        (1024 * 1024)
      ).toFixed(1)} MB). Use local FFmpeg <45 MB compression or Export Backup.`;
      skippedLargeAssets.push({ filename: asset.filename, sizeBytes: asset.sizeBytes, reason });
      task.status = 'exceeds-free-cap';
      task.error = reason;
      emitTasks();
      continue;
    }

    // Free Plan 1 GB total storage guard — NEVER silently delete or overwrite existing cloud files
    if (runningStorageBytes + asset.sizeBytes > SUPABASE_FREE_LIMITS.storageBytes) {
      quotaBlocked = true;
      const reason =
        'Supabase Free 1 GB total storage limit reached. Delete unused cloud files or export backup ZIP.';
      skippedLargeAssets.push({ filename: asset.filename, sizeBytes: asset.sizeBytes, reason });
      task.status = 'quota-blocked';
      task.error = reason;
      emitTasks();
      continue;
    }

    try {
      task.status = 'uploading';
      emitTasks();

      const resp = await fetch(asset.localUrl, { signal: options.signal });
      if (!resp.ok) {
        throw new Error(`Could not read local asset file (HTTP ${resp.status}).`);
      }
      const blob = await resp.blob();
      const safeName = asset.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const bucketPath = `${user.id}/${asset.sha256.slice(0, 24)}_${safeName}`;
      task.bucketPath = bucketPath;

      // Resumable TUS upload (>= 5 MB) or XHR upload (< 5 MB) with live progress & cancel
      await uploadBlobResumableOrDirect({
        bucketPath,
        blob,
        mimeType: asset.mimeType || 'application/octet-stream',
        signal: options.signal,
        onProgress: (uploadedBytes, totalBytes, pct) => {
          task.uploadedBytes = uploadedBytes;
          task.sizeBytes = totalBytes;
          task.progressPct = pct;
          emitTasks();
        },
      });

      // Mandatory Post-Upload Integrity Verification before claiming cloud-saved!
      task.status = 'verifying';
      task.progressPct = 100;
      emitTasks();
      const verification = await verifyCloudStorageObject(client, bucketPath, asset.sizeBytes);

      const nowIso = new Date().toISOString();
      const assetId = `${user.id.slice(0, 8)}_${asset.sha256.slice(0, 24)}`;
      const insertRes = await client.from('recap_cloud_assets').upsert(
        {
          id: assetId,
          user_id: user.id,
          project_id: project.id,
          bucket_path: bucketPath,
          asset_kind: asset.assetKind,
          filename: asset.filename,
          mime_type: asset.mimeType,
          sha256: asset.sha256,
          size_bytes: asset.sizeBytes,
          original_local_url: asset.localUrl,
          compressed: asset.filename.startsWith('compact_'),
          verified: verification.verified,
          verified_at: nowIso,
        },
        { onConflict: 'user_id,sha256' }
      );
      if (insertRes.error) {
        throw new Error(`Failed registering verified cloud asset: ${insertRes.error.message}`);
      }

      await upsertProjectAssetRelation({
        client,
        userId: user.id,
        projectId: project.id,
        assetId,
        localUrl: asset.localUrl,
        assetKind: asset.assetKind,
        filename: asset.filename,
        verified: true,
        verifiedSizeBytes: verification.verifiedSizeBytes,
      });

      await indexedDbStore.putCachedMedia({
        sha256: asset.sha256,
        filename: asset.filename,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        blob,
        cachedAt: nowIso,
      });

      existingBySha.set(asset.sha256, {
        id: assetId,
        userId: user.id,
        projectId: project.id,
        bucketPath,
        assetKind: asset.assetKind,
        filename: asset.filename,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        originalLocalUrl: asset.localUrl,
        compressed: asset.filename.startsWith('compact_'),
        verified: true,
        verifiedAt: nowIso,
        createdAt: nowIso,
      });

      cloudAssetsManifest[asset.localUrl] = {
        localUrl: asset.localUrl,
        bucketPath,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        assetKind: asset.assetKind,
        filename: asset.filename,
        mimeType: asset.mimeType,
        compressed: asset.filename.startsWith('compact_'),
        verified: true,
        verifiedSizeBytes: verification.verifiedSizeBytes,
        verifiedAt: nowIso,
        syncedAt: nowIso,
      };

      task.status = 'verified';
      task.progressPct = 100;
      emitTasks();

      runningStorageBytes += asset.sizeBytes;
      uploadedCount += 1;
      verifiedCount += 1;
    } catch (err) {
      if (isUploadCancelledError(err)) {
        cancelled = true;
        task.status = 'cancelled';
        task.error = 'Cancelled by user.';
        for (let j = i + 1; j < tasks.length; j++) {
          tasks[j].status = 'cancelled';
          tasks[j].error = 'Queue stopped after cancellation.';
        }
        emitTasks();
        break;
      }

      const reason = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.error = reason;
      failedUploads.push({
        localUrl: asset.localUrl,
        filename: asset.filename,
        reason,
      });
      // IMPORTANT: Ensure unverified failed upload is NEVER marked verified in manifest
      if (cloudAssetsManifest[asset.localUrl]) {
        cloudAssetsManifest[asset.localUrl] = {
          ...cloudAssetsManifest[asset.localUrl],
          verified: false,
        };
      }
      emitTasks();
    }
  }

  // Count how many existing project local assets remain unverified in cloudAssetsManifest
  const unverifiedCount = allAssets.filter(
    (a) => !cloudAssetsManifest[a.localUrl]?.verified
  ).length;

  const nextSyncVersion = (project.cloudSync?.syncVersion || 0) + 1;
  const deviceId = getDeviceId();
  const nowIso = new Date().toISOString();
  const nextStatus =
    quotaBlocked
      ? 'quota-blocked'
      : failedUploads.length > 0 || cancelled || unverifiedCount > 0
      ? 'pending-sync'
      : 'cloud-synced';

  const payloadProject: Project = {
    ...stripTransientFieldsForCloud(project),
    cloudAssets: cloudAssetsManifest,
    cloudSync: {
      syncStatus: nextStatus,
      cloudUpdatedAt: nowIso,
      syncVersion: nextSyncVersion,
      lastDeviceId: deviceId,
      skippedLargeAssets: skippedLargeAssets.length > 0 ? skippedLargeAssets : undefined,
      failedUploads: failedUploads.length > 0 ? failedUploads : undefined,
      unverifiedCount,
      error:
        failedUploads.length > 0
          ? `${failedUploads.length} file upload(s) failed — retry in Cloud Sync.`
          : cancelled
          ? 'Upload queue cancelled before all assets finished.'
          : undefined,
    },
  };

  // Guard PostgreSQL 500 MB Free DB cap
  const jsonBytes = new Blob([JSON.stringify(payloadProject)]).size;
  if (usage.dbUsedBytes + jsonBytes > SUPABASE_FREE_LIMITS.dbBytes) {
    const blockedMeta = {
      syncStatus: 'quota-blocked' as const,
      syncVersion: project.cloudSync?.syncVersion || 0,
      lastDeviceId: deviceId,
      error: 'Supabase Free 500 MB PostgreSQL limit reached. Saved safely on local disk.',
    };
    await indexedDbStore.queuePendingSync({
      projectId: project.id,
      projectName: project.name,
      queuedAt: nowIso,
      updatedAt: project.updatedAt,
      reason: 'PostgreSQL 500 MB free limit reached',
    });
    const { project: savedLocal } = await api.updateProject(project.id, {
      cloudSync: blockedMeta,
      cloudAssets: cloudAssetsManifest,
    });
    return {
      project: savedLocal,
      uploadedCount,
      deduplicatedCount,
      verifiedCount,
      skippedLargeAssets,
      failedUploads,
      tasks,
      quotaBlocked: true,
      cancelled,
      message: 'Free 500 MB database limit reached. Project kept safe locally — export backup ZIP.',
    };
  }

  const { error: dbErr } = await client.from('recap_projects').upsert(
    {
      id: project.id,
      user_id: user.id,
      name: project.name,
      project_data: payloadProject,
      asset_manifest: cloudAssetsManifest,
      sync_version: nextSyncVersion,
      last_device_id: deviceId,
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );

  if (dbErr) {
    throw new Error(`Cloud database sync failed: ${dbErr.message}`);
  }

  const { project: savedProject } = await api.updateProject(project.id, {
    cloudAssets: cloudAssetsManifest,
    cloudSync: payloadProject.cloudSync,
  });
  await indexedDbStore.saveProjectSnapshot(savedProject);

  if (quotaBlocked || failedUploads.length > 0 || cancelled || unverifiedCount > 0) {
    await indexedDbStore.queuePendingSync({
      projectId: project.id,
      projectName: project.name,
      queuedAt: nowIso,
      updatedAt: savedProject.updatedAt,
      reason: quotaBlocked
        ? 'Storage quota reached — some media remained local only'
        : cancelled
        ? 'Upload cancelled — pending resume/retry'
        : 'Some project assets await verified cloud upload',
    });
  } else {
    await indexedDbStore.clearPendingSync(project.id);
  }

  const msgParts: string[] = [];
  if (cancelled) {
    msgParts.push(
      `Upload cancelled (${verifiedCount} verified before stop, local files & project data preserved)`
    );
  } else if (failedUploads.length > 0) {
    msgParts.push(`${failedUploads.length} upload(s) failed — click Retry Failed`);
  } else if (quotaBlocked) {
    msgParts.push('Project edits saved, but cloud 1 GB storage quota prevented uploading remaining files');
  } else if (skippedLargeAssets.length > 0) {
    msgParts.push(
      `Project synced · ${skippedLargeAssets.length} file(s) >50 MB free cap kept local (compress <45 MB to upload)`
    );
  } else {
    msgParts.push('All project media uploaded & integrity-verified in Supabase Free Cloud');
  }
  if (uploadedCount > 0) msgParts.push(`${uploadedCount} uploaded`);
  if (deduplicatedCount > 0) msgParts.push(`${deduplicatedCount} deduplicated`);

  return {
    project: savedProject,
    uploadedCount,
    deduplicatedCount,
    verifiedCount,
    skippedLargeAssets,
    failedUploads,
    tasks,
    quotaBlocked,
    cancelled,
    message: msgParts.join(' · '),
  };
}

export async function uploadSingleProjectAssetToCloud(
  project: Project,
  localUrl: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (pct: number, stageLabel: string, uploadedBytes: number, totalBytes: number) => void;
  }
): Promise<SyncProjectResult> {
  return syncProjectToCloud(project, {
    syncVideoAsset: true,
    syncFinalExport: true,
    syncMediaAssets: true,
    retryUrls: [localUrl],
    signal: options?.signal,
    onTaskUpdate: (tasks) => {
      const target = tasks.find((t) => t.localUrl === localUrl) || tasks[0];
      if (!target) return;
      const stageMap: Record<CloudUploadTask['status'], string> = {
        queued: 'Queued for Supabase Cloud upload...',
        uploading: `Uploading ${target.filename} to cloud (${target.progressPct}%)...`,
        verifying: `Verifying ${target.filename} integrity in cloud storage...`,
        verified: `Cloud verified (${target.filename})`,
        deduplicated: `Cloud verified via SHA-256 deduplication`,
        failed: target.error || 'Cloud upload failed',
        cancelled: 'Cloud upload cancelled',
        'quota-blocked': target.error || 'Supabase Free 1 GB storage limit reached',
        'exceeds-free-cap': target.error || 'Exceeds Supabase Free 50 MB single-file limit',
      };
      options?.onProgress?.(
        target.progressPct,
        stageMap[target.status],
        target.uploadedBytes,
        target.sizeBytes
      );
    },
  });
}

let realtimeDebounceTimer: number | null = null;
export function queueDebouncedMetadataSync(
  project: Project,
  onSynced?: (updated: Project) => void
): void {
  void indexedDbStore.saveProjectSnapshot(project);

  if (realtimeDebounceTimer) {
    window.clearTimeout(realtimeDebounceTimer);
  }
  realtimeDebounceTimer = window.setTimeout(async () => {
    realtimeDebounceTimer = null;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await indexedDbStore.queuePendingSync({
        projectId: project.id,
        projectName: project.name,
        queuedAt: new Date().toISOString(),
        updatedAt: project.updatedAt,
        reason: 'Edited while offline',
      });
      return;
    }

    const client = getSupabaseClient();
    const { user } = await getCloudSession();
    if (!client || !user) return;

    if (project.cloudSync?.syncStatus !== 'cloud-synced' && !project.cloudSync?.cloudUpdatedAt) {
      return;
    }

    try {
      const nextVersion = (project.cloudSync?.syncVersion || 0) + 1;
      const deviceId = getDeviceId();
      const nowIso = new Date().toISOString();
      const payload: Project = {
        ...stripTransientFieldsForCloud(project),
        cloudSync: {
          ...project.cloudSync,
          syncStatus: project.cloudSync?.syncStatus === 'quota-blocked' ? 'quota-blocked' : 'cloud-synced',
          cloudUpdatedAt: nowIso,
          syncVersion: nextVersion,
          lastDeviceId: deviceId,
        },
      };

      const { error } = await client.from('recap_projects').upsert(
        {
          id: project.id,
          user_id: user.id,
          name: project.name,
          project_data: payload,
          asset_manifest: project.cloudAssets || {},
          sync_version: nextVersion,
          last_device_id: deviceId,
          updated_at: nowIso,
        },
        { onConflict: 'id' }
      );
      if (!error) {
        const { project: savedLocal } = await api.updateProject(project.id, {
          cloudSync: payload.cloudSync,
        });
        await indexedDbStore.clearPendingSync(project.id);
        onSynced?.(savedLocal);
      }
    } catch {
      await indexedDbStore.queuePendingSync({
        projectId: project.id,
        projectName: project.name,
        queuedAt: new Date().toISOString(),
        updatedAt: project.updatedAt,
        reason: 'Auto-sync failed — queued in IndexedDB',
      });
    }
  }, 1500);
}

export async function getAuthenticatedCloudSignedUrl(
  bucketPath: string,
  expiresSec = 3600
): Promise<string | null> {
  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user || !bucketPath) return null;
  const { data, error } = await client.storage
    .from(SUPABASE_MEDIA_BUCKET)
    .createSignedUrl(bucketPath, expiresSec);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function resolvePlayableAssetUrl(
  localUrl: string | null | undefined,
  cloudAssets?: Record<string, CloudAssetManifestEntry>
): Promise<string | null> {
  if (!localUrl) return null;
  const cleanUrl = localUrl.split('?')[0];
  try {
    const head = await fetch(cleanUrl, { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return localUrl;
  } catch {
    // local server file not on this device yet
  }
  const cloudEntry = cloudAssets?.[cleanUrl];
  if (cloudEntry?.bucketPath) {
    return getAuthenticatedCloudSignedUrl(cloudEntry.bucketPath, 3600);
  }
  return null;
}

export async function downloadProjectAsset(params: {
  localUrl: string;
  cloudAssets?: Record<string, CloudAssetManifestEntry>;
  filename?: string;
}): Promise<{ source: 'local' | 'indexeddb' | 'cloud' }> {
  const cleanUrl = params.localUrl.split('?')[0];
  const dlName = params.filename || cleanUrl.split('/').pop() || 'media_file';

  // 1. Prefer fast zero-egress local disk file if present on this device
  try {
    const head = await fetch(cleanUrl, { method: 'HEAD', cache: 'no-store' });
    if (head.ok) {
      const a = document.createElement('a');
      a.href = `${cleanUrl}?download=1`;
      a.download = dlName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return { source: 'local' };
    }
  } catch {
    // fallback to cloud
  }

  const entry = params.cloudAssets?.[cleanUrl];
  if (!entry) {
    throw new Error('File is not available locally and has no verified cloud record yet.');
  }

  // 2. Check browser IndexedDB SHA-256 cache before incurring Supabase egress
  if (entry.sha256) {
    const cached = await indexedDbStore.getCachedMedia(entry.sha256);
    if (cached?.blob) {
      const objUrl = URL.createObjectURL(cached.blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = dlName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
      return { source: 'indexeddb' };
    }
  }

  // 3. Authenticated download from Supabase Storage
  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user) {
    throw new Error('Sign in to your Supabase Free account to download cloud media.');
  }

  const dl = await client.storage.from(SUPABASE_MEDIA_BUCKET).download(entry.bucketPath);
  if (dl.error || !dl.data) {
    throw new Error(dl.error?.message || 'Could not download file from Supabase Cloud Storage.');
  }

  addTrackedEgressBytes(dl.data.size);

  if (entry.sha256) {
    await indexedDbStore.putCachedMedia({
      sha256: entry.sha256,
      filename: entry.filename,
      mimeType: entry.mimeType,
      sizeBytes: dl.data.size,
      blob: dl.data,
      cachedAt: new Date().toISOString(),
    });
  }

  const objUrl = URL.createObjectURL(dl.data);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = dlName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  return { source: 'cloud' };
}

export async function hydrateProjectAssetsFromCloud(
  project: Project
): Promise<{ hydratedCount: number; cacheHits: number; missingFiles: string[] }> {
  const client = getSupabaseClient();
  const manifest = project.cloudAssets || {};
  const entries = Object.values(manifest);
  if (entries.length === 0) {
    return { hydratedCount: 0, cacheHits: 0, missingFiles: [] };
  }

  let hydratedCount = 0;
  let cacheHits = 0;
  const missingFiles: string[] = [];

  let localManifestUrls = new Set<string>();
  try {
    const localRes = await api.getProjectAssetManifest(project.id);
    for (const item of localRes.assets || []) {
      if (item.exists && item.sizeBytes > 0) {
        localManifestUrls.add(item.localUrl);
      }
    }
  } catch {
    // proceed
  }

  for (const entry of entries) {
    if (localManifestUrls.has(entry.localUrl)) continue;

    let blob: Blob | null = null;
    if (entry.sha256) {
      const cached = await indexedDbStore.getCachedMedia(entry.sha256);
      if (cached) {
        blob = cached.blob;
        cacheHits += 1;
      }
    }

    if (!blob && client && entry.bucketPath) {
      const dl = await client.storage.from(SUPABASE_MEDIA_BUCKET).download(entry.bucketPath);
      if (!dl.error && dl.data) {
        blob = dl.data;
        addTrackedEgressBytes(dl.data.size);
        if (entry.sha256) {
          await indexedDbStore.putCachedMedia({
            sha256: entry.sha256,
            filename: entry.filename,
            mimeType: entry.mimeType,
            sizeBytes: dl.data.size,
            blob: dl.data,
            cachedAt: new Date().toISOString(),
          });
        }
      }
    }

    if (!blob) {
      missingFiles.push(entry.filename);
      continue;
    }

    const bucketMatch = entry.localUrl.match(/^\/media\/([^/]+)\//);
    const bucket = bucketMatch ? bucketMatch[1] : 'uploads';
    await api.hydrateAssetFromBlob(project.id, {
      blob,
      bucket,
      filename: entry.filename,
      assetKind: entry.assetKind,
      mimeType: entry.mimeType,
      targetLocalUrl: entry.localUrl,
    });
    hydratedCount += 1;
  }

  return { hydratedCount, cacheHits, missingFiles };
}

export async function pullCloudProjects(
  localProjects: Project[],
  options: { hydrateMedia?: boolean } = { hydrateMedia: true }
): Promise<{
  pulledCount: number;
  conflictCount: number;
  hydratedAssetsCount: number;
  cacheHits: number;
}> {
  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user) {
    throw new Error('Sign in to your Supabase Free account first.');
  }

  const { data, error } = await client
    .from('recap_projects')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(error.message);

  const pendingOps = await indexedDbStore.listPendingSyncOps();
  const pendingIds = new Set(pendingOps.map((p) => p.projectId));
  const localMap = new Map(localProjects.map((p) => [p.id, p]));
  const deviceId = getDeviceId();

  let pulledCount = 0;
  let conflictCount = 0;
  let hydratedAssetsCount = 0;
  let cacheHits = 0;

  for (const row of (data || []) as DbProjectRow[]) {
    const cloudProj = row.project_data;
    if (!cloudProj || !cloudProj.id) continue;

    const local = localMap.get(cloudProj.id);
    const hasPendingLocal = pendingIds.has(cloudProj.id);
    const remoteChangedByOtherDevice = row.last_device_id && row.last_device_id !== deviceId;
    const remoteSyncVer = Number(row.sync_version || 1);
    const localSyncVer = Number(local?.cloudSync?.syncVersion || 0);

    if (local && hasPendingLocal && remoteChangedByOtherDevice && remoteSyncVer > localSyncVer) {
      await api.updateProject(local.id, {
        cloudSync: {
          ...local.cloudSync,
          syncStatus: 'conflict',
          cloudUpdatedAt: row.updated_at,
          error: 'Edited on another device while this device had unsynced changes.',
        },
      });
      conflictCount += 1;
      continue;
    }

    if (!local || remoteSyncVer >= localSyncVer || row.updated_at > (local.cloudSync?.cloudUpdatedAt || '')) {
      const mergedCloud: Project = {
        ...cloudProj,
        cloudAssets: row.asset_manifest || cloudProj.cloudAssets || {},
        cloudSync: {
          ...(cloudProj.cloudSync || { syncStatus: 'cloud-synced' }),
          syncStatus: cloudProj.cloudSync?.syncStatus || 'cloud-synced',
          cloudUpdatedAt: row.updated_at,
          syncVersion: remoteSyncVer,
          lastDeviceId: row.last_device_id || undefined,
        },
      };

      const { project: savedLocal } = await api.upsertProjectFromCloud(mergedCloud);
      await indexedDbStore.saveProjectSnapshot(savedLocal);
      pulledCount += 1;

      if (options.hydrateMedia !== false) {
        const hyd = await hydrateProjectAssetsFromCloud(savedLocal);
        hydratedAssetsCount += hyd.hydratedCount;
        cacheHits += hyd.cacheHits;
      }
    }
  }

  return { pulledCount, conflictCount, hydratedAssetsCount, cacheHits };
}

export async function deleteCloudAssetFile(asset: CloudAssetRecord): Promise<void> {
  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user) throw new Error('Sign in to Supabase Free first.');

  if (asset.bucketPath) {
    const storageRes = await client.storage.from(SUPABASE_MEDIA_BUCKET).remove([asset.bucketPath]);
    if (storageRes.error) {
      throw new Error(`Could not remove storage file: ${storageRes.error.message}`);
    }
  }

  await client
    .from('recap_project_assets')
    .delete()
    .eq('asset_id', asset.id)
    .eq('user_id', user.id);

  const dbRes = await client
    .from('recap_cloud_assets')
    .delete()
    .eq('id', asset.id)
    .eq('user_id', user.id);
  if (dbRes.error) {
    throw new Error(`Could not remove asset metadata: ${dbRes.error.message}`);
  }
}

export async function deleteCloudProjectOnly(projectId: string): Promise<void> {
  const client = getSupabaseClient();
  const { user } = await getCloudSession();
  if (!client || !user) throw new Error('Sign in to Supabase Free first.');
  const { error } = await client
    .from('recap_projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
}

export function subscribeToCloudProjectsRealtime(
  userId: string,
  onRemoteUpdate: (row: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    project: Project | null;
    projectId: string;
    syncVersion: number;
    updatedAt: string;
  }) => void
): () => void {
  const client = getSupabaseClient();
  if (!client || !userId) return () => {};

  const myDeviceId = getDeviceId();
  let channel: RealtimeChannel | null = null;

  channel = client
    .channel(`recap_projects_user_${userId.slice(0, 8)}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'recap_projects',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const evt = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
        const newRow = payload.new as Partial<DbProjectRow> | undefined;
        const oldRow = payload.old as Partial<DbProjectRow> | undefined;

        if (newRow?.last_device_id && newRow.last_device_id === myDeviceId) {
          return;
        }

        const projectId = String(newRow?.id || oldRow?.id || '');
        if (!projectId) return;

        onRemoteUpdate({
          eventType: evt,
          project: newRow?.project_data
            ? {
                ...newRow.project_data,
                cloudAssets: newRow.asset_manifest || newRow.project_data.cloudAssets || {},
                cloudSync: {
                  ...(newRow.project_data.cloudSync || { syncStatus: 'cloud-synced' }),
                  syncStatus: newRow.project_data.cloudSync?.syncStatus || 'cloud-synced',
                  cloudUpdatedAt: newRow.updated_at,
                  syncVersion: Number(newRow.sync_version || 1),
                  lastDeviceId: newRow.last_device_id || undefined,
                },
              }
            : null,
          projectId,
          syncVersion: Number(newRow?.sync_version || 1),
          updatedAt: String(newRow?.updated_at || new Date().toISOString()),
        });
      }
    )
    .subscribe();

  return () => {
    if (channel) {
      void client.removeChannel(channel);
    }
  };
}
