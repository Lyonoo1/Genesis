import { create } from "zustand";

export interface PluginItem {
  id: string;
  name: string;
  category: "研发工作流" | "代码审查" | "系统集成";
  type: "skill" | "mcp";
  version: string;
  author: string;
  description: string;
  readme: string;
  permissions: Array<"exec:sandbox" | "read:file" | "net:egress" | "db:query" | "mcp:remote">;
  downloads: number;
  scope?: "personal" | "system";
  iconType?: "cube" | "image" | "book" | "code" | "tool" | "database" | "git";
}

export interface McpServerConfig {
  id: string;
  name: string;
  type: "remote_url" | "local_command";
  endpoint: string;
  status: "online" | "offline" | "connecting";
  tools: Array<{
    name: string;
    description: string;
    enabled: boolean;
  }>;
}

interface MarketplaceState {
  plugins: PluginItem[];
  installedPluginIds: string[];
  autoTriggerMap: Record<string, boolean>;
  mcpServers: McpServerConfig[];
  isMcpDrawerOpen: boolean;

  // Actions
  installPlugin: (id: string) => Promise<void>;
  uninstallPlugin: (id: string) => Promise<void>;
  toggleAutoTrigger: (id: string) => void;
  openMcpDrawer: () => void;
  closeMcpDrawer: () => void;
  toggleMcpTool: (serverId: string, toolName: string) => void;
  refreshMcpServer: (serverId: string) => Promise<void>;
  addMcpServer: (server: Omit<McpServerConfig, "id">) => void;
  removeMcpServer: (serverId: string) => void;
}

