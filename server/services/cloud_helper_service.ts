import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AUDIO_DIR,
  BACKGROUNDS_DIR,
  EXPORTS_DIR,
  FONTS_DIR,
  LOGOS_DIR,
  MASKS_DIR,
  STORAGE_DIR,
  TEMP_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  getAssetByUrl,
  listAssetsByProject,
  listCustomFonts,
  registerAsset,
  registerCustomFont,
} from '../db.ts';
import { analyzeVideoFile } from './video_analysis_service.ts';
import { CloudAssetKind, Project, VideoMetadata } from '../../src/types/studio.ts';
import { SUPABASE_FREE_LIMITS } from '../../src/lib/supabaseFreeLimits.ts';

const MEDIA_BUCKET_DIRS: Record<string, string> = {
  uploads: UPLOADS_DIR,
  logos: LOGOS_DIR,
  backgrounds: BACKGROUNDS_DIR,
  fonts: FONTS_DIR,
  audio: AUDIO_DIR,
  masks: MASKS_DIR,
  exports: EXPORTS_DIR,
  thumbs: THUMBS_DIR,
};

export interface LocalProjectAssetInfo {
  localUrl: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exists: boolean;
  exceedsFree50MbCap: boolean;
  necessaryForCloudSync: boolean;
}

function guessMimeFromExt(filename: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return map[ext] || fallback;
}

export function resolveMediaFilePathFromUrl(
  url: string | null | undefined
): { filePath: string; bucket: string; filename: string; mimeType: string } | null {
  if (!url || typeof url !== 'string') return null;

  const assetRow = getAssetByUrl(url);
  if (assetRow && fs.existsSync(assetRow.file_path)) {
    const cleanPath = url.split('?')[0];
    const m = cleanPath.match(/^\/media\/([^/]+)\/([^/]+)$/);
    return {
      filePath: assetRow.file_path,
      bucket: m ? m[1] : 'uploads',
      filename: assetRow.filename || path.basename(assetRow.file_path),
      mimeType: assetRow.mime_type || guessMimeFromExt(assetRow.filename),
    };
  }

  const clean = url.split('?')[0];
  const match = clean.match(/^\/media\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, bucket, rawFilename] = match;
  const dir = MEDIA_BUCKET_DIRS[bucket];
  if (!dir) return null;
  const filename = path.basename(rawFilename);
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return null;
  return {
    filePath,
    bucket,
    filename,
    mimeType: guessMimeFromExt(filename),
  };
}

