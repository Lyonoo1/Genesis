import { create } from "zustand";

export type DensityMode = "comfortable" | "compact";

interface SettingsState {
  density: DensityMode;
  serifReading: boolean;
  setDensity: (density: DensityMode) => void;
  setSerifReading: (serifReading: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  density: "comfortable",
  serifReading: true,
  setDensity: (density) => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-density", density);
    }
    set({ density });
  },
  setSerifReading: (serifReading) => set({ serifReading }),
}));
