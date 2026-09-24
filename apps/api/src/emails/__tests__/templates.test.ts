// Email links must open the website (DASHBOARD_ORIGIN), where the verify and
// reset pages live, never the API's own address (APP_ORIGIN), which 404s.

import { afterEach, describe, expect, it } from 'vitest';

import {
  resetPasswordHtml,
  resetPasswordText,
  verifyEmailHtml,
  verifyEmailText,
} from '../templates.js';

const saved = { app: process.env.APP_ORIGIN, site: process.env.DASHBOARD_ORIGIN };

describe('email templates', () => {
  afterEach(() => {
    process.env.APP_ORIGIN = saved.app;
    process.env.DASHBOARD_ORIGIN = saved.site;
  });

  it('links to the website, not the API, and says Nova Trade', () => {
    process.env.APP_ORIGIN = 'https://api.example.test';
    process.env.DASHBOARD_ORIGIN = 'https://site.example.test/';

    for (const body of [verifyEmailHtml('tok'), verifyEmailText('tok')]) {
      expect(body).toContain('https://site.example.test/verify-email?token=tok');
      expect(body).not.toContain('api.example.test');
    }
    for (const body of [resetPasswordHtml('tok'), resetPasswordText('tok')]) {
      expect(body).toContain('https://site.example.test/reset-password?token=tok');
      expect(body).not.toContain('api.example.test');
    }
    expect(verifyEmailHtml('tok')).toContain('Nova Trade');
    expect(verifyEmailHtml('tok')).not.toContain('Sniper');
  });
});
