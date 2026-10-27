# Zustand 状态管理示例（stores/examples）

这是针对「store 减重 / 细粒度订阅 / 加调试工具」的一个最小可运行示例，**与现有业务代码完全隔离**，
不会被任何路由引用，验证完可整目录删除。

## 文件说明

| 文件 | 演示内容 |
| --- | --- |
| `taskService.ts` | service 层：把异步 IO 从 store 中抽出，store 只消费 Promise |
| `useDemoTaskStore.ts` | `devtools` + `subscribeWithSelector` + `persist(partialize)` 三层中间件；乐观更新与回滚 |
| `DemoTaskPanel.tsx` | 组件侧四种订阅姿势：原子选择器、`useShallow` 派生、稳定 action、`subscribe` 瞬态订阅 |

## 与现有 store 的差异

现有 store（如 `useUIStore` / `useChatStore`）是「纯 create + 手写不可变更新」，示例在此基础上增加了：

1. **具名 action**：`set(patch, false, "task/add/optimistic")`，在 Redux DevTools 里可读、可按 action 溯源。
2. **瞬态订阅**：`store.subscribe(selector, listener)` 需要 `subscribeWithSelector`，用于不进渲染的副作用。
3. **选择性持久化**：`partialize` 只写 `filter` 到 localStorage，服务端数据不落盘
   （现有 `useWorkbenchStore` 也是这个思路，只是没有 `devtools`）。
4. **IO 与状态分离**：store 里不再出现 Supabase 调用，换后端只改 `taskService`。

## 临时挂载验证

```tsx
// app/page.tsx
import { DemoTaskPanel } from "@/stores/examples/DemoTaskPanel";
// ...
<DemoTaskPanel />
```

## 中间件顺序

```
devtools( subscribeWithSelector( persist( stateCreator, persistOptions ) ) )
```

- `devtools` 放最外层，才能捕获其余中间件与 action 的完整调用；
- `persist` 放最内层，保证持久化的是「真实状态」而不是中间件包装后的状态；
- 顺序颠倒会导致 devtools 看不到 action、或 `subscribe(selector)` 签名失效。
