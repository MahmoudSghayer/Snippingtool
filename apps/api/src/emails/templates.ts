// Simple HTML+text email template functions. No templating engine — these
// are short, static-shaped emails, and keeping them as plain functions means
// no extra runtime dependency and full type safety on the parameters.

const BRAND = 'Nova Trade';

// XSS hardening (docs/09-security.md "Escaped email templates"): every
// value interpolated into an HTML email body below that did not originate
// from this server's own static strings or `encodeURIComponent`'d URL
// params — an admin-supplied `reason`, a device `name` from a fingerprint
// the extension/attacker controls — goes through this first. Without it, a
// `reason`/`deviceName` value like `<img src=x onerror=...>` would land
// verbatim in an HTML email body some other person's mail client renders.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0D1311; color:#e6e6e6; padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#151D1A;border-radius:8px;padding:32px;">
      <h1 style="color:#DDB35C;font-size:20px;margin-top:0;">${BRAND}</h1>
      ${bodyHtml}
      <p style="color:#8a938f;font-size:12px;margin-top:32px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </body>
</html>`;
}

/** Links in emails open pages on the website (verify email, reset
 * password, sign in), which is DASHBOARD_ORIGIN. It used APP_ORIGIN, the
 * API's own address, which serves none of those pages, so every link in
 * production was a 404 and no new account could be verified. */
function siteOrigin(): string {
  return (process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
}

export function verifyEmailHtml(token: string): string {
  const url = `${siteOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  return wrapHtml(
    'Verify your email',
    `<p>Welcome! Confirm your email address to activate your account.</p>
     <p><a href="${url}" style="display:inline-block;background:#DDB35C;color:#0D1311;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Verify email</a></p>
     <p style="font-size:12px;color:#8a938f;">Or paste this link: ${url}</p>
     <p style="font-size:12px;color:#8a938f;">This link expires in 24 hours.</p>`,
  );
}

export function verifyEmailText(token: string): string {
  const url = `${siteOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  return `Verify your email for ${BRAND}: ${url}\n\nThis link expires in 24 hours.`;
}

export function resetPasswordHtml(token: string): string {
  const url = `${siteOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  return wrapHtml(
    'Reset your password',
    `<p>We received a request to reset your password.</p>
     <p><a href="${url}" style="display:inline-block;background:#DDB35C;color:#0D1311;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a></p>
     <p style="font-size:12px;color:#8a938f;">Or paste this link: ${url}</p>
     <p style="font-size:12px;color:#8a938f;">This link expires in 1 hour and can only be used once. Using it will sign you out of every device.</p>`,
  );
}

export function resetPasswordText(token: string): string {
  const url = `${siteOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  return `Reset your password for ${BRAND}: ${url}\n\nThis link expires in 1 hour and can only be used once. Using it will sign you out of every device.`;
}

export function deviceLimitWarningHtml(deviceName: string | null): string {
  return wrapHtml(
    'Device limit reached',
    `<p>A sign-in attempt from a new device (${escapeHtml(deviceName ?? 'unknown device')}) was blocked because your plan's device limit has been reached.</p>
     <p>Open the dashboard's Devices page to revoke an old device if this was you.</p>`,
  );
}

export function deviceLimitWarningText(deviceName: string | null): string {
  return `A sign-in attempt from a new device (${deviceName ?? 'unknown device'}) was blocked because your plan's device limit has been reached. Open the dashboard's Devices page to revoke an old device if this was you.`;
}

export function forceLogoutNoticeHtml(reason: string): string {
  return wrapHtml(
    'You were signed out',
    `<p>An administrator signed you out of every device.</p>
     <p style="font-size:12px;color:#8a938f;">Reason: ${escapeHtml(reason)}</p>
     <p>If this wasn't expected, please contact support.</p>`,
  );
}

export function forceLogoutNoticeText(reason: string): string {
  return `An administrator signed you out of every device. Reason: ${reason}. If this wasn't expected, please contact support.`;
}
