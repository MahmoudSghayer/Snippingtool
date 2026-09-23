/*
 * browser-shim.ts — stands in for `webextension-polyfill` in the userscript
 * build (`scripts/build.mjs` aliases the import here), so background/*,
 * content/* and the popup/options UIs run unchanged inside one Tampermonkey
 * script on the EA page. Only the members the extension actually calls are
 * implemented; anything else is a type error at build time, not a silent
 * `undefined` at runtime.
 *
 * What each piece maps to:
 *
 *   runtime.sendMessage / tabs.sendMessage / runtime.onMessage
 *     One in-page bus. "Background" and "content" are both just modules in
 *     this script, so a message goes to every listener and the first one
 *     that returns a promise answers it — the same rule Chrome applies. The
 *     message and the reply are structured-cloned, so no listener can hold
 *     a live reference into another's state (the isolation real extension
 *     messaging gives for free).
 *
 *   storage.local / storage.session
 *     Tampermonkey's per-script storage (`GM_*Value`), which EA's page code
 *     cannot read. There is no browser-session scope in a userscript, so
 *     `session` is the same store under a `session:` prefix: an access
 *     token or saved governor state outlives a browser restart here, where
 *     the extension would drop it. Both are safe to keep — the API rejects
 *     a stale token (401 -> refresh), and resuming governor counters is the
 *     conservative direction.
 *
 *   alarms
 *     `setInterval`. There is no service worker to wake, so an alarm only
 *     fires while an EA tab is open — which is also the only time there is
 *     anything to heartbeat or flush.
 *
 *   tabs.query / tabs.sendMessage
 *     "This tab". Each EA tab runs its own copy of the script, background
 *     included, so the kill-switch broadcast only ever needs to reach the
 *     tab it runs in.
 */

export const RUNTIME_ID = 'sniper-ledger-userscript';

const SESSION_PREFIX = 'session:';
const INSTALLED_KEY = 'sl.userscript.installed.v1';

type Sender = { id: string };
type MessageListener = (message: unknown, sender: Sender) => Promise<unknown> | undefined | void;
type AlarmListener = (alarm: { name: string }) => void;
type InstalledListener = (details: { reason: 'install' | 'update' }) => void;

const messageListeners = new Set<MessageListener>();
const alarmListeners = new Set<AlarmListener>();
const alarmTimers = new Map<
  string,
  { timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval> }
>();
let optionsPageOpener: (() => void) | null = null;

async function dispatch(message: unknown): Promise<unknown> {
  // Chrome never delivers a message synchronously; neither does this.
  await Promise.resolve();
  for (const listener of [...messageListeners]) {
    const reply = listener(structuredClone(message), { id: RUNTIME_ID });
    if (reply !== undefined) return structuredClone(await reply);
  }
  throw new Error('Could not establish connection. Receiving end does not exist.');
}

function storageArea(prefix: string) {
  return {
    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const value = GM_getValue<unknown>(prefix + key, undefined);
        if (value !== undefined) out[key] = value;
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        if (value === undefined) GM_deleteValue(prefix + key);
        else GM_setValue(prefix + key, value);
      }
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) GM_deleteValue(prefix + key);
    },
  };
}

function clearAlarm(name: string): void {
  const timers = alarmTimers.get(name);
  if (!timers) return;
  if (timers.timeout) clearTimeout(timers.timeout);
  if (timers.interval) clearInterval(timers.interval);
  alarmTimers.delete(name);
}

function fireAlarm(name: string): void {
  for (const listener of [...alarmListeners]) listener({ name });
}

const browser = {
  runtime: {
    id: RUNTIME_ID,
    sendMessage: (message: unknown): Promise<unknown> => dispatch(message),
    onMessage: {
      addListener: (listener: MessageListener): void => void messageListeners.add(listener),
      removeListener: (listener: MessageListener): void => void messageListeners.delete(listener),
    },
    openOptionsPage: async (): Promise<void> => {
      optionsPageOpener?.();
    },
    onInstalled: {
      // Fires once per Tampermonkey install of the script, the first time
      // any EA page runs it — the closest a userscript has to "install".
      addListener: (listener: InstalledListener): void => {
        if (GM_getValue<boolean>(INSTALLED_KEY, false)) return;
        GM_setValue(INSTALLED_KEY, true);
        setTimeout(() => listener({ reason: 'install' }), 0);
      },
    },
    // Tampermonkey owns updates (`@updateURL`) and applies them on the next
    // page load; there is nothing for the script itself to react to.
    onUpdateAvailable: {
      addListener: (_listener: (details: { version: string }) => void): void => undefined,
    },
    reload: (): void => location.reload(),
  },

  storage: {
    local: storageArea(''),
    session: storageArea(SESSION_PREFIX),
  },

  alarms: {
    create: (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void => {
      clearAlarm(name);
      const periodMs = info.periodInMinutes != null ? info.periodInMinutes * 60_000 : null;
      // Chrome's default: with only a period, the first fire is one period out.
      const delayMs = info.delayInMinutes != null ? info.delayInMinutes * 60_000 : periodMs;
      if (delayMs == null) return;
      const timers: {
        timeout?: ReturnType<typeof setTimeout>;
        interval?: ReturnType<typeof setInterval>;
      } = {};
      timers.timeout = setTimeout(() => {
        fireAlarm(name);
        if (periodMs != null) timers.interval = setInterval(() => fireAlarm(name), periodMs);
        else alarmTimers.delete(name);
      }, delayMs);
      alarmTimers.set(name, timers);
    },
    onAlarm: {
      addListener: (listener: AlarmListener): void => void alarmListeners.add(listener),
    },
  },

  tabs: {
    query: async (_query: { url?: string[] }): Promise<Array<{ id?: number }>> => [{ id: 0 }],
    sendMessage: (_tabId: number, message: unknown): Promise<unknown> => dispatch(message),
    create: async ({ url }: { url: string }): Promise<void> => {
      GM_openInTab(url, { active: true });
    },
  },
};

/** The userscript's settings drawer registers itself here so the popup's
 * "Settings" link (`browser.runtime.openOptionsPage()`) can open it. */
export function setOptionsPageOpener(open: () => void): void {
  optionsPageOpener = open;
}

export default browser;
