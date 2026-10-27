import { create } from "zustand";

export interface PreviewFile {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  size: string;
  updatedAt: string;
}

const DEFAULT_PREVIEW_FILES: PreviewFile[] = [];

interface UIState {
  isLeftSidebarOpen: boolean;
  isLeftSidebarHovered: boolean;
  isRightSidebarOpen: boolean;
  isTerminalOpen: boolean;
  terminalHeight: number;
  activeInspectorTab: "preview" | "files";
  selectedFileId: string | null;
  previewFiles: PreviewFile[];

  toggleLeftSidebar: () => void;
  openLeftSidebar: () => void;
  closeLeftSidebar: () => void;
  setLeftSidebarHovered: (hovered: boolean) => void;

  toggleRightSidebar: () => void;
  openRightSidebar: (tab?: "preview" | "files", fileId?: string) => void;
  closeRightSidebar: () => void;
  setActiveInspectorTab: (tab: "preview" | "files") => void;
  setSelectedFileId: (fileId: string | null) => void;
  setPreviewFiles: (files: PreviewFile[]) => void;
  addPreviewFile: (file: PreviewFile) => void;

  toggleTerminal: () => void;
  openTerminal: () => void;
  closeTerminal: () => void;
  setTerminalHeight: (height: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isLeftSidebarOpen: true,
  isLeftSidebarHovered: false,
  isRightSidebarOpen: true,
  isTerminalOpen: false,
  terminalHeight: 320,
  activeInspectorTab: "preview",
  selectedFileId: null,
  previewFiles: DEFAULT_PREVIEW_FILES,

  toggleTerminal: () =>
    set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),

  openTerminal: () => set({ isTerminalOpen: true }),

  closeTerminal: () => set({ isTerminalOpen: false }),

  setTerminalHeight: (terminalHeight) => set({ terminalHeight }),

  toggleLeftSidebar: () =>
    set((state) => ({
      isLeftSidebarOpen: !state.isLeftSidebarOpen,
      isLeftSidebarHovered: false,
    })),

  openLeftSidebar: () =>
    set({ isLeftSidebarOpen: true, isLeftSidebarHovered: false }),

  closeLeftSidebar: () =>
    set({ isLeftSidebarOpen: false, isLeftSidebarHovered: false }),

  setLeftSidebarHovered: (isLeftSidebarHovered) =>
    set({ isLeftSidebarHovered }),

  toggleRightSidebar: () =>
    set((state) => ({ isRightSidebarOpen: !state.isRightSidebarOpen })),

  openRightSidebar: (tab = "preview", fileId) =>
    set((state) => ({
      isRightSidebarOpen: true,
      activeInspectorTab: tab,
      selectedFileId: fileId || state.selectedFileId,
    })),

  closeRightSidebar: () => set({ isRightSidebarOpen: false }),

  setActiveInspectorTab: (tab) => set({ activeInspectorTab: tab }),

  setSelectedFileId: (fileId) => set({ selectedFileId: fileId }),

  setPreviewFiles: (previewFiles) => set({ previewFiles }),

  addPreviewFile: (file) =>
    set((state) => {
      const exists = state.previewFiles.some((f) => f.id === file.id);
      if (exists) {
        return {
          previewFiles: state.previewFiles.map((f) =>
            f.id === file.id ? file : f
          ),
          selectedFileId: file.id,
        };
      }
      return {
        previewFiles: [file, ...state.previewFiles],
        selectedFileId: file.id,
      };
    }),
}));
