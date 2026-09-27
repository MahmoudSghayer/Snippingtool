// The dashboard signs in as a device (docs/04-auth.md §5) without asking the
// user to name it: `buildDevicePayload` names it from the browser and OS.

import { describe, expect, it } from 'vitest';

import { buildDevicePayload, defaultDeviceName } from '@/lib/device.js';

describe('buildDevicePayload', () => {
  it('names the device automatically and keeps the fingerprint stable', () => {
    const first = buildDevicePayload();
    expect(first.name).toBe(defaultDeviceName());
    expect(first.name.length).toBeGreaterThan(0);
    expect(buildDevicePayload().fingerprint).toBe(first.fingerprint);
  });
});
