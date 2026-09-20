// The dashboard is itself a "device" in the auth model (docs/04-auth.md §5)
// — every login/register call must include a `device` fingerprint. Unlike
// the extension (which hashes hardware-ish signals), the dashboard has no
// such signal worth hashing, so it generates one random, opaque id per
// browser profile and persists it — stable across sessions/tabs on the same
// browser, unique per browser/profile, never derived from anything
// identifying.
const STORAGE_KEY = 'sl_dashboard_device_fingerprint';

function randomFingerprint(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getDeviceFingerprint(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const generated = randomFingerprint();
    localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // Private-browsing / storage-blocked fallback: a session-scoped
    // in-memory value still satisfies the schema, it just won't persist.
    return randomFingerprint();
  }
}

function detectOs(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac OS')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Unknown';
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Safari/')) return 'Safari';
  return 'Unknown';
}

export function buildDevicePayload(name: string): {
  fingerprint: string;
  name: string;
  browser: string;
  os: string;
} {
  return {
    fingerprint: getDeviceFingerprint(),
    name,
    browser: detectBrowser(),
    os: detectOs(),
  };
}

export function defaultDeviceName(): string {
  return `${detectBrowser()} on ${detectOs()}`;
}