export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function inspectProjectAssets(project: Project): {
  assets: LocalProjectAssetInfo[];
  totalBytes: number;
  necessaryBytes: number;
  oversizedCount: number;
} {
  const candidates: Array<{ url: string; kind: CloudAssetKind; necessary: boolean }> = [];

  // 1. Original uploaded video
  if (project.sourceVideoUrl) {
    candidates.push({ url: project.sourceVideoUrl, kind: 'video', necessary: true });
  }

  // 2. Final rendered MP4 video
  if (project.lastExportUrl) {
    candidates.push({ url: project.lastExportUrl, kind: 'final-export', necessary: true });
  }

  // 3. Cover thumbnail & saved TikTok thumbnails
  if (project.thumbnailUrl) {
    candidates.push({ url: project.thumbnailUrl, kind: 'thumbnail', necessary: true });
  }
  for (const thumb of project.savedThumbnails || []) {
    if (thumb.url) {
      candidates.push({ url: thumb.url, kind: 'thumbnail', necessary: true });
    }
  }

  // 4. Fish Audio / TTS full narration & individual audio segments
  if (project.voice?.fullDubUrl) {
    candidates.push({ url: project.voice.fullDubUrl, kind: 'voice', necessary: true });
  }
  for (const clip of project.voice?.generatedClips || []) {
    if (clip.audioUrl) {
      candidates.push({ url: clip.audioUrl, kind: 'voice-segment', necessary: true });
    }
  }

  // 5. Background music & sound effects (include even if temporarily toggled off so cross-device editing keeps them)
  if (project.voice?.bgMusicUrl) {
    candidates.push({ url: project.voice.bgMusicUrl, kind: 'music', necessary: true });
  }
  if (project.voice?.sfxUrl) {
    candidates.push({ url: project.voice.sfxUrl, kind: 'sfx', necessary: true });
  }

  // 6. Canvas background image & logos/watermarks
  if (project.canvas?.bgImageUrl) {
    candidates.push({ url: project.canvas.bgImageUrl, kind: 'background', necessary: true });
  }
  for (const logo of project.logos || []) {
    if (logo.url) {
      candidates.push({ url: logo.url, kind: 'logo', necessary: true });
    }
  }

  // 7. Blur / segmentation masks
  for (const blur of project.blurs || []) {
    if (blur.maskAssetId && blur.maskAssetId.startsWith('/media/')) {
      candidates.push({ url: blur.maskAssetId, kind: 'mask', necessary: true });
    }
  }

  // 8. Uploaded custom fonts (explicit customFontUrl + any matching subtitle/element font family)
  const customFonts = listCustomFonts();
  const usedFamilies = new Set<string>();
  if (project.subtitleStyle?.fontFamily) {
    usedFamilies.add(project.subtitleStyle.fontFamily.toLowerCase());
  }
  if (project.subtitleStyle?.customFontUrl) {
    candidates.push({ url: project.subtitleStyle.customFontUrl, kind: 'font', necessary: true });
  }
  for (const el of project.subtitleStyle?.extraElements || []) {
    if (el.style?.fontFamily) usedFamilies.add(el.style.fontFamily.toLowerCase());
  }
  for (const cf of customFonts) {
    if (usedFamilies.has(cf.family.toLowerCase())) {
      candidates.push({ url: cf.url, kind: 'font', necessary: true });
    }
  }

  // 9. Any other project-related assets registered in SQLite assets table (generated thumbnails, masks, audio, etc.)
  const assetKindMap: Record<string, CloudAssetKind> = {
    video: 'video',
    export: 'final-export',
    thumb: 'thumbnail',
    thumbnail: 'thumbnail',
    audio: 'voice-segment',
    voice: 'voice',
    music: 'music',
    sfx: 'sfx',
    logo: 'logo',
    background: 'background',
    font: 'font',
    mask: 'mask',
  };
  for (const row of listAssetsByProject(project.id)) {
    if (!row.url || !fs.existsSync(row.file_path)) continue;
    if (row.file_path.includes(`${path.sep}temp${path.sep}`)) continue;
    const mappedKind = assetKindMap[row.kind] || 'other';
    candidates.push({ url: row.url, kind: mappedKind, necessary: true });
  }

  const seenUrls = new Set<string>();
  const assets: LocalProjectAssetInfo[] = [];

  for (const item of candidates) {
    const cleanUrl = item.url.split('?')[0];
    if (!cleanUrl || seenUrls.has(cleanUrl)) continue;
    seenUrls.add(cleanUrl);

    const resolved = resolveMediaFilePathFromUrl(cleanUrl);
    if (!resolved) {
      assets.push({
        localUrl: cleanUrl,
        bucket: 'uploads',
        filename: path.basename(cleanUrl),
        assetKind: item.kind,
        mimeType: guessMimeFromExt(cleanUrl),
        sizeBytes: 0,
        sha256: '',
        exists: false,
        exceedsFree50MbCap: false,
        necessaryForCloudSync: item.necessary,
      });
      continue;
    }

    const stat = fs.statSync(resolved.filePath);
    const sha256 = computeFileSha256(resolved.filePath);
    assets.push({
      localUrl: cleanUrl,
      bucket: resolved.bucket,
      filename: resolved.filename,
      assetKind: item.kind,
      mimeType: resolved.mimeType,
      sizeBytes: stat.size,
      sha256,
      exists: true,
      exceedsFree50MbCap: stat.size > SUPABASE_FREE_LIMITS.maxSingleFileBytes,
      necessaryForCloudSync: item.necessary,
    });
  }

  const totalBytes = assets.reduce((acc, a) => acc + a.sizeBytes, 0);
  const necessaryBytes = assets
    .filter((a) => a.necessaryForCloudSync)
    .reduce((acc, a) => acc + a.sizeBytes, 0);
  const oversizedCount = assets.filter((a) => a.exceedsFree50MbCap).length;

  return { assets, totalBytes, necessaryBytes, oversizedCount };
}

