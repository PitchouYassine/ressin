import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Download,
  FileDown,
  HardDrive,
  Loader2,
  LogOut,
  Minimize2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import {
  CloudAssetRecord,
  CloudStorageUsage,
  CloudUploadTask,
  PendingSyncOp,
  Project,
} from '../types/studio';
import { api, LocalAssetManifestItem } from '../lib/api';
import { formatBytes } from '../lib/formatters';
import { getStoredSupabaseConfig, indexedDbStore } from '../lib/indexedDbStore';
import { exportProjectBackupZip, importProjectBackupZip } from '../lib/projectBackup';
import {
  deleteCloudAssetFile,
  downloadProjectAsset,
  fetchCloudStorageUsage,
  isSupabaseConfigured,
  pullCloudProjects,
  signInCloudAccount,
  signOutCloudAccount,
  signUpCloudAccount,
  syncProjectToCloud,
  testSupabaseFreeSchema,
  updateSupabaseConfig,
} from '../lib/supabaseCloud';
import {
  getQuotaRatio,
  getQuotaSeverity,
  SUPABASE_FREE_LIMITS,
  ZERO_COST_CAPABILITY_MATRIX,
} from '../lib/supabaseFreeLimits';

interface CloudSyncModalProps {
  open: boolean;
  onClose: () => void;
  activeProject: Project | null;
  projects: Project[];
  cloudUserId: string | null;
  cloudUserEmail: string | null;
  isOnline: boolean;
  pendingOps: PendingSyncOp[];
  onProjectUpdated: (p: Project) => void;
  onRefreshProjects: () => Promise<void>;
  onAuthChanged: () => Promise<void>;
}

type ModalTab = 'account' | 'sync' | 'storage' | 'limits';

