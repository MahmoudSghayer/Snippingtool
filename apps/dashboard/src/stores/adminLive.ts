import { create } from 'zustand';

interface AdminOverviewTick {
  onlineUsers: number;
  activeSnipesLastMinute: number;
  errorsLastMinute: number;
  generatedAt: string;
}

interface AdminLiveState {
  lastTick: AdminOverviewTick | null;
  setTick: (tick: AdminOverviewTick) => void;
}

/** `admin.overview.tick` WS pushes, read by /admin (Overview) for the live
 * online/active-snipe counters PHASE 7 asks for — kept out of TanStack Query
 * because it's a push stream, not something the page itself fetches. */
export const useAdminLiveStore = create<AdminLiveState>((set) => ({
  lastTick: null,
  setTick: (tick) => set({ lastTick: tick }),
}));
