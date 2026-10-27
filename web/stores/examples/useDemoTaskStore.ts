/**
 * 示例：带中间件的 Zustand store
 *
 * 相比项目现有 store（只有 useWorkbenchStore 用了 persist），这里演示三件事：
 *   1. subscribeWithSelector —— 允许 useDemoTaskStore.subscribe(selector, listener) 做瞬态订阅
 *   2. devtools            —— Redux DevTools 里能看到 "task/add/optimistic" 这类具名 action
 *   3. persist + partialize —— 只持久化必要的字段，避免把任务列表写进 localStorage
 *
 * 另外演示了「乐观更新 + 失败回滚」的异步 action 写法：
 * 先改本地状态让 UI 立即响应，请求失败再把状态改回去。
 */

import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { taskService, type Task } from "./taskService";

export type TaskFilter = "all" | "active" | "done";

export interface DemoTaskState {
  tasks: Task[];
  filter: TaskFilter;
  isLoading: boolean;
  error: string | null;

  loadTasks: () => Promise<void>;
  addTask: (title: string) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  setFilter: (filter: TaskFilter) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  tasks: [] as Task[],
  filter: "all" as TaskFilter,
  isLoading: false,
  error: null,
};

/** 统一把 unknown 异常转成可展示的文案 */
const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const useDemoTaskStore = create<DemoTaskState>()(
  devtools(
    subscribeWithSelector(
      persist(
        (set, get) => ({
          ...INITIAL_STATE,

          loadTasks: async () => {
            set({ isLoading: true, error: null }, false, "task/load/start");
            try {
              const tasks = await taskService.list();
              set({ tasks, isLoading: false }, false, "task/load/success");
            } catch (err) {
              set({ isLoading: false, error: toMessage(err) }, false, "task/load/error");
            }
          },

          addTask: async (title) => {
            const trimmed = title.trim();
            if (!trimmed) return;

            // 1) 乐观插入一条临时任务
            const optimistic: Task = {
              id: `optimistic-${Date.now()}`,
              title: trimmed,
              done: false,
              updatedAt: Date.now(),
            };
            set(
              (state) => ({ tasks: [optimistic, ...state.tasks] }),
              false,
              "task/add/optimistic"
            );

            try {
              // 2) 服务端成功后用真实数据替换临时项
              const saved = await taskService.create({ title: trimmed });
              set(
                (state) => ({
                  tasks: state.tasks.map((task) => (task.id === optimistic.id ? saved : task)),
                }),
                false,
                "task/add/success"
              );
            } catch (err) {
              // 3) 失败则回滚，并把错误挂到 state 上由 UI 展示
              set(
                (state) => ({
                  tasks: state.tasks.filter((task) => task.id !== optimistic.id),
                  error: toMessage(err),
                }),
                false,
                "task/add/rollback"
              );
            }
          },

          toggleTask: async (id) => {
            // 用 get() 读最新快照，不要在 async 闭包里用外层旧值
            const previous = get().tasks.find((task) => task.id === id);
            if (!previous) return;
            const nextDone = !previous.done;

            set(
              (state) => ({
                tasks: state.tasks.map((task) =>
                  task.id === id ? { ...task, done: nextDone } : task
                ),
              }),
              false,
              "task/toggle/optimistic"
            );

            try {
              const saved = await taskService.toggle(id, nextDone);
              set(
                (state) => ({
                  tasks: state.tasks.map((task) => (task.id === id ? saved : task)),
                }),
                false,
                "task/toggle/success"
              );
            } catch (err) {
              // 回滚到点击前的状态
              set(
                (state) => ({
                  tasks: state.tasks.map((task) => (task.id === id ? previous : task)),
                  error: toMessage(err),
                }),
                false,
                "task/toggle/rollback"
              );
            }
          },

          removeTask: async (id) => {
            const previous = get().tasks;
            set(
              (state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }),
              false,
              "task/remove/optimistic"
            );

            try {
              await taskService.remove(id);
            } catch (err) {
              set({ tasks: previous, error: toMessage(err) }, false, "task/remove/rollback");
            }
          },

          setFilter: (filter) => set({ filter }, false, "task/filter"),
          reset: () => set(INITIAL_STATE, false, "task/reset"),
        }),
        {
          name: "genesis-demo-task-state",
          // 只持久化筛选条件：任务列表属于服务端数据，不该被写进 localStorage
          partialize: (state) => ({ filter: state.filter }),
        }
      )
    ),
    {
      name: "DemoTaskStore",
      // 生产环境不挂 devtools，避免额外开销
      enabled: process.env.NODE_ENV !== "production",
    }
  )
);
