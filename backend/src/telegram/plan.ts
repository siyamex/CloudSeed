import path from 'node:path';

/** `link` = a text message with a CloudSeed download link instead of the file itself (for files over Telegram's limit). */
export type SendAs = 'document' | 'photo' | 'video' | 'audio' | 'link';

export interface Limits { upload: number; photo: number; part: number; mode: 'hosted' | 'self-hosted' }

export interface SourceFile { id: string; name: string; size: number; mime: string }

export interface PlannedItem {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  offset: number;
  partIndex: number | null;
  partCount: number | null;
  sendAs: SendAs;
  /** Items with the same key are sent together as one album (sendMediaGroup). */
  albumKey: string | null;
}

export interface Alternative { kind: 'split' | 'share_link'; available: boolean; detail: string }

export interface PlanIssue {
  fileId: string;
  name: string;
  code: 'file_too_large' | 'empty_file' | 'too_many_parts';
  message: string;
  alternatives: Alternative[];
}

export interface PlanOptions {
  method: 'auto' | 'document'; album: boolean; split: boolean;
  /** Send a download link for files over the limit (only offered when sharing is enabled). */
  link?: boolean; sharingEnabled?: boolean;
  limits: Limits; newKey?: () => string;
}

export const MAX_ALBUM = 10; // sendMediaGroup: 2-10 items
export const MAX_PARTS = 200;
export const MAX_CAPTION = 1024;
export const MAX_FILES_PER_TRANSFER = 100;

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png']);

/** How a file is best presented in Telegram. Anything uncertain is sent as a document, which never alters the file. */
export function chooseSendAs(file: { name: string; mime: string; size: number }, method: 'auto' | 'document', limits: Limits): SendAs {
  if (method === 'document') return 'document';
  const ext = path.extname(file.name).toLowerCase();
  if (PHOTO_MIMES.has(file.mime) && file.size <= limits.photo) return 'photo';
  if (file.mime === 'video/mp4') return 'video';
  // sendAudio only accepts .MP3 or .M4A
  if ((file.mime === 'audio/mpeg' && ext === '.mp3') || (file.mime === 'audio/mp4' && ext === '.m4a')) return 'audio';
  return 'document';
}

/** What an album may contain together: photos+videos mix; audio only with audio; documents only with documents. */
const albumClass = (s: SendAs, i = 0) => (s === 'link' ? `link-${i}` : s === 'photo' || s === 'video' ? 'visual' : s);

export const partName = (name: string, index: number) => `${name}.${String(index + 1).padStart(3, '0')}`;

