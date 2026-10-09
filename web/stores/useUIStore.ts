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

const DEFAULT_PREVIEW_FILES: PreviewFile[] = [
  {
    id: "file-main-py",
    name: "main.py",
    path: "Genesis/api/main.py",
    language: "python",
    size: "3.2 KB",
    updatedAt: "2026-09-20 11:20:00",
    content: `from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from routers import sessions, chat, skills, marketplace

app = FastAPI(
    title="Genesis Agentic API",
    description="Codex-grade Autonomous Engineering Assistant",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(skills.router, prefix="/api")
app.include_router(marketplace.router, prefix="/api")

@app.get("/healthz")
async def health_check():
    return {"status": "ok", "engine": "Genesis Core v1"}
`,
  },
  {
    id: "file-projects-sql",
    name: "003_create_projects_table.sql",
    path: "Genesis/supabase/migrations/20260920000002_create_projects_table.sql",
    language: "sql",
    size: "1.4 KB",
    updatedAt: "2026-09-20 11:15:00",
    content: `-- Genesis Projects Schema Migration
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  icon text,
  is_expanded boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS Security Policies
alter table public.projects enable row level security;

create policy "Users manage own projects"
  on public.projects
  for all
  using (auth.uid() = user_id or auth.uid() is null)
  with check (auth.uid() = user_id or auth.uid() is null);
`,
  },
  {
    id: "file-session-store",
    name: "useSessionStore.ts",
    path: "Genesis/web/stores/useSessionStore.ts",
    language: "typescript",
    size: "8.6 KB",
    updatedAt: "2026-09-20 11:24:00",
    content: `import { create } from "zustand";
import { Session, Project } from "@/types";
import { supabase } from "@/lib/supabase/client";

interface SessionState {
  projects: Project[];
  activeProjectId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  addProject: (name: string) => Project;
  updateProjectName: (id: string, name: string) => void;
  archiveProject: (id: string) => void;
  archiveSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessions: [],
  activeSessionId: null,
  // ...
}));
`,
  },
];

interface UIState {
  isLeftSidebarOpen: boolean;
  isLeftSidebarHovered: boolean;
  isRightSidebarOpen: boolean;
  activeInspectorTab: "preview" | "info";
  selectedFileId: string;
  previewFiles: PreviewFile[];

  toggleLeftSidebar: () => void;
  openLeftSidebar: () => void;
  closeLeftSidebar: () => void;
  setLeftSidebarHovered: (hovered: boolean) => void;

  toggleRightSidebar: () => void;
  openRightSidebar: (tab?: "preview" | "info", fileId?: string) => void;
  closeRightSidebar: () => void;
  setActiveInspectorTab: (tab: "preview" | "info") => void;
  setSelectedFileId: (fileId: string) => void;
  setPreviewFiles: (files: PreviewFile[]) => void;
  addPreviewFile: (file: PreviewFile) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isLeftSidebarOpen: true,
  isLeftSidebarHovered: false,
  isRightSidebarOpen: false,
  activeInspectorTab: "preview",
  selectedFileId: DEFAULT_PREVIEW_FILES[0].id,
  previewFiles: DEFAULT_PREVIEW_FILES,

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
