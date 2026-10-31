export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.requestId);
  }
  return body as T;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(`/api/v1${path}`, {
    method, headers, credentials: 'same-origin', keepalive: init.keepalive, body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return parse<T>(res);
}

/** Uploads with real byte-level progress (fetch cannot report upload progress). */
export function uploadFile(
  file: File, folderId: string | null, onConflict: 'reject' | 'rename' | 'replace',
  onProgress: (loaded: number, total: number) => void,
): { promise: Promise<FileItem>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileItem>((resolve, reject) => {
    xhr.open('POST', `/api/v1/files/upload?folder=${folderId ?? 'root'}&onConflict=${onConflict}`);
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body?.error?.code ?? 'error', body?.error?.message ?? 'Upload failed', body?.error?.requestId));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export interface Me { user: { id: string; email: string; roles: string[]; displayName: string | null; avatarUrl: string | null; theme: string; hasPassword: boolean }; csrfToken: string; insecure?: boolean }
export interface AuthConfig {
  googleConfigured: boolean; registrationPolicy: string; devLogin?: boolean; needsSetup: boolean; setupCodeRequired: boolean; localLogin: boolean; secureContext: boolean; minPasswordLength: number;
}
export interface AdminAuth {
  publicUrl: { value: string | null; inUse: string; secure: boolean; fromEnvironment: boolean };
  google: { enabled: boolean; source: 'database' | 'environment' | 'none'; clientId: string; secretSet: boolean; redirectUri: string };
  local: { accounts: number };
}
export interface FileItem { id: string; folderId: string | null; name: string; size: number; mimeType: string; createdAt: string; updatedAt: string; sharingDisabled?: boolean }
export interface FolderItem { id: string; parentId: string | null; name: string; createdAt: string }
export interface Listing { folderId: string | null; breadcrumbs: { id: string; name: string }[]; folders: FolderItem[]; files: FileItem[]; nextCursor: string | null }
export interface Dashboard {
  storage: { backend: string; quotaBytes: number; usedBytes: number; availableBytes: number; healthy: boolean; trashBytes: number; trashFiles: number };
  downloads: { active: number; waiting: number; paused: number; completed: number; failed: number };
  telegram: { bots: number; active: number; failed: number; recent: { id: string; state: string; destination: string; files: number; firstFileName: string | null; createdAt: string }[] };
  counts: { files: number; folders: number };
  usageByType: { category: string; bytes: number; files: number }[];
  recentFiles: (Omit<FileItem, 'folderId' | 'updatedAt'> & { folderId: string | null })[];
  unreadNotifications: number;
}

export type JobState = 'pending' | 'queued' | 'resolving' | 'downloading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export interface DownloadJob {
  id: string; url: string; state: JobState; priority: 'low' | 'normal' | 'high'; filename: string | null; folderId: string | null;
  bytesReceived: number; totalBytes: number | null; percent: number | null; speedBps: number; elapsedSeconds: number | null; etaSeconds: number | null;
  attempt: number; maxAttempts: number; nextAttemptAt: string | null; error: { code: string; message: string | null } | null;
  fileId: string | null; resumable: boolean | null; pendingControl: 'pause' | 'cancel' | null; createdAt: string; updatedAt: string;
}
export interface Preview {
  finalUrl: string; filename: string; size: number | null; contentType: string | null; acceptsRanges: boolean; resumable: boolean;
  warnings: { code: string; message: string }[];
}

export interface TgStatus { sharing: { enabled: boolean; maxDays: number }; enabled: boolean; mode: 'hosted' | 'self-hosted'; limits: { uploadBytes: number; photoBytes: number; partBytes: number; captionChars: number; maxFiles: number } }
export interface TgBot { id: string; username: string; name: string | null; status: 'active' | 'invalid' | 'disconnected'; lastCheckedAt: string | null; createdAt: string }
export interface TgDestination {
  id: string; botId: string; botUsername: string | null; botStatus: string | null; chatId: number; username: string | null; title: string;
  type: 'group' | 'supergroup' | 'channel'; canSend: boolean; problem: string | null; isDefault: boolean; checkedAt: string | null;
}
export type TgState = 'queued' | 'uploading' | 'sent' | 'partial' | 'failed' | 'cancelled';
export interface TgFile {
  id: string; position: number; name: string; size: number; sendAs: string; state: 'queued' | 'uploading' | 'sent' | 'failed' | 'cancelled';
  bytesSent: number; percent: number | null; messageId: number | null; link: { url: string; membersOnly: boolean } | null; ambiguous: boolean;
  error: { code: string; message: string | null } | null; partIndex: number | null; partCount: number | null; album: boolean; attempt: number; nextAttemptAt: string | null;
}
export interface TgTransfer {
  id: string; state: TgState; caption: string | null; method: string; album: boolean;
  bot: { id: string | null; username: string | null; status: string | null };
  destination: { id: string | null; title: string; type: string; username: string | null };
  counts: { total: number; sent: number; failed: number }; totalBytes: number; firstFileName: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; files?: TgFile[];
}
export interface TgIssue { fileId: string; name: string; code: string; message: string; alternatives: { kind: 'split' | 'share_link'; available: boolean; detail: string }[] }
export interface TgPlan {
  items: { fileId: string; name: string; size: number; sendAs: string; partIndex: number | null; partCount: number | null; album: boolean }[];
  messages: number; totalBytes: number; issues: TgIssue[]; destination: { id: string; title: string; canSend: boolean; problem: string | null };
}

export interface MediaItem {
  id: string; name: string; title: string; kind: 'video' | 'audio'; status: 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported'; error: string | null;
  size: number; folderId: string | null; createdAt: string; durationMs: number | null; width: number | null; height: number | null; container: string | null;
  videoCodec: string | null; audioCodec: string | null; bitrate: number | null; artist: string | null; album: string | null; hasThumbnail: boolean;
  progress: { positionMs: number; durationMs: number | null; completed: boolean; updatedAt: string | null } | null;
}
export interface SpriteInfo { intervalSec: number; cols: number; rows: number; frames: number; tileWidth: number; tileHeight: number }
export interface MediaDetail extends MediaItem {
  sprite: SpriteInfo | null;
  audioTracks: { index: number; codec: string | null; language: string | null; title: string | null; channels: number | null; default: boolean }[];
  subtitles: { id: string; source: 'embedded' | 'file'; label: string; language: string | null; available: boolean; reason?: string; linkId?: string }[];
  playback: { mode: 'direct' | 'maybe' | 'transcode'; reason: string | null };
  renditions: { profile: string; status: 'queued' | 'processing' | 'ready' | 'failed'; progress: number; size: number; error: string | null }[];
  transcoding: { enabled: boolean; profiles: { name: string; description: string }[] };
}

export interface ShareItem {
  id: string; kind: 'file' | 'folder'; folderId: string | null; fileId: string | null; fileName: string; fileSize: number; label: string | null; mode: 'public' | 'private';
  status: 'active' | 'expired' | 'revoked' | 'exhausted' | 'disabled'; expiresAt: string; maxDownloads: number | null; downloadCount: number; accessCount: number;
  passwordProtected: boolean; createdAt: string; lastAccessedAt: string | null; revokedAt: string | null; fileInTrash: boolean;
}
export interface PublicFolderListing {
  folder: string; path: { id: string; name: string }[]; folders: { id: string; name: string }[];
  files: { id: string; name: string; size: number; modifiedAt: string }[]; truncated: boolean;
}
export interface PublicShare { kind: 'file' | 'folder'; name: string; size: number; mode: 'public' | 'private'; passwordRequired: boolean; unlocked: boolean; expiresAt: string; downloadsLeft: number | null }

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–:––';
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}

