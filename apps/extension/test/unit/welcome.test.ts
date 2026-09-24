// background/welcome.ts: a fresh install opens the website's /account page,
// and nothing else (update, browser restart) opens a tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InstalledListener = (details: { reason: string }) => void;

const fake = vi.hoisted(() => ({
  listeners: [] as ((details: { reason: string }) => void)[],
  create: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onInstalled: {
        addListener: (fn: InstalledListener) => fake.listeners.push(fn),
      },
    },
    tabs: { create: fake.create },
  },
}));

async function installWith(origin: string | undefined): Promise<InstalledListener> {
  vi.stubEnv('VITE_DASHBOARD_ORIGIN', origin as string);
  vi.resetModules();
  const { installWelcomeHandler } = await import('../../src/background/welcome.js');
  installWelcomeHandler();
  const listener = fake.listeners.at(-1);
  if (!listener) throw new Error('no onInstalled listener registered');
  return listener;
}

beforeEach(() => {
  fake.listeners.length = 0;
  fake.create.mockReset();
  fake.create.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installWelcomeHandler', () => {
  it('opens /account on the website after a fresh install', async () => {
    const onInstalled = await installWith('https://novatrade.example/');
    onInstalled({ reason: 'install' });
    expect(fake.create).toHaveBeenCalledWith({ url: 'https://novatrade.example/account' });
  });

  it('opens nothing on an update or a browser update', async () => {
    const onInstalled = await installWith('https://novatrade.example');
    onInstalled({ reason: 'update' });
    onInstalled({ reason: 'chrome_update' });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('opens nothing when no website origin was built in', async () => {
    const onInstalled = await installWith('');
    onInstalled({ reason: 'install' });
    expect(fake.create).not.toHaveBeenCalled();
  });
});
