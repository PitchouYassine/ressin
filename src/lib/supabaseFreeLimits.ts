export const SUPABASE_FREE_LIMITS = {
  dbBytes: 500 * 1024 * 1024, // 500 MB PostgreSQL Free Plan limit
  storageBytes: 1024 * 1024 * 1024, // 1 GB Supabase Storage Free Plan limit
  maxSingleFileBytes: 50 * 1024 * 1024, // 50 MB max single file upload on Free Plan
  egressBytes: 5 * 1024 * 1024 * 1024, // 5 GB monthly egress reference limit
  realtimeMessagesMonthly: 2_000_000, // 2M Realtime messages/month
  realtimeMaxConnections: 200, // 200 concurrent connections
  warningThresholdRatio: 0.75, // Warn at 75% (768 MB storage / 375 MB DB)
  criticalThresholdRatio: 0.9, // Critical warning at 90% (921 MB)
  safeUploadTargetBytes: 45 * 1024 * 1024, // 45 MB FFmpeg compression target to stay safely under 50 MB
} as const;

export type QuotaSeverity = 'ok' | 'warning' | 'critical' | 'exceeded';

export function getQuotaSeverity(usedBytes: number, limitBytes: number): QuotaSeverity {
  if (limitBytes <= 0) return 'exceeded';
  const ratio = usedBytes / limitBytes;
  if (ratio >= 1.0) return 'exceeded';
  if (ratio >= SUPABASE_FREE_LIMITS.criticalThresholdRatio) return 'critical';
  if (ratio >= SUPABASE_FREE_LIMITS.warningThresholdRatio) return 'warning';
  return 'ok';
}

export function getQuotaRatio(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 1;
  return Math.max(0, Math.min(1, usedBytes / limitBytes));
}

export interface ArchitectureCapabilityRow {
  feature: string;
  tier: 'free-local' | 'free-cloud' | 'optional-paid';
  engine: string;
  limitation: string;
}

export const ZERO_COST_CAPABILITY_MATRIX: ArchitectureCapabilityRow[] = [
  {
    feature: 'Video Rendering, Cropping, Filters, Blur, Logos & MP4 Export',
    tier: 'free-local',
    engine: 'Local FFmpeg Engine + Auto-Upload to Cloud',
    limitation: 'Rendering runs locally (not on cloud GPUs); finished MP4 uploads & verifies to Supabase Free when <= 50 MB.',
  },
  {
    feature: 'Media Compression (for <50 MB Free Cloud Fit)',
    tier: 'free-local',
    engine: 'Local FFmpeg H.264 / AAC',
    limitation: 'Only runs when explicitly triggered by user; never alters or deletes source files silently.',
  },
  {
    feature: 'Offline Caching, Edit Queue & SHA-256 Blob Cache',
    tier: 'free-local',
    engine: 'Browser IndexedDB',
    limitation: 'Eliminates duplicate downloads across edits; export backup (.zip) available anytime.',
  },
  {
    feature: 'Translation & Transcript Workflow',
    tier: 'free-local',
    engine: 'External / Manual Gemini JSON Workflow',
    limitation: '100% free with zero API key required.',
  },
  {
    feature: 'Multi-Device Accounts & Relational Project Database',
    tier: 'free-cloud',
    engine: 'Supabase Free Auth + PostgreSQL',
    limitation: '500 MB database limit; free project pauses after 7 days of zero activity.',
  },
  {
    feature: 'Full Cloud Media Storage (Videos, Exports, Narration, Music, SFX, Logos, Fonts, Thumbnails)',
    tier: 'free-cloud',
    engine: 'Supabase Free Storage + TUS Resumable Upload + Integrity Verification',
    limitation: '1 GB total storage, 50 MB max single file, 5 GB monthly egress; files <= 50 MB upload in 5 MB chunks.',
  },
  {
    feature: 'Live Multi-Device Sync Notifications',
    tier: 'free-cloud',
    engine: 'Supabase Free Realtime (Debounced)',
    limitation: '200 concurrent connections & 2M messages/month.',
  },
  {
    feature: 'AI Voiceover Dubbing & ASR Transcription',
    tier: 'optional-paid',
    engine: 'Existing Fish Audio / Optional Gemini API Key',
    limitation: 'Depends on your own configured API credits; not required for manual editing, captions, or export.',
  },
];
