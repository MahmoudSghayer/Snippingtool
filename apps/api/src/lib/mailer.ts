// Mailer: real SMTP in production, an in-memory JSON transport in
// dev/test so integration tests can assert on what was "sent" without a
// real mail server. `sentEmails` is a ring buffer (capped at 200) every
// `send()` call appends to, regardless of transport, so tests can always
// read `mailer.sentEmails` even against a configured SMTP host in a
// non-production environment.

import nodemailer, { type Transporter } from 'nodemailer';

import type { Env } from '../config/env.js';

export interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  sentAt: Date;
}

export interface Mailer {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>;
  sentEmails: SentEmail[];
}

const MAX_BUFFERED = 200;

export function createMailer(env: Env): Mailer {
  const sentEmails: SentEmail[] = [];

  const transport: Transporter =
    env.NODE_ENV === 'production' && env.SMTP_HOST
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          auth:
            env.SMTP_USER && env.SMTP_PASS
              ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
              : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });

  return {
    sentEmails,
    async send(message) {
      await transport.sendMail({ from: env.EMAIL_FROM, ...message });
      sentEmails.push({ ...message, sentAt: new Date() });
      if (sentEmails.length > MAX_BUFFERED) sentEmails.shift();
    },
  };
}
