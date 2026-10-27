/**
 * 示例：把数据请求从 store 里抽出来的 service 层
 *
 * 对照现状：项目里的 store（如 useSessionStore / useChatStore）直接调 Supabase，
 * 导致 store 既管状态又管 IO，难以复用、难以测试、也无法在 store 之外复用同一份请求逻辑。
 *
 * 这里用内存数组模拟一张 Supabase 表，签名保持 async + 抛错，方便替换成：
 *   const { data, error } = await supabase.from("tasks").select();
 *   if (error) throw error;
 *   return data;
 */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  updatedAt: number;
}

/** 模拟数据库表 */
const MOCK_DB: Task[] = [
  { id: "task-1", title: "梳理 store 依赖关系", done: false, updatedAt: 1 },
  { id: "task-2", title: "给 Workbench store 加 devtools", done: true, updatedAt: 2 },
];

let idSeq = 0;
const nextId = () => `task-${Date.now()}-${idSeq++}`;

/** 模拟网络延迟 */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const taskService = {
  async list(): Promise<Task[]> {
    await delay(400);
    // 返回副本，避免外部直接改到"数据库"
    return MOCK_DB.map((task) => ({ ...task }));
  },

  async create(input: { title: string }): Promise<Task> {
    await delay(500);
    const title = input.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const task: Task = { id: nextId(), title, done: false, updatedAt: Date.now() };
    MOCK_DB.unshift(task);
    return { ...task };
  },

  async toggle(id: string, done: boolean): Promise<Task> {
    await delay(300);
    const task = MOCK_DB.find((item) => item.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    task.done = done;
    task.updatedAt = Date.now();
    return { ...task };
  },

  async remove(id: string): Promise<void> {
    await delay(300);
    const index = MOCK_DB.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`任务不存在: ${id}`);
    MOCK_DB.splice(index, 1);
  },
};