const INITIAL_PLUGINS: PluginItem[] = [
  {
    id: "frontend-skill",
    name: "Frontend Skill",
    category: "研发工作流",
    type: "skill",
    scope: "personal",
    iconType: "cube",
    version: "1.3.0",
    author: "Genesis Official",
    description: "Design visually strong landing pages, web apps and components",
    readme: "### Frontend Skill\n快速生成高质量现代前端组件与响应式页面布局。",
    permissions: ["read:file", "exec:sandbox"],
    downloads: 5420,
  },
  {
    id: "hatch-pet",
    name: "Hatch Pet",
    category: "研发工作流",
    type: "skill",
    scope: "personal",
    iconType: "cube",
    version: "1.0.2",
    author: "Genesis Lab",
    description: "Hatch style-flexible Codex pets",
    readme: "### Hatch Pet\n在 IDE 与控制台生成个性化伴生桌面宠物与交互动画。",
    permissions: ["exec:sandbox"],
    downloads: 3820,
  },
  {
    id: "image-gen",
    name: "Image Gen",
    category: "系统集成",
    type: "skill",
    scope: "system",
    iconType: "image",
    version: "2.0.1",
    author: "Genesis AI",
    description: "Generate or edit images for websites, icons and UI assets",
    readme: "### Image Gen\n基于扩散模型一键生成适配暗黑主题的应用 UI 图标与配图素材。",
    permissions: ["net:egress"],
    downloads: 7200,
  },
  {
    id: "karpathy-guidelines",
    name: "Karpathy Guidelines",
    category: "代码审查",
    type: "skill",
    scope: "personal",
    iconType: "cube",
    version: "1.1.0",
    author: "Andrej Lab",
    description: "Behavioral guidelines to reduce LLM hallucination and errors",
    readme: "### Karpathy Guidelines\n注入严格的代码推导逻辑与思维链约束，显著降低幻觉率。",
    permissions: ["read:file"],
    downloads: 6100,
  },
  {
    id: "openai-docs",
    name: "OpenAI Docs",
    category: "系统集成",
    type: "skill",
    scope: "system",
    iconType: "book",
    version: "2.4.0",
    author: "OpenAI Community",
    description: "OpenAI and Codex docs for models, APIs and developer tools",
    readme: "### OpenAI Docs\n集成实时官方 API 文档索引与最佳工程实践范例。",
    permissions: ["net:egress"],
    downloads: 9400,
  },
  {
    id: "petpal",
    name: "PetPal",
    category: "研发工作流",
    type: "skill",
    scope: "personal",
    iconType: "cube",
    version: "1.0.0",
    author: "Lyon",
    description: "PetPal Taro 前端和 Spring Boot 后端开发规则与代码模板",
    readme: "### PetPal\n针对 PetPal 项目的小程序跨端 Taro 与 Spring Boot 后端工程规则约束。",
    permissions: ["read:file", "exec:sandbox"],
    downloads: 1200,
  },
  {
    id: "playwright-skill",
    name: "Playwright CLI Skill",
    category: "研发工作流",
    type: "skill",
    scope: "system",
    iconType: "code",
    version: "1.4.2",
    author: "Genesis Official",
    description: "Automate end-to-end browser testing and user interaction validation",
    readme: "### Playwright CLI Skill\n在无头沙箱中执行端到端网页测试与自动化验证。",
    permissions: ["exec:sandbox", "net:egress"],
    downloads: 4100,
  },
  {
    id: "plugin-creator",
    name: "Plugin Creator",
    category: "研发工作流",
    type: "skill",
    scope: "system",
    iconType: "tool",
    version: "1.0.0",
    author: "Genesis Lab",
    description: "Scaffold, test and package custom Genesis skills and MCP tools",
    readme: "### Plugin Creator\n脚手架快速生成自定义技能与标准 MCP 工具规范。",
    permissions: ["read:file", "exec:sandbox"],
    downloads: 2300,
  },
  {
    id: "code-analyzer",
    name: "Code Analyzer",
    category: "研发工作流",
    type: "skill",
    scope: "system",
    iconType: "code",
    version: "1.2.0",
    author: "Genesis Official",
    description: "深入静态 AST 语法树解析与潜在并发死锁、内存泄露漏洞检测",
    readme: "### Code Analyzer\n通过 Genesis 异步隔离沙箱，在独立无特权进程中解析源码结构。",
    permissions: ["exec:sandbox", "read:file"],
    downloads: 1420,
  },
  {
    id: "sec-scanner",
    name: "Sec Scanner",
    category: "代码审查",
    type: "skill",
    scope: "system",
    iconType: "code",
    version: "2.1.0",
    author: "SecOps",
    description: "扫描代码中硬编码的 API Key、私钥凭证与 SQL 注入风险点",
    readme: "### Security Scanner\n基于静态污点追踪算法检测敏感机密与已知 CVE 漏洞模式。",
    permissions: ["read:file", "exec:sandbox"],
    downloads: 3120,
  },
  {
    id: "github-mcp",
    name: "GitHub MCP Server",
    category: "系统集成",
    type: "mcp",
    scope: "system",
    iconType: "git",
    version: "0.8.0",
    author: "Model Context Protocol",
    description: "通过标准 MCP 协议连接 GitHub 远程 API，创建 Issue、拉取 PR 与代码检索",
    readme: "### GitHub MCP Server\n符合 JSON-RPC 2.0 规范的官方远程 MCP 工具集。",
    permissions: ["mcp:remote", "net:egress"],
    downloads: 4800,
  },
  {
    id: "postgres-mcp",
    name: "PostgreSQL Probe",
    category: "系统集成",
    type: "mcp",
    scope: "system",
    iconType: "database",
    version: "1.1.0",
    author: "Model Context Protocol",
    description: "连接数据库元数据，安全执行只读 SQL 查询与表结构 Schema 探测",
    readme: "### PostgreSQL MCP Server\n安全的只读探测器，自动剥离写操作。",
    permissions: ["db:query", "mcp:remote"],
    downloads: 2900,
  },
];

