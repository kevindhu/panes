import { create } from "zustand";

interface CodexUiState {
  sidebarOpen: boolean;
  searchOpen: boolean;
  setupOpen: boolean;
  toggleSidebar: () => void;
  setSearchOpen: (open: boolean) => void;
  setSetupOpen: (open: boolean) => void;
}

export const useCodexUiStore = create<CodexUiState>((set) => ({
  sidebarOpen: true,
  searchOpen: false,
  setupOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSetupOpen: (setupOpen) => set({ setupOpen }),
}));
