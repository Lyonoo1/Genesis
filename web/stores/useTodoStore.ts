import { create } from "zustand";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoState {
  /** sessionId → TodoItem[] */
  todosBySession: Record<string, TodoItem[]>;
  setTodos: (sessionId: string, todos: TodoItem[]) => void;
  clearTodos: (sessionId: string) => void;
}

export const useTodoStore = create<TodoState>()((set) => ({
  todosBySession: {},

  setTodos: (sessionId, todos) =>
    set((state) => ({
      todosBySession: { ...state.todosBySession, [sessionId]: todos },
    })),

  clearTodos: (sessionId) =>
    set((state) => {
      const next = { ...state.todosBySession };
      delete next[sessionId];
      return { todosBySession: next };
    }),
}));
