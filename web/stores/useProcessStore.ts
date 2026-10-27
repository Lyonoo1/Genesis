import { create } from "zustand";
import { listProcessesApi, stopProcessApi } from "@/lib/api/chat";

export interface RunningProcess {
  pid: number;
  command: string;
  session_id?: string;
}

interface ProcessState {
  runningProcesses: RunningProcess[];
  isExpanded: boolean;
  stoppingPids: number[];

  toggleExpanded: () => void;
  setExpanded: (expanded: boolean) => void;
  fetchProcesses: (sessionId?: string) => Promise<void>;
  stopProcess: (pid: number) => Promise<boolean>;
  addProcess: (proc: RunningProcess) => void;
  removeProcess: (pid: number) => void;
}

export const useProcessStore = create<ProcessState>((set, get) => ({
  runningProcesses: [],
  isExpanded: true,
  stoppingPids: [],

  toggleExpanded: () => set((state) => ({ isExpanded: !state.isExpanded })),
  setExpanded: (expanded) => set({ isExpanded: expanded }),

  fetchProcesses: async (sessionId?: string) => {
    try {
      const res = await listProcessesApi(sessionId);
      if (res && res.success && Array.isArray(res.processes)) {
        set({ runningProcesses: res.processes });
      }
    } catch {
      // 容错忽略
    }
  },

  stopProcess: async (pid: number) => {
    set((state) => ({ stoppingPids: [...state.stoppingPids, pid] }));
    try {
      const res = await stopProcessApi(pid);
      if (res && res.success) {
        set((state) => ({
          runningProcesses: state.runningProcesses.filter((p) => p.pid !== pid),
          stoppingPids: state.stoppingPids.filter((id) => id !== pid),
        }));
        return true;
      }
    } catch (err) {
      console.error("[useProcessStore] Failed to stop process:", err);
    } finally {
      set((state) => ({
        stoppingPids: state.stoppingPids.filter((id) => id !== pid),
      }));
    }
    return false;
  },

  addProcess: (proc: RunningProcess) => {
    set((state) => {
      if (state.runningProcesses.some((p) => p.pid === proc.pid)) {
        return state;
      }
      return {
        runningProcesses: [...state.runningProcesses, proc],
        isExpanded: true,
      };
    });
  },

  removeProcess: (pid: number) => {
    set((state) => ({
      runningProcesses: state.runningProcesses.filter((p) => p.pid !== pid),
    }));
  },
}));
