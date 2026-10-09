import { create } from "zustand";

export type DensityMode = "comfortable" | "compact";
export type SettingsTab =
  | "general"
  | "models"
  | "history"
  | "appearance"
  | "profile"
  | "shortcuts"
  | "usage"
  | "plugins"
  | "database"
  | "archived";

export interface GeneralSettings {
  defaultFileOpener: "VS Code" | "Cursor" | "System";
  language: "zh-CN" | "en-US";
  showInMenuBar: boolean;
  showBottomPanel: boolean;
  defaultTerminalPosition: "bottom" | "right";
  preventSleep: boolean;
  defaultPermission: boolean;
  autoReview: boolean;
  fullAccess: boolean;
}

export interface ProfileSettings {
  name: string;
  email: string;
  avatarText: string;
  usagePercentage: number;
}

interface SettingsState {
  density: DensityMode;
  serifReading: boolean;
  isSettingsModalOpen: boolean;
  activeSettingsTab: SettingsTab;

  general: GeneralSettings;
  profile: ProfileSettings;

  setDensity: (density: DensityMode) => void;
  setSerifReading: (serifReading: boolean) => void;
  openSettingsModal: (tab?: SettingsTab) => void;
  closeSettingsModal: () => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  updateGeneralSettings: (partial: Partial<GeneralSettings>) => void;
  updateProfileSettings: (partial: Partial<ProfileSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  density: "comfortable",
  serifReading: true,
  isSettingsModalOpen: false,
  activeSettingsTab: "general",

  general: {
    defaultFileOpener: "VS Code",
    language: "zh-CN",
    showInMenuBar: true,
    showBottomPanel: true,
    defaultTerminalPosition: "bottom",
    preventSleep: true,
    defaultPermission: false,
    autoReview: true,
    fullAccess: true,
  },

  profile: {
    name: "李昂",
    email: "lyon@example.com",
    avatarText: "LY",
    usagePercentage: 12,
  },

  setDensity: (density) => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-density", density);
    }
    set({ density });
  },
  setSerifReading: (serifReading) => set({ serifReading }),
  openSettingsModal: (tab = "general") =>
    set({ isSettingsModalOpen: true, activeSettingsTab: tab }),
  closeSettingsModal: () => set({ isSettingsModalOpen: false }),
  setActiveSettingsTab: (activeSettingsTab) => set({ activeSettingsTab }),
  updateGeneralSettings: (partial) =>
    set((state) => ({ general: { ...state.general, ...partial } })),
  updateProfileSettings: (partial) =>
    set((state) => ({ profile: { ...state.profile, ...partial } })),
}));
