import { create } from "zustand";
import {
  fetchModelsApi,
  saveModelApi,
  deleteModelApi,
} from "@/lib/api/models";

export interface CustomModelConfig {
  id: string;
  name: string; // 显示名称，如 "DeepSeek V3"
  modelId: string; // 实际模型名，如 "deepseek-chat"
  provider: "openai" | "anthropic"; // 协议标准
  baseUrl: string; // API Base URL
  apiKey: string; // 用户的 API Key
  isDefault?: boolean; // 是否设为默认
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number; // 最大上下文容量，如 1048576 (1M)
}

const STORAGE_KEY = "genesis_custom_models_v2";

interface ModelConfigState {
  models: CustomModelConfig[];
  activeModelId: string;
  isConfigModalOpen: boolean;
  isLoading: boolean;

  // Actions
  fetchModels: () => Promise<void>;
  setActiveModelId: (id: string) => void;
  getActiveModel: () => CustomModelConfig | null;
  openConfigModal: () => void;
  closeConfigModal: () => void;
  addModel: (model: Omit<CustomModelConfig, "id">) => string;
  updateModel: (id: string, updates: Partial<CustomModelConfig>) => void;
  deleteModel: (id: string) => void;
  setDefaultModel: (id: string) => void;
}

function loadStoredModels(): { models: CustomModelConfig[]; activeId: string } {
  if (typeof window === "undefined") {
    return { models: [], activeId: "" };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const defaultItem = parsed.find((m: CustomModelConfig) => m.isDefault) || parsed[0];
        return { models: parsed, activeId: defaultItem.id };
      }
    }
  } catch (e) {
    console.error("加载自定义模型配置异常:", e);
  }
  return { models: [], activeId: "" };
}

function saveModels(models: CustomModelConfig[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
  } catch (e) {
    console.error("持久化自定义模型异常:", e);
  }
}

export const useModelConfigStore = create<ModelConfigState>((set, get) => {
  const initial = loadStoredModels();

  return {
    models: initial.models,
    activeModelId: initial.activeId,
    isConfigModalOpen: false,
    isLoading: false,

    fetchModels: async () => {
      set({ isLoading: true });
      try {
        const remote = await fetchModelsApi();
        if (Array.isArray(remote)) {
          const currentActive = get().activeModelId;
          const defaultItem = remote.find((m) => m.isDefault) || remote[0];
          const nextActiveId = remote.some((m) => m.id === currentActive)
            ? currentActive
            : (defaultItem ? defaultItem.id : "");

          set({
            models: remote,
            activeModelId: nextActiveId,
            isLoading: false,
          });
          saveModels(remote);
          return;
        }
      } catch (err) {
        console.warn("fetchModelsApi failed, fallback to local storage:", err);
      } finally {
        set({ isLoading: false });
      }
    },

    setActiveModelId: (id: string) => {
      set({ activeModelId: id });
    },

    getActiveModel: () => {
      const { models, activeModelId } = get();
      if (models.length === 0) return null;
      return (
        models.find((m) => m.id === activeModelId) ||
        models[0] ||
        null
      );
    },

    openConfigModal: () => set({ isConfigModalOpen: true }),
    closeConfigModal: () => set({ isConfigModalOpen: false }),

    addModel: (modelIn) => {
      const newId = `model-${Date.now()}`;
      const shouldBeDefault = modelIn.isDefault ?? get().models.length === 0;
      const newModel: CustomModelConfig = {
        ...modelIn,
        id: newId,
        isDefault: shouldBeDefault,
      };

      let updatedModels = [...get().models];
      if (newModel.isDefault) {
        updatedModels = updatedModels.map((m) => ({ ...m, isDefault: false }));
      }
      updatedModels.push(newModel);
      saveModels(updatedModels);
      set({
        models: updatedModels,
        activeModelId: newId,
      });

      // 同步物理落库
      saveModelApi(newModel).catch((err) => {
        console.warn("saveModelApi failed:", err);
      });

      return newId;
    },

    updateModel: (id, updates) => {
      let updatedModels = get().models.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      );

      if (updates.isDefault) {
        updatedModels = updatedModels.map((m) =>
          m.id === id ? { ...m, isDefault: true } : { ...m, isDefault: false }
        );
      }

      saveModels(updatedModels);
      set({ models: updatedModels });

      const target = updatedModels.find((m) => m.id === id);
      if (target) {
        saveModelApi(target).catch((err) => {
          console.warn("saveModelApi update failed:", err);
        });
      }
    },

    deleteModel: (id) => {
      const updatedModels = get().models.filter((m) => m.id !== id);
      let nextActiveId = get().activeModelId;
      if (get().activeModelId === id) {
        nextActiveId = updatedModels.length > 0 ? updatedModels[0].id : "";
      }
      saveModels(updatedModels);
      set({
        models: updatedModels,
        activeModelId: nextActiveId,
      });

      deleteModelApi(id).catch((err) => {
        console.warn("deleteModelApi failed:", err);
      });
    },

    setDefaultModel: (id) => {
      const updatedModels = get().models.map((m) => ({
        ...m,
        isDefault: m.id === id,
      }));
      saveModels(updatedModels);
      set({ models: updatedModels, activeModelId: id });

      const target = updatedModels.find((m) => m.id === id);
      if (target) {
        saveModelApi(target).catch((err) => {
          console.warn("saveModelApi setDefault failed:", err);
        });
      }
    },
  };
});
