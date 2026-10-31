/** Every kind of notification the app creates, with the wording shown in settings. */
export const NOTIFICATION_KINDS: Record<string, string> = {
  download_started: 'A download started',
  download_completed: 'A download finished',
  download_failed: 'A download failed',
  quota_warning: 'Storage is almost full',
  telegram_transfer_completed: 'A Telegram transfer finished',
  telegram_transfer_failed: 'A Telegram transfer failed',
  share_expiring: 'A share link expires soon',
  share_disabled: 'A share link was disabled by an administrator',
  torrent_ready: 'A torrent is ready for you to choose files',
  torrent_completed: 'A torrent finished downloading',
  torrent_failed: 'A torrent failed',
  backup_failed: 'A scheduled backup failed (administrators)',
  backup_warning: 'A backup finished with warnings (administrators)',
  integration_disconnected: 'The Telegram bot was disconnected',
};

export const isKnownKind = (k: string) => Object.prototype.hasOwnProperty.call(NOTIFICATION_KINDS, k);