export type CompressionPreset = 'under-45mb' | '720p-compact' | '480p-compact';

export async function compressProjectVideoForFreeCloud(params: {
  project: Project;
  preset: CompressionPreset;
  target?: 'source' | 'final-export';
}): Promise<{
  compressedUrl: string;
  filename: string;
  originalSourceUrl: string;
  originalBytes: number;
  compressedBytes: number;
  metadata: VideoMetadata;
  target: 'source' | 'final-export';
}> {
  const { project, preset, target = 'source' } = params;
  const sourceUrl = target === 'final-export' ? project.lastExportUrl : project.sourceVideoUrl;
  if (!sourceUrl) {
    throw new Error(
      target === 'final-export'
        ? 'Project does not have a rendered final MP4 to compress.'
        : 'Project does not have a source video to compress.'
    );
  }

  const resolved = resolveMediaFilePathFromUrl(sourceUrl);
  if (!resolved || !fs.existsSync(resolved.filePath)) {
    throw new Error('Video file was not found on local storage.');
  }

  const origStat = fs.statSync(resolved.filePath);
  const durSec = Math.max(1, project.metadata?.duration || 30);

  const safeBase = path
    .basename(resolved.filename, path.extname(resolved.filename))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 40);
  const outFilename = `compact_${uuidv4().slice(0, 8)}_${safeBase}.mp4`;
  const targetDir = target === 'final-export' ? EXPORTS_DIR : UPLOADS_DIR;
  const targetBucket = target === 'final-export' ? 'exports' : 'uploads';
  const outPath = path.join(targetDir, outFilename);

  const args: string[] = ['-y', '-i', resolved.filePath];

  if (preset === 'under-45mb') {
    // Target ~42 MB total (safely below Supabase Free 50 MB per-object limit)
    const targetTotalKbps = Math.floor((42 * 1024 * 8) / durSec);
    const audioKbps = durSec > 240 ? 64 : 96;
    const videoKbps = Math.max(140, Math.min(2800, targetTotalKbps - audioKbps));
    const maxScaleH = durSec > 180 ? 480 : 720;
    args.push(
      '-vf',
      `scale=-2:'min(${maxScaleH},ih)'`,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-b:v',
      `${videoKbps}k`,
      '-maxrate',
      `${Math.round(videoKbps * 1.25)}k`,
      '-bufsize',
      `${Math.round(videoKbps * 2)}k`,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      `${audioKbps}k`,
      '-movflags',
      '+faststart',
      outPath
    );
  } else if (preset === '720p-compact') {
    args.push(
      '-vf',
      `scale=-2:'min(720,ih)'`,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '27',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '112k',
      '-movflags',
      '+faststart',
      outPath
    );
  } else {
    args.push(
      '-vf',
      `scale=-2:'min(480,ih)'`,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '29',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      outPath
    );
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg compression failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });

  const outStat = fs.statSync(outPath);
  const metadata = await analyzeVideoFile(outPath);
  const compressedUrl = `/media/${targetBucket}/${outFilename}`;

  registerAsset({
    id: uuidv4(),
    projectId: project.id,
    kind: target === 'final-export' ? 'export' : 'video',
    filename: outFilename,
    filePath: outPath,
    url: compressedUrl,
    mimeType: 'video/mp4',
    sizeBytes: outStat.size,
  });

  return {
    compressedUrl,
    filename: outFilename,
    originalSourceUrl: sourceUrl,
    originalBytes: origStat.size,
    compressedBytes: outStat.size,
    metadata,
    target,
  };
}

