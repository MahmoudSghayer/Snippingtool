import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface ConnectionState {
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
}

/** Real state of the WS gateway (`lib/ws.ts#WsConnection`), read by the
 * topbar's "Online" indicator (`routes/layouts.tsx`) so it reflects the
 * actual socket instead of a hard-coded dot. */
export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'connecting',
  setStatus: (status) => set({ status }),
}));
