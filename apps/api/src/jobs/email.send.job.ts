// Queue-backed mail sending. Most transactional mail in this codebase is
// sent synchronously (register/reset/force-logout — see modules/auth,
// modules/admin-users) since those are already fire-and-forget from the
// caller's point of view and low-volume; this job exists for callers that
// want to decouple sending from the request entirely (e.g. a future bulk
// notification). No `schedule` — only ever triggered by
// `queue.add('email.send', { to, subject, html, text })` from elsewhere.

import { z } from 'zod';

import { defineJob } from './types.js';

const emailJobDataSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
});

export type EmailJobData = z.infer<typeof emailJobDataSchema>;

export default defineJob<EmailJobData>({
  name: 'email.send',
  async processor(job, { mailer, log }) {
    const data = emailJobDataSchema.parse(job.data);
    await mailer.send(data);
    log.info({ to: data.to, subject: data.subject }, 'email.send delivered');
  },
});