const INITIAL_MCP_SERVERS: McpServerConfig[] = [
  {
    id: "mcp-github",
    name: "GitHub Official Server",
    type: "remote_url",
    endpoint: "https://mcp.github.com/v1/sse",
    status: "online",
    tools: [
      {
        name: "create_issue",
        description: "在指定仓库创建跟踪 Issue",
        enabled: true,
      },
      {
        name: "get_pull_request",
        description: "获取特定 PR 的审查评论与 Diff",
        enabled: true,
      },
      {
        name: "search_code",
        description: "在组织全库中正则检索代码定义",
        enabled: false,
      },
    ],
  },
  {
    id: "mcp-postgres",
    name: "Supabase Postgres Probe",
    type: "local_command",
    endpoint: "npx -y @modelcontextprotocol/server-postgres",
    status: "online",
    tools: [
      {
        name: "query_schema",
        description: "获取数据库所有表结构与外键关联",
        enabled: true,
      },
      {
        name: "explain_query",
        description: "执行 EXPLAIN ANALYZE 评估查询代价",
        enabled: true,
      },
    ],
  },
  {
    id: "mcp-filesystem",
    name: "Local Filesystem Watcher",
    type: "local_command",
    endpoint: "npx -y @modelcontextprotocol/server-filesystem /tmp",
    status: "offline",
    tools: [
      {
        name: "read_file",
        description: "读取指定白名单路径的本地文本",
        enabled: false,
      },
    ],
  },
];

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  plugins: INITIAL_PLUGINS,
  installedPluginIds: [
    "frontend-skill",
    "hatch-pet",
    "image-gen",
    "karpathy-guidelines",
    "openai-docs",
    "petpal",
  ],
  autoTriggerMap: {
    "frontend-skill": true,
    "hatch-pet": true,
    "image-gen": true,
    "karpathy-guidelines": true,
    "openai-docs": true,
    "petpal": true,
  },
  mcpServers: INITIAL_MCP_SERVERS,
  isMcpDrawerOpen: false,

  installPlugin: async (id: string) => {
    // 模拟网络装载延迟
    await new Promise((r) => setTimeout(r, 600));
    set((state) => ({
      installedPluginIds: [...state.installedPluginIds, id],
      autoTriggerMap: { ...state.autoTriggerMap, [id]: true },
    }));
  },

  uninstallPlugin: async (id: string) => {
    await new Promise((r) => setTimeout(r, 400));
    set((state) => ({
      installedPluginIds: state.installedPluginIds.filter((pId) => pId !== id),
    }));
  },

  toggleAutoTrigger: (id: string) => {
    set((state) => ({
      autoTriggerMap: {
        ...state.autoTriggerMap,
        [id]: !state.autoTriggerMap[id],
      },
    }));
  },

  openMcpDrawer: () => set({ isMcpDrawerOpen: true }),
  closeMcpDrawer: () => set({ isMcpDrawerOpen: false }),

  toggleMcpTool: (serverId: string, toolName: string) => {
    set((state) => ({
      mcpServers: state.mcpServers.map((server) => {
        if (server.id !== serverId) return server;
        return {
          ...server,
          tools: server.tools.map((t) =>
            t.name === toolName ? { ...t, enabled: !t.enabled } : t
          ),
        };
      }),
    }));
  },

  refreshMcpServer: async (serverId: string) => {
    set((state) => ({
      mcpServers: state.mcpServers.map((s) =>
        s.id === serverId ? { ...s, status: "connecting" } : s
      ),
    }));

    await new Promise((r) => setTimeout(r, 800));

    set((state) => ({
      mcpServers: state.mcpServers.map((s) =>
        s.id === serverId ? { ...s, status: "online" } : s
      ),
    }));
  },

  addMcpServer: (serverData) => {
    const newServer: McpServerConfig = {
      ...serverData,
      id: `mcp-${Date.now()}`,
      status: "online",
      tools: [
        {
          name: "default_probe",
          description: "探测默认连接能力",
          enabled: true,
        },
      ],
    };
    set((state) => ({
      mcpServers: [...state.mcpServers, newServer],
    }));
  },

  removeMcpServer: (serverId: string) => {
    set((state) => ({
      mcpServers: state.mcpServers.filter((s) => s.id !== serverId),
    }));
  },
}));