export function hydrateAssetToLocalBucket(params: {
  projectId: string;
  targetLocalUrl?: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  mimeType: string;
  buffer: Buffer;
  fontFamily?: string;
}): { localUrl: string; filePath: string; sizeBytes: number } {
  const safeBucket = MEDIA_BUCKET_DIRS[params.bucket] ? params.bucket : 'uploads';
  const dir = MEDIA_BUCKET_DIRS[safeBucket];
  fs.mkdirSync(dir, { recursive: true });

  // Preserve exact original filename if targetLocalUrl uses /media/<bucket>/<name> so all project URL references resolve seamlessly across devices!
  let targetFilename = path.basename(params.filename || `asset_${uuidv4().slice(0, 8)}`);
  if (params.targetLocalUrl) {
    const m = params.targetLocalUrl.split('?')[0].match(/^\/media\/([^/]+)\/([^/]+)$/);
    if (m && m[2]) {
      targetFilename = path.basename(m[2]);
    }
  }
  targetFilename = targetFilename.replace(/[^a-zA-Z0-9._-]/g, '_');

  const filePath = path.join(dir, targetFilename);
  fs.writeFileSync(filePath, params.buffer);
  const localUrl = `/media/${safeBucket}/${targetFilename}`;

  const kindMap: Record<CloudAssetKind, string> = {
    video: 'video',
    'final-export': 'export',
    logo: 'logo',
    background: 'background',
    voice: 'audio',
    'voice-segment': 'audio',
    music: 'music',
    sfx: 'audio',
    font: 'font',
    thumbnail: 'thumb',
    mask: 'mask',
    other: 'other',
  };

  registerAsset({
    id: uuidv4(),
    projectId: params.projectId,
    kind: kindMap[params.assetKind] || 'video',
    filename: targetFilename,
    filePath,
    url: localUrl,
    mimeType: params.mimeType || guessMimeFromExt(targetFilename),
    sizeBytes: params.buffer.length,
  });

  if (safeBucket === 'fonts') {
    const existingFont = listCustomFonts().find(
      (f) => f.url === localUrl || f.filename === targetFilename
    );
    if (!existingFont) {
      const fam =
        params.fontFamily ||
        path.basename(targetFilename, path.extname(targetFilename)).replace(/[_-]+/g, ' ');
      registerCustomFont({
        id: uuidv4(),
        family: fam,
        filename: targetFilename,
        filePath,
        url: localUrl,
      });
    }
  }

  return {
    localUrl,
    filePath,
    sizeBytes: params.buffer.length,
  };
}

function getDirBytes(dirPath: string): { bytes: number; files: number } {
  if (!fs.existsSync(dirPath)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      bytes += fs.statSync(full).size;
      files += 1;
    } else if (entry.isDirectory()) {
      const sub = getDirBytes(full);
      bytes += sub.bytes;
      files += sub.files;
    }
  }
  return { bytes, files };
}

export function computeLocalStorageUsage(): {
  totalBytes: number;
  buckets: Record<string, { bytes: number; files: number }>;
} {
  const dirs: Record<string, string> = {
    uploads: UPLOADS_DIR,
    audio: AUDIO_DIR,
    logos: LOGOS_DIR,
    backgrounds: BACKGROUNDS_DIR,
    fonts: FONTS_DIR,
    thumbs: THUMBS_DIR,
    exports: EXPORTS_DIR,
    temp: TEMP_DIR,
  };
  const buckets: Record<string, { bytes: number; files: number }> = {};
  let totalBytes = 0;
  for (const [k, dir] of Object.entries(dirs)) {
    const stats = getDirBytes(dir);
    buckets[k] = stats;
    totalBytes += stats.bytes;
  }
  const dbPath = path.join(STORAGE_DIR, 'recap_studio.db');
  if (fs.existsSync(dbPath)) {
    const dbBytes = fs.statSync(dbPath).size;
    buckets.database = { bytes: dbBytes, files: 1 };
    totalBytes += dbBytes;
  }
  return { totalBytes, buckets };
}
