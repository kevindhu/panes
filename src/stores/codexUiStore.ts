import { create } from "zustand";

interface CodexUiState {
  sidebarOpen: boolean;
  searchOpen: boolean;
  toggleSidebar: () => void;
  setSearchOpen: (open: boolean) => void;
}

export const useCodexUiStore = create<CodexUiState>((set) => ({
  sidebarOpen: true,
  searchOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}));