export function planTransfer(files: SourceFile[], o: PlanOptions): { items: PlannedItem[]; issues: PlanIssue[] } {
  const items: PlannedItem[] = [];
  const issues: PlanIssue[] = [];
  const { limits } = o;

  for (const f of files) {
    if (f.size === 0) {
      issues.push({ fileId: f.id, name: f.name, code: 'empty_file', message: 'Telegram does not accept empty files', alternatives: [] });
      continue;
    }
    if (f.size <= limits.upload) {
      items.push({ fileId: f.id, name: f.name, size: f.size, mime: f.mime, offset: 0, partIndex: null, partCount: null, sendAs: chooseSendAs(f, o.method, limits), albumKey: null });
      continue;
    }
    const parts = Math.ceil(f.size / limits.part);
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
    const alternatives: Alternative[] = [
      { kind: 'split', available: parts <= MAX_PARTS, detail: `Send as ${parts} numbered parts of up to ${mb(limits.part)} (${partName(f.name, 0)}, ...). Join them with \`cat\` or \`copy /b\`.` },
      { kind: 'share_link', available: !!o.sharingEnabled, detail: o.sharingEnabled ? 'Send a message with an expiring download link. The file stays on CloudSeed, not on Telegram, and anyone with the link can download it.' : 'Sharing links are turned off on this server.' },
    ];
    if (o.link && !o.split) {
      if (!o.sharingEnabled) {
        issues.push({ fileId: f.id, name: f.name, code: 'file_too_large', alternatives, message: 'Sharing links are turned off on this server, so a link cannot be sent instead' });
      } else {
        items.push({ fileId: f.id, name: f.name, size: f.size, mime: f.mime, offset: 0, partIndex: null, partCount: null, sendAs: 'link', albumKey: null });
      }
      continue;
    }
    if (!o.split) {
      issues.push({
        fileId: f.id, name: f.name, code: 'file_too_large', alternatives,
        message: `${f.name} is ${mb(f.size)}, which is over the ${mb(limits.upload)} limit of ${limits.mode === 'hosted' ? 'the official Telegram Bot API' : 'your Bot API server'}`,
      });
      continue;
    }
    if (parts > MAX_PARTS) {
      issues.push({ fileId: f.id, name: f.name, code: 'too_many_parts', alternatives: [], message: `${f.name} would need ${parts} parts; the maximum is ${MAX_PARTS}` });
      continue;
    }
    for (let i = 0; i < parts; i++) {
      const offset = i * limits.part;
      items.push({
        fileId: f.id, name: partName(f.name, i), size: Math.min(limits.part, f.size - offset), mime: 'application/octet-stream',
        offset, partIndex: i + 1, partCount: parts, sendAs: 'document', albumKey: null,
      });
    }
  }

  if (o.album && issues.length === 0) {
    const key = o.newKey ?? (() => crypto.randomUUID());
    let i = 0;
    while (i < items.length) {
      const cls = albumClass(items[i]!.sendAs, i);
      let j = i + 1;
      while (j < items.length && j - i < MAX_ALBUM && albumClass(items[j]!.sendAs, j) === cls) j++;
      if (j - i >= 2) { const k = key(); for (let x = i; x < j; x++) items[x]!.albumKey = k; }
      i = j;
    }
  }
  return { items, issues };
}

export function validateCaption(caption: string | null | undefined): string | null {
  if (!caption) return null;
  if (caption.length > MAX_CAPTION) throw new Error(`Caption is ${caption.length} characters; Telegram allows ${MAX_CAPTION}`);
  return caption;
}

/** Public message link, or a members-only link for private supergroups/channels; none for basic groups. */
export function messageLink(d: { chatId: number; username: string | null; type: string }, messageId: number | null): { url: string; membersOnly: boolean } | null {
  if (!messageId) return null;
  if (d.username) return { url: `https://t.me/${d.username}/${messageId}`, membersOnly: false };
  if ((d.type === 'supergroup' || d.type === 'channel') && d.chatId < -1_000_000_000_000) {
    return { url: `https://t.me/c/${-d.chatId - 1_000_000_000_000}/${messageId}`, membersOnly: true };
  }
  return null;
}

/** The message sent instead of a file that is over Telegram's limit. Says plainly that the file is hosted by CloudSeed. */
export function linkMessage(o: { name: string; size: number; url: string; expiresAt: Date; maxDownloads: number | null; passwordProtected: boolean; intro?: string | null }): string {
  const size = o.size >= 1024 ** 3 ? `${(o.size / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(o.size / 1024 ** 2))} MB`;
  const when = o.expiresAt.toISOString().slice(0, 16).replace('T', ' ');
  return [
    o.intro ? `${o.intro}\n` : '',
    `"${o.name}" (${size}) is too large to upload to Telegram.`,
    `Download it from CloudSeed (the file is hosted there, not on Telegram): ${o.url}`,
    `This link expires on ${when} UTC${o.maxDownloads ? ` and allows ${o.maxDownloads} download${o.maxDownloads === 1 ? '' : 's'}` : ''}.${o.passwordProtected ? ' It is password protected; ask the sender for the password.' : ''}`,
  ].filter((l) => l !== '').join('\n').slice(0, 4096);
}