export interface NotificationItem { id: string; kind: string; title: string; body: string | null; read: boolean; createdAt: string }
export interface AccountSettings {
  theme: 'system' | 'light' | 'dark'; displayName: string | null; defaultDownloadFolderId: string | null;
  downloadConcurrency: number | null; downloadBandwidthBps: number | null; emailNotifications: boolean; telegramNotifyDestinationId: string | null; mutedKinds: string[];
  limits: { downloadConcurrency: number; downloadBandwidthBps: number; emailAvailable: boolean; telegramAvailable: boolean };
}
export interface SessionItem { id: string; current: boolean; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }

export interface TorrentFile { i: number; path: string; size: number; selected: boolean; imported?: boolean }
export interface TorrentItem {
  id: string; source: 'magnet' | 'file'; name: string | null; infoHash: string; state: string; folderId: string | null; resultFolderId: string | null;
  fileCount: number; selectedCount: number; importedFiles: number; totalBytes: number | null; selectedBytes: number | null; bytesDone: number; percent: number | null;
  peers: number; downBps: number; upBps: number; autoStart: boolean; error: { code: string; message: string | null } | null; createdAt: string; updatedAt: string; finishedAt: string | null;
  files?: TorrentFile[];
}
export interface TorrentStatus { enabled: boolean; notice: string; limits: { maxFiles: number; maxActivePerUser: number; maxFileBytes: number; torrentFileMaxBytes: number } }
export interface AdminOverview {
  users: { active: number; disabled: number }; storage: { files: number; usedBytes: number; quotaBytes: number };
  activeShareLinks: number; openAbuseReports: number; workersAlive: number;
  backup: BackupConfig & { lastSuccessAt: string | null; lastVerified: boolean | null; lastFailureAt: string | null };
  features: { email: boolean; torrents: boolean; sharing: boolean; telegram: boolean; media: boolean; metrics: boolean };
}
export interface BackupConfig { enabled: boolean; intervalHours: number; keep: number; directory: string; includeObjects: boolean; passphraseConfigured: boolean }
export interface BackupRun {
  id: string; trigger: 'schedule' | 'manual'; status: 'requested' | 'running' | 'succeeded' | 'failed'; requestedAt: string; startedAt: string | null; finishedAt: string | null;
  fileName: string | null; bytes: number | null; rows: number | null; objects: number | null; missing: number; corrupt: number; verified: boolean; pruned: boolean; error: string | null;
}
export interface AdminUser { id: string; email: string; status: 'active' | 'disabled'; roles: string[]; createdAt: string; lastSeenAt: string | null; quotaBytes: number | null; usedBytes: number | null; files: number }
export interface AdminReport {
  id: string; shareId: string | null; fileName: string | null; reason: string; details: string | null; status: 'open' | 'dismissed' | 'actioned';
  createdAt: string; resolvedAt: string | null; resolutionNote: string | null; ownerEmail: string | null; ownerActionedReports: number; linkDisabled: boolean;
}
export interface AdminQueues {
  downloads: { state: string; count: number; oldestSeconds: number | null; expiredLeases: number }[];
  telegram: { state: string; count: number; oldestSeconds: number | null }[];
  media: { state: string; count: number; oldestSeconds: number | null }[];
  torrents: { state: string; count: number; oldestSeconds: number | null }[];
  recentDownloadFailures: { id: string; code: string | null; at: string }[];
}
export interface AdminWorker { id: string; role: string; startedAt: string; lastSeenAt: string; pid: number | null; host: string | null; info: Record<string, unknown>; alive: boolean }
export interface AuditEntry { id: number; userId: string | null; email: string | null; action: string; target: string | null; ip: string | null; metadata: Record<string, unknown>; at: string }
