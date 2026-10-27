"use client";

/**
 * 示例：组件里如何「细粒度订阅」，避免整块 store 变化导致全组件重渲染
 *
 * 对照现状：项目里常见写法是 useUIStore() 不带选择器，或选择器返回新对象/新数组，
 * 结果是任意字段变化都会重渲染。这里给出四种正确姿势。
 *
 * 临时挂载方式（验证完请自行删除）：
 *   在 app/page.tsx 中
 *   import { DemoTaskPanel } from "@/stores/examples/DemoTaskPanel";
 *   然后渲染 <DemoTaskPanel />
 */

import { useEffect, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDemoTaskStore, type TaskFilter } from "./useDemoTaskStore";

const FILTERS: { value: TaskFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

export function DemoTaskPanel() {
  // ① 原子选择器：返回原始值，只有这一项变化时才重渲染
  const isLoading = useDemoTaskStore((s) => s.isLoading);
  const error = useDemoTaskStore((s) => s.error);
  const filter = useDemoTaskStore((s) => s.filter);

  // ② useShallow：选择器里做了 filter 派生，每次都是新数组，
  //    必须用浅比较包一层，否则会「每次渲染都认为状态变了」
  const visibleTasks = useDemoTaskStore(
    useShallow((s) =>
      s.tasks.filter((task) =>
        s.filter === "all" ? true : s.filter === "done" ? task.done : !task.done
      )
    )
  );

  // ③ action 的引用是稳定的，单独取出来即可，不会引起额外重渲染
  const addTask = useDemoTaskStore((s) => s.addTask);
  const toggleTask = useDemoTaskStore((s) => s.toggleTask);
  const removeTask = useDemoTaskStore((s) => s.removeTask);
  const setFilter = useDemoTaskStore((s) => s.setFilter);

  const [title, setTitle] = useState("");

  // ④ 瞬态订阅（transient subscription）：不参与渲染的副作用走 subscribe，
  //    只有 error 字段变化才触发，组件本身不会因此重渲染
  useEffect(() => {
    const unsubscribe = useDemoTaskStore.subscribe(
      (s) => s.error,
      (next, prev) => {
        if (next && next !== prev) {
          console.warn("[DemoTaskPanel] 操作失败:", next);
        }
      }
    );
    return unsubscribe;
  }, []);

  // 首屏加载用 getState() 直接读最新快照，不必把 store 的字段塞进依赖数组
  useEffect(() => {
    const { tasks, loadTasks } = useDemoTaskStore.getState();
    if (tasks.length === 0) void loadTasks();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title;
    setTitle("");
    await addTask(value); // 空白输入由 store 内部拦掉
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-xl border border-black/10 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Zustand 状态管理示例</h2>
        {isLoading && <span className="text-xs text-black/50">加载中…</span>}
      </header>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新建任务后回车"
          className="flex-1 rounded-lg border border-black/15 px-3 py-2 text-sm outline-none focus:border-black/40"
        />
        <button
          type="submit"
          className="rounded-lg bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          disabled={title.trim().length === 0}
        >
          添加
        </button>
      </form>

      <div className="flex gap-1">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setFilter(item.value)}
            className={
              "rounded-md px-3 py-1 text-xs transition " +
              (filter === item.value
                ? "bg-black text-white"
                : "bg-black/5 text-black/60 hover:bg-black/10")
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
      )}

      <ul className="flex flex-col divide-y divide-black/5">
        {visibleTasks.length === 0 && (
          <li className="py-6 text-center text-xs text-black/40">暂无任务</li>
        )}
        {visibleTasks.map((task) => (
          <li key={task.id} className="flex items-center gap-3 py-2">
            <input
              type="checkbox"
              checked={task.done}
              onChange={() => void toggleTask(task.id)}
              className="size-4"
            />
            <span
              className={
                "flex-1 text-sm " + (task.done ? "text-black/35 line-through" : "")
              }
            >
              {task.title}
            </span>
            <button
              type="button"
              onClick={() => void removeTask(task.id)}
              className="text-xs text-black/40 hover:text-red-600"
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
