import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  LOG_LEVEL: z.string().default('info'),
  /** Max connections per process (API and worker each hold their own pool). Keep (API + worker) * this below Postgres max_connections. */
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DATABASE_URL: z.string().default('postgres://cloudseed:cloudseed@localhost:5432/cloudseed'),
  MIGRATIONS_DIR: z.string().default('../migrations'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),
  /** Comma-separated emails that become admin on first verified login. */
  ADMIN_EMAILS: z.string().default(''),
  REGISTRATION_POLICY: z.enum(['open', 'closed']).default('open'),

  /** General API budget per client IP per minute. Raise it behind a shared proxy/NAT with many users. */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
  /** Master switch for share links. */
  SHARING_ENABLED: bool.default(true),
  /** Longest a link may live. Every link expires. */
  SHARING_MAX_DAYS: z.coerce.number().int().positive().default(365),
  SHARING_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().default(100),
  /** Password attempts per minute per link and client address. */
  /** Largest number of files in one "download folder as ZIP". */
  SHARING_ZIP_MAX_FILES: z.coerce.number().int().min(1).max(65_000).default(10_000),
  SHARE_UNLOCK_RATE_PER_MIN: z.coerce.number().int().positive().default(10),
  /** Optional email notifications. Leave SMTP_HOST empty to turn email off. */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** true = implicit TLS (usually port 465). false = STARTTLS. */
  SMTP_SECURE: bool.default(false),
  /** Refuse to send (and to send credentials) over a connection that is not encrypted. */
  SMTP_REQUIRE_TLS: bool.default(true),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('CloudSeed <noreply@localhost>'),
  /** Upper bound of notification emails per user per hour. */
  EMAIL_MAX_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** Upper bound of notifications sent to Telegram per user per hour. */
  TELEGRAM_NOTIFY_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** In-app and email warning once a user has used this percentage of their quota. */
  QUOTA_WARNING_PERCENT: z.coerce.number().int().min(1).max(100).default(90),
  /** Bearer token for GET /metrics. Leave empty to disable the endpoint. */
  METRICS_TOKEN: z.string().default('').refine((v) => v === '' || v.length >= 16, 'METRICS_TOKEN must be at least 16 characters'),
  /** Make an encrypted backup every N hours (0 = no schedule; an administrator can still start one by hand). Needs a passphrase. */
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).max(24 * 90).default(0),
  /** Where the worker writes backups. Mount a volume here, and copy the files off the machine. */
  BACKUP_DIR: z.string().default('./data/backups'),
  /** How many finished, verified backups to keep. Older ones are deleted. */
  BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(7),
  BACKUP_INCLUDE_OBJECTS: bool.default(true),
  /** 12+ characters. Prefer BACKUP_PASSPHRASE_FILE (a mounted secret) so it does not sit in the environment. */
  BACKUP_PASSPHRASE: z.string().default(''),
  BACKUP_PASSPHRASE_FILE: z.string().default(''),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  SESSION_SECRET: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  COOKIE_SECURE: bool.optional(),

  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(false),
  S3_KEY_PREFIX: z.string().default(''),
  /** 0 disables automatic purging (trash is kept until emptied manually). */
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  DOWNLOAD_WORKDIR: z.string().default('./data/downloads'),
  /** Max jobs running across all workers / per user / in this worker process. */
  DOWNLOAD_GLOBAL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  DOWNLOAD_USER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  /** Per-job bandwidth cap in bytes/second; 0 = unlimited. */
  DOWNLOAD_BANDWIDTH_LIMIT_BPS: z.coerce.number().int().min(0).default(0),
  DOWNLOAD_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  DOWNLOAD_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(5_000),
  DOWNLOAD_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(600_000),
  /** Comma-separated CIDRs/IPs exempted from the private-network block (e.g. an internal mirror). Empty by default. */
  DOWNLOAD_ALLOWED_CIDRS: z.string().default(''),
  DOWNLOAD_ALLOWED_PORTS: z.string().default('80,443'),
  DOWNLOAD_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DOWNLOAD_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DOWNLOAD_MAX_REDIRECTS: z.coerce.number().int().min(0).default(5),
  DOWNLOAD_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  DOWNLOAD_MAX_ACTIVE_PER_USER: z.coerce.number().int().positive().default(100),
  DOWNLOAD_JOB_RETENTION_DAYS: z.coerce.number().int().min(0).default(14),
  DOWNLOAD_TMP_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  /** Base64 of 32 random bytes (openssl rand -base64 32). Encrypts stored credentials such as Telegram bot tokens. Required in production.
   *  Changing it makes previously stored tokens unreadable, so back it up with the database. */
  ENCRYPTION_KEY: z.string().default(''),
  TELEGRAM_ENABLED: bool.default(true),
  /** hosted = official api.telegram.org (50 MB uploads). self-hosted = your own telegram-bot-api server (up to 2000 MB). */
  TELEGRAM_API_MODE: z.enum(['hosted', 'self-hosted']).default('hosted'),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  /** Override the per-file upload limit in bytes. Leave unset to use the documented limit for TELEGRAM_API_MODE. */
  TELEGRAM_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().optional(),
  TELEGRAM_PHOTO_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** Bytes per part when the user chooses to split an oversized file. */
  TELEGRAM_SPLIT_PART_BYTES: z.coerce.number().int().positive().optional(),
  /** Minimum gap between sends into the same chat (Telegram allows ~20 messages/minute per group). */
  TELEGRAM_CHAT_INTERVAL_MS: z.coerce.number().int().min(0).default(3000),
  TELEGRAM_CONCURRENCY: z.coerce.number().int().positive().default(2),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  TELEGRAM_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(5_000),
  TELEGRAM_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  TELEGRAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** No upload progress for this long aborts the attempt (only while the request body is being written). */
  TELEGRAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** How long to wait for Telegram's answer after the whole file has been sent. */
  TELEGRAM_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  TELEGRAM_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /** FFmpeg/ffprobe binaries (the Docker image installs FFmpeg; on a dev machine they must be on PATH or set here). */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  MEDIA_ENABLED: bool.default(true),
  MEDIA_WORKDIR: z.string().default('./data/media'),
  /** Media files are probed and thumbnailed by the worker, this many at a time. */
  MEDIA_CONCURRENCY: z.coerce.number().int().positive().default(1),
  MEDIA_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  MEDIA_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MEDIA_THUMBNAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Make a grid of small frames for the seek-bar preview of longer videos. */
  MEDIA_SPRITES_ENABLED: bool.default(true),
  MEDIA_SPRITE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MEDIA_THUMBNAIL_WIDTH: z.coerce.number().int().min(16).max(1280).default(320),
  MEDIA_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  /** Transcoding is CPU-heavy, so it is off by default. */
  MEDIA_TRANSCODING_ENABLED: bool.default(false),
  MEDIA_TRANSCODE_CONCURRENCY: z.coerce.number().int().positive().default(1),
  MEDIA_TRANSCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(4 * 3_600_000),
  MEDIA_TRANSCODE_MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(8 * 1024 ** 3),
  LOCAL_STORAGE_ROOT: z.string().default('./data/storage'),
  LOCAL_TMP_DIR: z.string().default('./data/tmp'),
  DEFAULT_USER_QUOTA_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3),
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean; adminEmails: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const cookieSecure = c.COOKIE_SECURE ?? c.NODE_ENV === 'production';

  if (c.STORAGE_BACKEND === 's3' && (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
    throw new Error('Invalid configuration: STORAGE_BACKEND=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }

  if (c.BACKUP_INTERVAL_HOURS > 0 && !c.BACKUP_PASSPHRASE && !c.BACKUP_PASSPHRASE_FILE) {
    throw new Error('Invalid configuration: BACKUP_INTERVAL_HOURS needs BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE');
  }
  if (c.BACKUP_PASSPHRASE && c.BACKUP_PASSPHRASE.length < 12) throw new Error('Invalid configuration: BACKUP_PASSPHRASE must be at least 12 characters');

  if (c.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (c.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
    if (!c.GOOGLE_REDIRECT_URI) problems.push('GOOGLE_REDIRECT_URI is required');
    if (!c.PUBLIC_URL.startsWith('https://')) problems.push('PUBLIC_URL must use https in production');
    if (!cookieSecure) problems.push('COOKIE_SECURE must not be false in production');
    if (!c.ENCRYPTION_KEY || Buffer.from(c.ENCRYPTION_KEY, 'base64').length !== 32) problems.push('ENCRYPTION_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)');
    if (c.TELEGRAM_ENABLED && c.TELEGRAM_API_MODE === 'hosted' && !c.TELEGRAM_API_BASE.startsWith('https://')) problems.push('TELEGRAM_API_BASE must use https for the hosted Bot API');
    if (/cloudseed:cloudseed@/.test(c.DATABASE_URL)) problems.push('DATABASE_URL uses the default development credentials');
    if (problems.length) throw new Error(`Insecure production configuration: ${problems.join('; ')}`);
  }

  return {
    ...c,
    cookieSecure,
    adminEmails: c.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}


/** Upload limits for the configured Bot API deployment (hosted: 50 MB; self-hosted server: 2000 MB). */
export function telegramLimits(c: Pick<Config, 'TELEGRAM_API_MODE' | 'TELEGRAM_MAX_UPLOAD_BYTES' | 'TELEGRAM_PHOTO_MAX_BYTES' | 'TELEGRAM_SPLIT_PART_BYTES'>) {
  const MiB = 1024 * 1024;
  const upload = c.TELEGRAM_MAX_UPLOAD_BYTES ?? (c.TELEGRAM_API_MODE === 'self-hosted' ? 2000 * MiB : 50 * MiB);
  // Parts stay comfortably under the limit so a decimal-vs-binary "MB" ambiguity can never reject one.
  const part = Math.min(c.TELEGRAM_SPLIT_PART_BYTES ?? Math.floor(upload * 0.9), upload);
  return { upload, photo: Math.min(c.TELEGRAM_PHOTO_MAX_BYTES, upload), part, mode: c.TELEGRAM_API_MODE };
}