export function CloudSyncModal({
  open,
  onClose,
  activeProject,
  projects,
  cloudUserId,
  cloudUserEmail,
  isOnline,
  pendingOps,
  onProjectUpdated,
  onRefreshProjects,
  onAuthChanged,
}: CloudSyncModalProps) {
  const backupInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  const [tab, setTab] = useState<ModalTab>('sync');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [schemaSql, setSchemaSql] = useState('');
  const [schemaCopied, setSchemaCopied] = useState(false);
  const [showSql, setShowSql] = useState(false);

  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [isUploadingQueue, setIsUploadingQueue] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<CloudUploadTask[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [cloudUsage, setCloudUsage] = useState<CloudStorageUsage | null>(null);
  const [localUsage, setLocalUsage] = useState<{
    totalBytes: number;
    buckets: Record<string, { bytes: number; files: number }>;
  } | null>(null);
  const [idbUsage, setIdbUsage] = useState<{
    cachedProjects: number;
    pendingSyncCount: number;
    cachedMediaFiles: number;
    cachedMediaBytes: number;
  } | null>(null);

  const [manifest, setManifest] = useState<LocalAssetManifestItem[]>([]);
  const [syncVideoAsset, setSyncVideoAsset] = useState(true);
  const [syncFinalExport, setSyncFinalExport] = useState(true);
  const [syncMediaAssets, setSyncMediaAssets] = useState(true);
  const [compressionPreset, setCompressionPreset] = useState<
    'under-45mb' | '720p-compact' | '480p-compact'
  >('under-45mb');
  const [compressionTarget, setCompressionTarget] = useState<'source' | 'final-export'>('source');

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [loc, idb] = await Promise.all([
        api.getLocalStorageUsage().catch(() => null),
        indexedDbStore.getUsageSummary(),
      ]);
      if (loc) setLocalUsage(loc);
      setIdbUsage(idb);

      if (activeProject) {
        const mf = await api.getProjectAssetManifest(activeProject.id).catch(() => null);
        if (mf?.assets) {
          setManifest(mf.assets);
        }
      } else {
        setManifest([]);
      }

      if (cloudUserId && isOnline && isSupabaseConfigured()) {
        const cu = await fetchCloudStorageUsage(cloudUserId).catch(() => null);
        if (cu) setCloudUsage(cu);
      } else {
        setCloudUsage(null);
      }
    } catch {
      // ignore transient telemetry refresh failure
    }
  }, [activeProject, cloudUserId, isOnline]);

  useEffect(() => {
    if (!open) return;
    const cfg = getStoredSupabaseConfig();
    if (cfg) {
      setSupabaseUrl(cfg.url);
      setSupabaseAnonKey(cfg.anonKey);
    }
    setErrorMsg(null);
    setStatusMsg(null);
    void refreshDiagnostics();
    if (!cloudUserId) {
      setTab('account');
    }
  }, [open, cloudUserId, refreshDiagnostics]);

  if (!open) return null;

  const loadSqlIfNeeded = async () => {
    if (schemaSql) return schemaSql;
    const res = await api.getSupabaseSchema();
    setSchemaSql(res.sql || '');
    return res.sql || '';
  };

  const handleSaveSupabaseConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    if (!supabaseUrl.trim() || !supabaseAnonKey.trim()) {
      setErrorMsg('Enter both your Supabase Free Project URL and public anon key.');
      return;
    }
    updateSupabaseConfig({ url: supabaseUrl.trim(), anonKey: supabaseAnonKey.trim() });
    setBusyMsg('Verifying Supabase Free schema...');
    try {
      const check = await testSupabaseFreeSchema();
      if (!check.ok) {
        setErrorMsg(check.error || 'Could not reach recap_projects / recap_project_assets.');
      } else {
        setStatusMsg('Supabase Free project connected and full-cloud schema verified.');
      }
      await onAuthChanged();
      await refreshDiagnostics();
    } finally {
      setBusyMsg(null);
    }
  };

  const handleClearConfig = async () => {
    updateSupabaseConfig(null);
    setSupabaseUrl('');
    setSupabaseAnonKey('');
    setCloudUsage(null);
    await onAuthChanged();
    setStatusMsg('Disconnected Supabase cloud configuration. Local projects remain intact.');
  };

  const handleCopySql = async () => {
    try {
      const sql = await loadSqlIfNeeded();
      await navigator.clipboard.writeText(sql);
      setSchemaCopied(true);
      setShowSql(true);
      window.setTimeout(() => setSchemaCopied(false), 2500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadSql = async () => {
    try {
      const sql = await loadSqlIfNeeded();
      const blob = new Blob([sql], { type: 'text/sql' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'supabase_free_schema.sql';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    if (!email.trim() || !password) {
      setErrorMsg('Email and password are required.');
      return;
    }
    setBusyMsg(authMode === 'signup' ? 'Creating free account...' : 'Signing in...');
    try {
      if (authMode === 'signup') {
        const res = await signUpCloudAccount(email.trim(), password);
        setStatusMsg(
          res.needsEmailConfirmation
            ? 'Account created. Check your inbox to confirm your email, then sign in.'
            : 'Account created and signed in.'
        );
      } else {
        await signInCloudAccount(email.trim(), password);
        setStatusMsg('Signed in to Supabase Free Cloud.');
      }
      await onAuthChanged();
      await refreshDiagnostics();
      setTab('sync');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleSignOut = async () => {
    setBusyMsg('Signing out...');
    try {
      await signOutCloudAccount();
      setCloudUsage(null);
      await onAuthChanged();
      setStatusMsg('Signed out. Local SQLite & IndexedDB projects remain accessible.');
    } finally {
      setBusyMsg(null);
    }
  };

  const handleSyncActiveProject = async (retryUrls?: string[]) => {
    if (!activeProject) return;
    setErrorMsg(null);
    setStatusMsg(null);

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setIsUploadingQueue(true);
    setBusyMsg(
      retryUrls?.length
        ? `Retrying ${retryUrls.length} failed upload(s) with integrity verification...`
        : 'Uploading all project media & verifying integrity in Supabase Free Cloud...'
    );

    try {
      const res = await syncProjectToCloud(activeProject, {
        syncVideoAsset,
        syncFinalExport,
        syncMediaAssets,
        retryUrls,
        signal: controller.signal,
        onTaskUpdate: (nextTasks) => setUploadTasks(nextTasks),
      });
      onProjectUpdated(res.project);
      setUploadTasks(res.tasks);
      if (res.failedUploads.length > 0) {
        setErrorMsg(
          `${res.failedUploads.length} upload(s) failed: ${res.failedUploads
            .map((f) => `${f.filename} (${f.reason})`)
            .join('; ')}`
        );
      } else {
        setStatusMsg(res.message);
      }
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      uploadAbortRef.current = null;
      setIsUploadingQueue(false);
      setBusyMsg(null);
    }
  };

  const handleCancelUpload = () => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      setBusyMsg('Stopping upload queue safely (local data preserved)...');
    }
  };

  const handleSyncAllPending = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setIsUploadingQueue(true);
    setBusyMsg('Flushing pending offline queue to Supabase Free Cloud...');
    try {
      let synced = 0;
      for (const op of pendingOps) {
        if (controller.signal.aborted) break;
        const proj = projects.find((p) => p.id === op.projectId);
        if (!proj) {
          await indexedDbStore.clearPendingSync(op.projectId);
          continue;
        }
        const res = await syncProjectToCloud(proj, {
          syncVideoAsset,
          syncFinalExport,
          syncMediaAssets,
          signal: controller.signal,
          onTaskUpdate: (t) => setUploadTasks(t),
        });
        onProjectUpdated(res.project);
        synced += 1;
      }
      setStatusMsg(`Processed ${synced} queued project(s).`);
      await onRefreshProjects();
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      uploadAbortRef.current = null;
      setIsUploadingQueue(false);
      setBusyMsg(null);
    }
  };

  const handlePullCloudProjects = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg('Pulling projects & hydrating media from Supabase Free Cloud...');
    try {
      const res = await pullCloudProjects(projects, { hydrateMedia: true });
      await onRefreshProjects();
      await refreshDiagnostics();
      setStatusMsg(
        `Pulled ${res.pulledCount} project(s) · Hydrated ${res.hydratedAssetsCount} file(s) (${res.cacheHits} served from local IndexedDB cache without egress)${
          res.conflictCount > 0 ? ` · ${res.conflictCount} conflict(s) flagged` : ''
        }.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleCompressVideo = async () => {
    if (!activeProject) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg(
      compressionTarget === 'final-export'
        ? 'Compressing final MP4 locally with FFmpeg (original kept intact)...'
        : 'Compressing source video locally with FFmpeg (original kept intact)...'
    );
    try {
      const res = await api.compressProjectVideo(
        activeProject.id,
        compressionPreset,
        compressionTarget
      );
      onProjectUpdated(res.project);
      setStatusMsg(
        `Compressed locally via FFmpeg (${res.target === 'final-export' ? 'Final MP4' : 'Source Video'}): ${formatBytes(
          res.originalBytes
        )} → ${formatBytes(res.compressedBytes)}. Original file preserved locally on disk.`
      );
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleExportBackup = async () => {
    if (!activeProject) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg('Creating portable project backup (.recapbackup.zip)...');
    try {
      const res = await exportProjectBackupZip(activeProject, (_pct, label) => setBusyMsg(label));
      setStatusMsg(
        `Exported ${res.filename} (${formatBytes(res.totalBytes)}, ${res.assetCount} asset(s)).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleImportBackup = async (file: File) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg('Restoring project backup...');
    try {
      const restored = await importProjectBackupZip(file, (_pct, label) => setBusyMsg(label));
      onProjectUpdated(restored);
      await onRefreshProjects();
      await refreshDiagnostics();
      setStatusMsg(`Restored "${restored.name}" from local backup archive.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleDeleteCloudAsset = async (asset: CloudAssetRecord) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyMsg(`Removing ${asset.filename} from cloud storage only...`);
    try {
      await deleteCloudAssetFile(asset);
      setStatusMsg(
        `Deleted "${asset.filename}" from Supabase Cloud Storage (${formatBytes(
          asset.sizeBytes
        )} freed). Local files were kept intact.`
      );
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleDownloadAsset = async (localUrl: string, filename: string) => {
    if (!activeProject) return;
    setErrorMsg(null);
    try {
      const res = await downloadProjectAsset({
        localUrl,
        cloudAssets: activeProject.cloudAssets,
        filename,
      });
      setStatusMsg(
        `Downloaded "${filename}" via ${
          res.source === 'local'
            ? 'local disk'
            : res.source === 'indexeddb'
            ? 'IndexedDB cache'
            : 'authenticated Supabase Cloud Storage'
        }.`
      );
      await refreshDiagnostics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearBrowserCache = async () => {
    await indexedDbStore.clearCachedMedia();
    await refreshDiagnostics();
    setStatusMsg('Cleared browser IndexedDB blob cache. Projects & local disk files unchanged.');
  };

  const storageUsed = cloudUsage?.storageUsedBytes ?? 0;
  const storageLimit = cloudUsage?.storageLimitBytes ?? SUPABASE_FREE_LIMITS.storageBytes;
  const storageSeverity = getQuotaSeverity(storageUsed, storageLimit);
  const storagePct = Math.round(getQuotaRatio(storageUsed, storageLimit) * 100);

  const dbUsed = cloudUsage?.dbUsedBytes ?? 0;
  const dbLimit = cloudUsage?.dbLimitBytes ?? SUPABASE_FREE_LIMITS.dbBytes;
  const dbPct = Math.round(getQuotaRatio(dbUsed, dbLimit) * 100);

  const egressUsed = cloudUsage?.egressTrackedBytes ?? 0;
  const egressLimit = cloudUsage?.egressLimitBytes ?? SUPABASE_FREE_LIMITS.egressBytes;
  const egressPct = Math.round(getQuotaRatio(egressUsed, egressLimit) * 100);

  const existingCloudBySha = new Map<string, CloudAssetRecord>();
  for (const a of cloudUsage?.assets || []) {
    if (a.sha256) existingCloudBySha.set(a.sha256, a);
  }

  const failedTaskUrls = uploadTasks
    .filter((t) => t.status === 'failed' || t.status === 'cancelled')
    .map((t) => t.localUrl);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-5xl max-h-[90vh] rounded-xl bg-[#111115] border border-white/[0.1] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-display font-semibold text-white truncate">
              Full Cloud Media Storage &amp; Multi-Device Sync (Supabase Free Only)
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mt-0.5">
              <span>Supabase Free Plan (1 GB / 50 MB max file)</span>
              <span aria-hidden="true">·</span>
              <span>{isOnline ? 'Network Online' : 'Offline Mode (IndexedDB Active)'}</span>
              <span aria-hidden="true">·</span>
              <span>{cloudUserEmail ? `Signed in: ${cloudUserEmail}` : 'Not signed in'}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer shrink-0"
            aria-label="Close Cloud Sync Modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 border-b border-white/[0.08] flex items-center gap-1 overflow-x-auto shrink-0">
          {(
            [
              { id: 'account', label: 'Account & Free Setup' },
              { id: 'sync', label: 'Full Media Upload, Queue & Compress' },
              { id: 'storage', label: 'Quota, Bandwidth & Cloud Files' },
              { id: 'limits', label: 'Free Limits & Local FFmpeg' },
            ] as Array<{ id: ModalTab; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3.5 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === item.id
                  ? 'border-violet-500 text-white bg-white/[0.04]'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Notifications */}
        {(busyMsg || errorMsg || statusMsg || storageSeverity !== 'ok') && (
          <div className="px-6 pt-4 space-y-2 shrink-0">
            {storageSeverity === 'exceeded' && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Supabase Free 1 GB Storage Limit Reached:</span>{' '}
                  Existing cloud projects remain protected. Delete unused cloud files or export backup (.recapbackup.zip). No paid plan will ever be activated automatically.
                </div>
              </div>
            )}
            {(storageSeverity === 'warning' || storageSeverity === 'critical') && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  Approaching Supabase Free Storage cap ({storagePct}% of 1,024 MB used). Delete unused cloud files or compress large videos with local FFmpeg.
                </span>
              </div>
            )}
            {busyMsg && (
              <div className="p-3 rounded-lg bg-violet-600/10 border border-violet-500/30 text-xs text-violet-200 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
                  <span>{busyMsg}</span>
                </div>
                {isUploadingQueue && (
                  <button
                    type="button"
                    onClick={handleCancelUpload}
                    className="px-2.5 py-1 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Cancel Upload
                  </button>
                )}
              </div>
            )}
            {errorMsg && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}
            {statusMsg && !busyMsg && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{statusMsg}</span>
              </div>
            )}
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: ACCOUNT & FREE SETUP */}
          {tab === 'account' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    01. Connect Your Supabase Free Project
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1">
                    Uses Supabase Free Plan only (1 GB Storage, 50 MB max single file, 500 MB DB, Free Auth + Realtime). No paid upgrade is ever triggered.
                  </p>
                </div>

                <form onSubmit={handleSaveSupabaseConfig} className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-300 block mb-1">
                      Supabase Project URL
                    </label>
                    <input
                      type="url"
                      value={supabaseUrl}
                      onChange={(e) => setSupabaseUrl(e.target.value)}
                      placeholder="https://your-free-project.supabase.co"
                      className="w-full bg-[#09090B] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-300 block mb-1">
                      Supabase Public Anon Key
                    </label>
                    <input
                      type="password"
                      value={supabaseAnonKey}
                      onChange={(e) => setSupabaseAnonKey(e.target.value)}
                      placeholder="eyJhbGciOi..."
                      className="w-full bg-[#09090B] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={Boolean(busyMsg)}
                      className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Save &amp; Verify Schema
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopySql()}
                      className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {schemaCopied ? 'Copied SQL' : 'Copy Free SQL Schema'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadSql()}
                      className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      Download .sql
                    </button>
                    {isSupabaseConfigured() && (
                      <button
                        type="button"
                        onClick={() => void handleClearConfig()}
                        className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-xs text-zinc-400 hover:text-zinc-200 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </form>

                {showSql && schemaSql && (
                  <pre className="p-3 rounded-lg bg-[#09090B] border border-white/[0.08] text-[11px] font-mono text-zinc-300 max-h-48 overflow-auto">
                    {schemaSql}
                  </pre>
                )}
              </div>

              <div className="space-y-4 lg:border-l lg:border-white/[0.08] lg:pl-6">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    02. Multi-Device Account Sign In
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1">
                    Sign in with the same email &amp; password on desktop, laptop, or mobile to access all uploaded videos, narration, exports, fonts, logos, and thumbnails.
                  </p>
                </div>

                {cloudUserEmail ? (
                  <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs text-zinc-400">Authenticated Account</div>
                        <div className="text-sm font-medium text-white">{cloudUserEmail}</div>
                      </div>
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => void handlePullCloudProjects()}
                        disabled={Boolean(busyMsg) || !isOnline}
                        className="px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Pull All Cloud Projects &amp; Media
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSignOut()}
                        className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Sign Out
                      </button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleAuthSubmit} className="space-y-3">
                    <div className="flex items-center gap-1 p-1 rounded-lg bg-[#09090B] border border-white/[0.08] w-fit">
                      <button
                        type="button"
                        onClick={() => setAuthMode('signin')}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
                          authMode === 'signin'
                            ? 'bg-violet-600 text-white'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        Sign In
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthMode('signup')}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
                          authMode === 'signup'
                            ? 'bg-violet-600 text-white'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        Create Free Account
                      </button>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-300 block mb-1">Email</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="w-full bg-[#09090B] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-300 block mb-1">Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Minimum 6 characters"
                        className="w-full bg-[#09090B] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={Boolean(busyMsg) || !isSupabaseConfigured()}
                      className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {authMode === 'signup' ? 'Register Free Account' : 'Sign In Across Devices'}
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: FULL MEDIA UPLOAD, QUEUE & COMPRESS */}
          {tab === 'sync' && (
            <div className="space-y-6">
              {pendingOps.length > 0 && (
                <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5 text-xs">
                    <div className="font-semibold text-amber-200">
                      {pendingOps.length} project(s) have unverified/queued changes (not yet fully verified in cloud)
                    </div>
                    <div className="text-amber-300/80">
                      {pendingOps.map((p) => `${p.projectName} (${p.reason})`).join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSyncAllPending()}
                    disabled={!cloudUserId || !isOnline || Boolean(busyMsg)}
                    className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-xs font-semibold text-zinc-950 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Sync Queued Projects
                  </button>
                </div>
              )}

              {activeProject ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-white/[0.08]">
                    <div>
                      <div className="text-xs text-zinc-400">Active Project Full Cloud Status</div>
                      <div className="text-base font-semibold text-white mt-0.5">
                        {activeProject.name}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mt-1">
                        <span>
                          Status:{' '}
                          <strong className="text-zinc-200">
                            {activeProject.cloudSync?.syncStatus || 'local-only'}
                          </strong>
                        </span>
                        {activeProject.cloudSync?.cloudUpdatedAt && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              Last cloud sync:{' '}
                              {new Date(activeProject.cloudSync.cloudUpdatedAt).toLocaleString()}
                            </span>
                          </>
                        )}
                      </div>
                      {activeProject.cloudSync?.error && (
                        <div className="text-xs text-amber-300 mt-1.5">
                          {activeProject.cloudSync.error}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {failedTaskUrls.length > 0 && !isUploadingQueue && (
                        <button
                          type="button"
                          onClick={() => void handleSyncActiveProject(failedTaskUrls)}
                          disabled={!cloudUserId || !isOnline}
                          className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-zinc-950 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Retry Failed ({failedTaskUrls.length})
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleSyncActiveProject()}
                        disabled={Boolean(busyMsg) || !cloudUserId || !isOnline}
                        className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Cloud className="w-3.5 h-3.5" />
                        Upload &amp; Verify All Media
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleExportBackup()}
                        disabled={Boolean(busyMsg)}
                        className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        Export Backup (.zip)
                      </button>
                    </div>
                  </div>

                  {/* Full Cloud Media Inclusion Toggles (Default ON) */}
                  <div className="flex flex-wrap items-center gap-5 text-xs text-zinc-300">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncMediaAssets}
                        onChange={(e) => setSyncMediaAssets(e.target.checked)}
                        className="accent-violet-500"
                      />
                      Upload narration, audio segments, music, SFX, logos, fonts &amp; thumbnails
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncVideoAsset && syncMediaAssets}
                        disabled={!syncMediaAssets}
                        onChange={(e) => setSyncVideoAsset(e.target.checked)}
                        className="accent-violet-500"
                      />
                      Upload original source video (&le; 50 MB)
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncFinalExport && syncMediaAssets}
                        disabled={!syncMediaAssets}
                        onChange={(e) => setSyncFinalExport(e.target.checked)}
                        className="accent-violet-500"
                      />
                      Upload final rendered MP4 (&le; 50 MB)
                    </label>
                  </div>

                  {/* Live Resumable Upload & Verification Queue */}
                  {uploadTasks.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-zinc-200">
                          Resumable Upload &amp; Integrity Verification Queue ({uploadTasks.length})
                        </h4>
                        <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                          5 MB TUS Chunks · Verified Size Check
                        </span>
                      </div>
                      <div className="rounded-lg bg-[#09090B] border border-white/[0.08] divide-y divide-white/[0.06]">
                        {uploadTasks.map((t) => (
                          <div key={t.id} className="p-3 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-medium text-zinc-100 truncate">
                                  {t.filename}
                                </span>
                                <span className="text-[11px] text-zinc-500 capitalize shrink-0">
                                  {t.assetKind}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 shrink-0 font-mono tabular-nums text-[11px]">
                                <span className="text-zinc-400">
                                  {formatBytes(t.uploadedBytes)} / {formatBytes(t.sizeBytes)}
                                </span>
                                <span
                                  className={
                                    t.status === 'verified' || t.status === 'deduplicated'
                                      ? 'text-emerald-400 font-semibold'
                                      : t.status === 'failed' || t.status === 'quota-blocked'
                                      ? 'text-red-400 font-semibold'
                                      : t.status === 'cancelled' || t.status === 'exceeds-free-cap'
                                      ? 'text-amber-300 font-semibold'
                                      : 'text-violet-300 font-semibold'
                                  }
                                >
                                  {t.status === 'uploading'
                                    ? `${t.progressPct}%`
                                    : t.status === 'verifying'
                                    ? 'Verifying...'
                                    : t.status === 'verified'
                                    ? 'Verified'
                                    : t.status === 'deduplicated'
                                    ? 'Deduplicated (Verified)'
                                    : t.status === 'exceeds-free-cap'
                                    ? '>50 MB Free Cap'
                                    : t.status === 'quota-blocked'
                                    ? '1 GB Quota Full'
                                    : t.status}
                                </span>
                              </div>
                            </div>
                            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={`h-full transition-all ${
                                  t.status === 'verified' || t.status === 'deduplicated'
                                    ? 'bg-emerald-500'
                                    : t.status === 'failed' || t.status === 'quota-blocked'
                                    ? 'bg-red-500'
                                    : t.status === 'cancelled' || t.status === 'exceeds-free-cap'
                                    ? 'bg-amber-500'
                                    : 'bg-violet-500'
                                }`}
                                style={{ width: `${t.progressPct}%` }}
                              />
                            </div>
                            {t.error && (
                              <div className="text-[11px] text-amber-300">{t.error}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Optional Local FFmpeg Compression for >50 MB Free Cap Fit */}
                  {(activeProject.sourceVideoUrl || activeProject.lastExportUrl) && (
                    <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                      <div className="space-y-1 max-w-lg">
                        <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                          <Minimize2 className="w-3.5 h-3.5 text-violet-400" />
                          Local FFmpeg Video Compression (User Triggered Only)
                        </div>
                        <p className="text-xs text-zinc-400">
                          Shrinks videos over Supabase Free&apos;s 50 MB single-file limit cleanly to &lt;45 MB. Source files remain preserved on local disk.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <select
                          value={compressionTarget}
                          onChange={(e) =>
                            setCompressionTarget(e.target.value as 'source' | 'final-export')
                          }
                          className="bg-[#111115] border border-white/[0.12] rounded-lg px-2.5 py-2 text-xs text-zinc-100 cursor-pointer"
                        >
                          {activeProject.sourceVideoUrl && (
                            <option value="source">Original Video</option>
                          )}
                          {activeProject.lastExportUrl && (
                            <option value="final-export">Final Export MP4</option>
                          )}
                        </select>
                        <select
                          value={compressionPreset}
                          onChange={(e) =>
                            setCompressionPreset(
                              e.target.value as 'under-45mb' | '720p-compact' | '480p-compact'
                            )
                          }
                          className="bg-[#111115] border border-white/[0.12] rounded-lg px-2.5 py-2 text-xs text-zinc-100 cursor-pointer"
                        >
                          <option value="under-45mb">Fit &lt; 45 MB (Supabase Cap)</option>
                          <option value="720p-compact">720p Compact (CRF 27)</option>
                          <option value="480p-compact">480p Ultra-Compact</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => void handleCompressVideo()}
                          disabled={Boolean(busyMsg)}
                          className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Compress Locally
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Full Project Asset Manifest & Integrity Verification Table */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-300">
                      Complete Project Media Assets ({manifest.length}) — SHA-256 Deduplicated &amp; Verified
                    </h4>
                    {manifest.length === 0 ? (
                      <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] text-xs text-zinc-500">
                        No media files attached yet. Project settings and captions sync via lightweight JSON.
                      </div>
                    ) : (
                      <div className="rounded-lg bg-[#09090B] border border-white/[0.08] overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-white/[0.08] text-zinc-500">
                            <tr>
                              <th className="py-2 px-3 font-medium">File</th>
                              <th className="py-2 px-3 font-medium">Asset Type</th>
                              <th className="py-2 px-3 font-medium text-right">Size</th>
                              <th className="py-2 px-3 font-medium">SHA-256</th>
                              <th className="py-2 px-3 font-medium">Cloud Verification Status</th>
                              <th className="py-2 px-3 font-medium text-right">Download</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06]">
                            {manifest.map((item) => {
                              const manifestCloud = activeProject.cloudAssets?.[item.localUrl];
                              const cloudRow = item.sha256
                                ? existingCloudBySha.get(item.sha256)
                                : undefined;
                              const isVerifiedInCloud = Boolean(
                                manifestCloud?.verified || cloudRow?.verified
                              );
                              return (
                                <tr key={item.localUrl}>
                                  <td className="py-2 px-3 text-zinc-200 max-w-[190px] truncate">
                                    {item.filename}
                                  </td>
                                  <td className="py-2 px-3 text-zinc-400 capitalize">
                                    {item.assetKind}
                                  </td>
                                  <td className="py-2 px-3 text-right font-mono tabular-nums text-zinc-300">
                                    {formatBytes(item.sizeBytes)}
                                  </td>
                                  <td className="py-2 px-3 font-mono text-zinc-500">
                                    {item.sha256 ? item.sha256.slice(0, 10) : '—'}
                                  </td>
                                  <td className="py-2 px-3">
                                    {isVerifiedInCloud ? (
                                      <span className="text-emerald-300">
                                        Cloud Verified ({formatBytes(manifestCloud?.verifiedSizeBytes || item.sizeBytes)})
                                      </span>
                                    ) : !item.exists ? (
                                      <span className="text-amber-300">
                                        {manifestCloud?.bucketPath
                                          ? 'In cloud (download / hydrate ready)'
                                          : 'Missing locally & not verified'}
                                      </span>
                                    ) : item.exceedsFree50MbCap ? (
                                      <span className="text-amber-300">
                                        &gt;50 MB free cap (compress &lt;45 MB or keep local)
                                      </span>
                                    ) : (
                                      <span className="text-zinc-300">Ready for verified upload</span>
                                    )}
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {(item.exists || manifestCloud?.bucketPath) && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void handleDownloadAsset(item.localUrl, item.filename)
                                        }
                                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                      >
                                        <Download className="w-3 h-3" />
                                        Download
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-6 rounded-lg bg-[#09090B] border border-white/[0.08] text-xs text-zinc-400">
                  Select or create a project in Stage 1 to upload media, monitor verification, or export backups.
                </div>
              )}

              {/* Portable Backup Restore */}
              <div className="pt-4 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                <div className="text-xs text-zinc-400">
                  Restore any project and its media on another machine offline via portable{' '}
                  <span className="font-mono text-zinc-200">.recapbackup.zip</span> archive.
                </div>
                <div>
                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".zip,.recapbackup.zip"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImportBackup(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => backupInputRef.current?.click()}
                    disabled={Boolean(busyMsg)}
                    className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Import Backup (.zip)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: QUOTA, BANDWIDTH & CLOUD FILES */}
          {tab === 'storage' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Supabase Cloud Storage</span>
                    <Cloud className="w-3.5 h-3.5 text-violet-400" />
                  </div>
                  <div className="text-sm font-mono tabular-nums font-semibold text-white">
                    {formatBytes(storageUsed)} / 1 GB
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        storageSeverity === 'exceeded'
                          ? 'bg-red-500'
                          : storageSeverity === 'warning' || storageSeverity === 'critical'
                          ? 'bg-amber-500'
                          : 'bg-violet-500'
                      }`}
                      style={{ width: `${Math.min(100, storagePct)}%` }}
                    />
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                    {storagePct}% used · 50 MB max single file
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Supabase PostgreSQL DB</span>
                    <Database className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                  <div className="text-sm font-mono tabular-nums font-semibold text-white">
                    {formatBytes(dbUsed)} / 500 MB
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${Math.min(100, Math.max(dbUsed > 0 ? 1 : 0, dbPct))}%` }}
                    />
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                    {cloudUsage?.projectCount ?? 0} cloud project(s)
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Session Cloud Egress Tracked</span>
                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                  </div>
                  <div className="text-sm font-mono tabular-nums font-semibold text-white">
                    {formatBytes(egressUsed)} / 5 GB
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cyan-500 transition-all"
                      style={{ width: `${Math.min(100, egressPct)}%` }}
                    />
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                    IndexedDB cache: {formatBytes(idbUsage?.cachedMediaBytes ?? 0)}
                    {(idbUsage?.cachedMediaFiles ?? 0) > 0 && (
                      <>
                        {' · '}
                        <button
                          type="button"
                          onClick={() => void handleClearBrowserCache()}
                          className="text-violet-400 hover:text-violet-300 cursor-pointer"
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Local Server Disk</span>
                    <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                  <div className="text-sm font-mono tabular-nums font-semibold text-white">
                    {formatBytes(localUsage?.totalBytes ?? 0)}
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                    FFmpeg processing executes locally
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-zinc-200">
                    Cloud Files in Supabase Storage ({cloudUsage?.assets.length ?? 0})
                  </h4>
                  <button
                    type="button"
                    onClick={() => void refreshDiagnostics()}
                    disabled={!cloudUserId || Boolean(busyMsg)}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </button>
                </div>

                {!cloudUserId ? (
                  <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] text-xs text-zinc-500">
                    Sign in on the Account tab to inspect, download, or clean up files stored in Supabase Free Storage.
                  </div>
                ) : (cloudUsage?.assets.length || 0) === 0 ? (
                  <div className="p-4 rounded-lg bg-[#09090B] border border-white/[0.08] text-xs text-zinc-500">
                    No media files uploaded to Supabase Storage yet.
                  </div>
                ) : (
                  <div className="rounded-lg bg-[#09090B] border border-white/[0.08] overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-white/[0.08] text-zinc-500">
                        <tr>
                          <th className="py-2.5 px-3 font-medium">Filename</th>
                          <th className="py-2.5 px-3 font-medium">Kind</th>
                          <th className="py-2.5 px-3 font-medium text-right">Size</th>
                          <th className="py-2.5 px-3 font-medium">Verified</th>
                          <th className="py-2.5 px-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {cloudUsage!.assets.map((asset) => (
                          <tr key={asset.id}>
                            <td className="py-2.5 px-3 text-zinc-200 max-w-[200px] truncate">
                              {asset.filename}
                            </td>
                            <td className="py-2.5 px-3 text-zinc-400 capitalize">
                              {asset.assetKind}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-zinc-300">
                              {formatBytes(asset.sizeBytes)}
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums">
                              {asset.verified ? (
                                <span className="text-emerald-300">Verified</span>
                              ) : (
                                <span className="text-amber-300">Pending</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void downloadProjectAsset({
                                      localUrl: asset.originalLocalUrl,
                                      cloudAssets: {
                                        [asset.originalLocalUrl]: {
                                          localUrl: asset.originalLocalUrl,
                                          bucketPath: asset.bucketPath,
                                          sha256: asset.sha256,
                                          sizeBytes: asset.sizeBytes,
                                          assetKind: asset.assetKind,
                                          filename: asset.filename,
                                          mimeType: asset.mimeType,
                                          syncedAt: asset.createdAt,
                                        },
                                      },
                                      filename: asset.filename,
                                    }).catch((e) =>
                                      setErrorMsg(e instanceof Error ? e.message : String(e))
                                    )
                                  }
                                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <Download className="w-3 h-3" />
                                  Download
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteCloudAsset(asset)}
                                  disabled={Boolean(busyMsg)}
                                  className="px-2.5 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-300 text-[11px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Delete Cloud Copy
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: FREE LIMITS & LOCAL FFMPEG */}
          {tab === 'limits' && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5 text-xs text-zinc-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  This workspace runs on Supabase Free Plan only (1 GB Storage, 50 MB single-file limit, 500 MB DB, 5 GB monthly egress) without paid upgrades. FFmpeg video rendering runs 100% locally, then uploads and verifies your finished MP4 to cloud storage automatically when within free limits.
                </span>
              </div>

              <div className="rounded-lg bg-[#09090B] border border-white/[0.08] overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/[0.08] text-zinc-500">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Feature</th>
                      <th className="py-2.5 px-3 font-medium">Classification</th>
                      <th className="py-2.5 px-3 font-medium">Execution Engine</th>
                      <th className="py-2.5 px-3 font-medium">Real Free-Tier Limitation / Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {ZERO_COST_CAPABILITY_MATRIX.map((row) => (
                      <tr key={row.feature}>
                        <td className="py-2.5 px-3 text-zinc-100 font-medium">{row.feature}</td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {row.tier === 'free-local' ? (
                            <span className="text-emerald-300 font-medium">Free · Local</span>
                          ) : row.tier === 'free-cloud' ? (
                            <span className="text-violet-300 font-medium">Free · Cloud</span>
                          ) : (
                            <span className="text-amber-300 font-medium">Optional Paid Key</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-zinc-300">{row.engine}</td>
                        <td className="py-2.5 px-3 text-zinc-400">{row.limitation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
