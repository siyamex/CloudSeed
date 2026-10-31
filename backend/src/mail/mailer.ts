import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail { to: string; subject: string; text: string }

export interface Mailer {
  /** False when no SMTP server is configured: email is then simply not offered. */
  readonly configured: boolean;
  send(m: Mail): Promise<void>;
  /** Connects and authenticates, to verify the settings. */
  verify(): Promise<void>;
  close(): void;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function createMailer(c: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_REQUIRE_TLS' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM'>): Mailer {
  if (!c.SMTP_HOST) {
    const off = () => Promise.reject(new Error('SMTP is not configured'));
    return { configured: false, send: off, verify: off, close() {} };
  }
  const transport: Transporter = nodemailer.createTransport({
    host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE,
    // Credentials must not cross the network in clear text unless the operator explicitly allowed it.
    requireTLS: c.SMTP_REQUIRE_TLS && !c.SMTP_SECURE,
    auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASS } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    pool: false,
  });
  return {
    configured: true,
    async send(m) {
      await transport.sendMail({ from: c.SMTP_FROM, to: m.to, subject: oneLine(m.subject).slice(0, 200), text: m.text });
    },
    async verify() { await transport.verify(); },
    close() { transport.close(); },
  };
}
