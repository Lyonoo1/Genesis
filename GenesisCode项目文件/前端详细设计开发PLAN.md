# Genesis AI 智能体工作台 - 前端详细设计与开发施工图 (FRONTEND_PLAN)

> **项目名称**: Genesis (GenesisCode)  
> **文档性质**: 前端唯一完整施工规范（供 AI 辅助开发工具与工程师直接读取并按部就班施工）。  
> **设计美学**: 融合 **OpenAI Codex 的工业精密极客感 (Code-native / Precision)** 与 **Anthropic Claude 的智性排版阅读质感 (Typographic Restraint)**，打造去修饰化、极度克制、高密度、零干扰的沉浸式 Agent 工作台。

---

## ⚠️ 0. AI 自动执行铁律 (Execution Protocol & Checkpoints)

**所有阅读或执行本文档的 AI 编程助手（Cursor / Claude Code 等）必须无条件遵循以下规则：**

1. **严格按任务顺序单向推进 (Strict Sequential Execution)**:
   - 本文档被严格拆分为 **FE-Step 1 至 FE-Step 6** 共 6 个阶段任务。
   - 必须先完全实现当前 Step 所包含的所有页面、组件、布局及状态，并在本地验证通过后，方可进入下一个 Step。**绝对禁止跳步或并行开发多个 Step**。
2. **强制暂停与确认机制 (Mandatory Check-in Checkpoint)**:
   - **每完成一个 Step，AI 必须立刻停下！禁止自动向下写下一个 Step 的代码！**
   - AI 必须向用户输出汇报：
     - 已完成的模块名称与具体文件清单；
     - 当前模块的核心实现要点与自测验证方法；
     - 下一个 Step 的开发预告；
     - **最后必须显式向用户提出询问：“当前 [FE-Step X] 已全部完成并验证通过，请问是否继续进行下一个任务？”**
   - **必须等待用户给出明确的肯定指令（如“继续”、“进行下一步”）后，AI 才能开始编写下一个 Step 的任何代码。**
3. **任务完成即时回写状态与断点续做 (State Persistence & Resume Protocol)**:
   - **完成即回写**: 每一个 Step 完成且经用户确认后，AI **必须主动调用文件编辑工具更新本文档下方的【前端任务开发进度看板】**，将当前 Step 的状态从 `[ ] 待开始` 变更为 `[x] 已完成 ✅`。
   - **新会话断点续做**: 当用户把本文档投喂给一个新的 AI 对话窗口时，AI **必须首先阅读【开发进度看板】，自动跳过所有已标记为 `[x] 已完成` 的步骤**，直接定位到第一个处于 `[ ] 待开始` 的步骤向用户汇报并请示开发，严禁从头重复编写已完成的内容！
4. **视觉细节与设计规范遵从**:
   - 必须严格遵从本文档第 1 节定义的 Genesis 专属色彩、材质、边框、字体与微交互规范，严禁使用廉价模板自带的五彩斑斓渐变、粗笨边框或微信式大圆角气泡。

### 📋 前端任务开发进度看板 (Progress Dashboard)
> **AI 必读执行入口**: 启动开发或开启新会话时，直接跳过已勾选 `[x]` 的任务，自动定位到第一个未勾选 `[ ]` 的任务向用户请示。每完成一个任务并获确认，立即将对应项勾选为 `[x]` 并注明完成状态！

- [x] **FE-Step 1**: Genesis 基础设施、Design Tokens 与三栏布局画卷 `(状态: 已完成 ✅)`
- [ ] **FE-Step 2**: Genesis 侧边栏与会话状态精细交互 (useSessionStore) `(状态: 待开始)`
- [ ] **FE-Step 3**: Genesis 主对话区与智性阅读渲染器 (Messages & AST) `(状态: 待开始)`
- [ ] **FE-Step 4**: Agent 核心物料 (Tool 折叠舱 + 命令中枢 + 粘滞算法) `(状态: 待开始)`
- [ ] **FE-Step 5**: SSE 全双工流通信、分支截断与会话熔断 (useChatStore) `(状态: 待开始)`
- [ ] **FE-Step 6**: Genesis 应用市场、MCP 抽屉面板与设置中心 `(状态: 待开始)`

---

## 1. Genesis 视觉设计语言与设计系统规范 (Genesis Design Spec)

### 1.1 色彩与表面材质阶梯 (Surfaces & Materials)
* **暗岩深空基底 (Void Surface)**: `#0B0D11`。全局最底层画布背景，带有极弱的冷灰蓝调，深邃且不刺眼，杜绝生硬的纯黑 `#000000`。
* **侧边栏微表面 (Sidebar Surface)**: `#0F1218`。比基底微亮半个色阶，形成天然的侧边视觉分割。
* **浮层与卡片表面 (Elevated Surface)**: `#151821`。用于弹窗 Modal、下拉选单、输入框底座，辅以 `backdrop-blur-xl` 微晶质磨砂效果。
* **单像素发丝边框 (Hairline Border)**: 全局统一采用 `1px solid rgba(255, 255, 255, 0.08)`。鼠标悬停交互元素时平滑过渡至 `rgba(255, 255, 255, 0.16)`，提供精密工业仪器的装配接缝感。
* **文本阶梯色彩**:
  * 一级正文/标题 (Primary): `#F3F4F6` (Zinc-100)，高对比度清晰呈现；
  * 二级说明/次要信息 (Secondary): `#9CA3AF` (Zinc-400)，沉稳内敛；
  * 三级标注/占位符 (Muted/Placeholder): `#4B5563` (Zinc-600)；
  * 终端代码正文 (Code Base): `#E5E7EB` (Zinc-200)。
* **Agent 状态指示强调色 (Functional Accent - 极度克制，仅作状态指示)**:
  * **极客冰川青 (Terminal Cyan)**: `#22D3EE`。用于当前激活的 Tool 状态、代码流式高亮、微小脉冲点；
  * **创世琥珀金 (Genesis Amber)**: `#F59E0B`。用于 Skill 胶囊标签、权限警告、Token 成本警示；
  * **工匠翠绿 (Success Emerald)**: `#10B981`。用于执行成功勾选、Server 在线状态；
  * **预警珊瑚红 (Danger Coral)**: `#F43F5E`。用于子进程报错、连接中断、删除高危操作。

### 1.2 双排版系统 (Dual Typography Architecture)
1. **界面控件与系统信息**: 采用现代高可读性无衬线字体（Geist Sans / Inter / -apple-system），字号克制在 12px~14px，常规字重 400 与微加粗 500，杜绝大面积粗体。
2. **AI 生成正文 (Claude 纸质智性阅读感)**: 默认采用精选衬线体（Newsreader / Lora / Georgia），字号 16px，设置 1.75 倍行高与 0.01em 宽松字间距。大段架构方案与代码解释读起来如同精密纸质技术白皮书。
3. **工具参数与代码 (Codex 终端代码感)**: 统一采用等宽字体（Geist Mono / JetBrains Mono），字号 13px，紧凑行高 1.5，字符清晰连字。

### 1.3 动态密度系统 (Dynamic Density System)
通过根节点 HTML 属性 `data-density="comfortable" | "compact"` 动态切换全局间距变量：
* **舒适档 (Comfortable)**: 消息间距 24px，消息内边距 20px，输入坞下沉，适合日常深入构思与阅读；
* **紧凑档 (Compact)**: 消息间距 12px，消息内边距 12px，输入坞贴底，适合高频调试与紧凑对比代码。

---

## 2. 模块化开发施工图 (FE-Step 1 至 FE-Step 6)

```
┌─────────────────────────────────────────────────────────────┐
│  FE-Step 1: Genesis 基础设施、Design Tokens 与三栏布局画卷       │
└──────────────────────────────┬──────────────────────────────┘
                               │ (通过并确认后推进)
┌──────────────────────────────▼──────────────────────────────┐
│  FE-Step 2: Genesis 侧边栏与会话状态精细交互 (useSessionStore) │
└──────────────────────────────┬──────────────────────────────┘
                               │ (通过并确认后推进)
┌──────────────────────────────▼──────────────────────────────┐
│  FE-Step 3: Genesis 主对话区与智性阅读渲染器 (Messages & AST)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (通过并确认后推进)
┌──────────────────────────────▼──────────────────────────────┐
│  FE-Step 4: Agent 核心物料 (Tool 折叠舱 + 命令中枢 + 粘滞算法)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (通过并确认后推进)
┌──────────────────────────────▼──────────────────────────────┐
│  FE-Step 5: SSE 全双工流通信、分支截断与会话熔断 (useChatStore) │
└──────────────────────────────┬──────────────────────────────┘
                               │ (通过并确认后推进)
┌──────────────────────────────▼──────────────────────────────┐
│  FE-Step 6: Genesis 应用市场、MCP 抽屉面板与设置中心           │
└─────────────────────────────────────────────────────────────┘
```

---

### 任务 FE-Step 1: Genesis 基础设施、Design Tokens 与三栏布局画卷

#### 1. 任务目标与交付边界
* 初始化 Next.js 14 (App Router) 前端工程环境，配置 TailwindCSS 并注入第 1 节定义的 Genesis 专属 Design Tokens 变量。
* 搭建全屏响应式**三栏布局壳**：左侧固定 240px 侧边栏、顶部固定 48px 控制条、右侧中央主舞台。
* 本任务只实现静态骨架布局与主题/密度切换机制，不接入真实会话与消息数据。

#### 2. 涉及创建/修改文件
* `apps/web/app/layout.tsx` (根布局注入字体族与全局主题)
* `apps/web/app/globals.css` (注入 Genesis 色彩变量、发丝边框与极细滚动条样式)
* `apps/web/app/(main)/layout.tsx` (三栏外壳布局组件)
* `apps/web/stores/useSettingsStore.ts` (外观设置持久化：深浅模式、衬线正文切换、紧凑/舒适密度)

#### 3. 详细视觉与交互描述
* **视口与画布限制**:
  * 窗口整体锁定 `100vw * 100vh`，`overflow: hidden`，彻底杜绝浏览器原生页面级双重滚动条。
  * 背景通铺 `#0B0D11` 暗岩深空底色。文字选中文本时，高亮背景为 20% 透明度的冰川青（`#22D3EE/20`），文字颜色呈现 `#22D3EE`。
* **左侧边栏外壳 (`SidebarShell`)**:
  * 固定宽度 240px，背景色 `#0F1218`，右侧边缘贯穿一条 `1px solid rgba(255, 255, 255, 0.08)` 发丝边框。
  * 垂直方向分为三段：顶部 Brand Logo 区域（48px 高度）、中间会话滚动槽（自适应高度）、底部系统导航槽（固定高度）。
* **顶部控制条外壳 (`TopNavShell`)**:
  * 固定高度 48px，背景色为半透明深空底结合磨砂（`rgba(11, 13, 17, 0.75)` + `backdrop-blur-md`），底部横贯发丝边框。
  * 左侧对齐预留当前会话标题与已激活能力的标签展示位；右侧预留 MCP 齿轮面板开关与快捷设置入口。
* **主内容舞台 (`MainStage`)**:
  * 填满剩余空间，居中设立最大宽度为 `768px`（`max-w-3xl`）的阅读版心，左右余白自动均分，确保在任何 2K/4K 宽屏显示器下视线焦点始终处于中央舒适区。

#### 4. 本任务验收标准 (Checkpoint)
1. 页面在浏览器中加载无白色闪烁，呈现纯正暗岩色泽与精致发丝微边框。
2. 窗口拖拽缩放时，侧边栏宽度稳固，主区域自适应伸缩且绝无外层水平滚动条。
3. **执行强制暂停**: 向用户输出汇报并询问：“当前 [FE-Step 1] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 FE-Step 2: Genesis 侧边栏与会话状态精细交互 (useSessionStore)

#### 1. 任务目标与交付边界
* 完整实现 Genesis 侧边栏所有视觉元素与交互动效。
* 实现按时间自动归类分组（`今天`、`昨天`、`7天内`、`更早`）的会话列表。
* 实现高精度的列表项微交互：悬停平滑浮现更多菜单、行内原地重命名 (Inline Rename)、置顶微倾斜 Pin、删除二次确认模态窗。
* 实现顶部新建对话按钮与 300ms 防抖的会话检索框。

#### 2. 涉及创建/修改文件
* `apps/web/stores/useSessionStore.ts` (会话列表、激活 ID、创建、重命名、置顶、删除状态机)
* `apps/web/components/sidebar/Sidebar.tsx` (侧边栏整体容器装配)
* `apps/web/components/sidebar/BrandHeader.tsx` (Genesis 品牌标识)
* `apps/web/components/sidebar/NewChatButton.tsx` (新建对话按钮)
* `apps/web/components/sidebar/SessionSearchInput.tsx` (防抖搜索框)
* `apps/web/components/sidebar/SessionGroupList.tsx` (分组列表渲染)
* `apps/web/components/sidebar/SessionItem.tsx` (单条会话卡片与微交互)
* `apps/web/components/sidebar/DeleteConfirmModal.tsx` (二次确认弹窗)
* `apps/web/components/sidebar/BottomNav.tsx` (应用市场与设置入口)

#### 3. 详细视觉与交互描述
* **品牌标识 (`BrandHeader`)**:
  * 左侧展示 18px 见方的 Genesis 极简几何晶体 Logo，带有极微弱的冰川青微光发光滤镜（`drop-shadow(0 0 6px rgba(34, 211, 238, 0.4))`）。
  * 右侧为 `Genesis` 纯文字排版，采用全大写 tracking-widest（字距扩大），字号 12px，粗细 Medium，颜色为 `#F3F4F6`。
* **新建对话按钮 (`NewChatButton`)**:
  * 高度 32px，外框为发丝边框，背景为微表面底色。
  * 按钮左侧为细线加号图标，中间为“新建对话”，右侧带有微小的浅灰键盘快捷键微标 `⌘J`（Mac）或 `Ctrl+J`（Windows）。
  * 悬停态：背景过渡为 `rgba(255, 255, 255, 0.05)`，发丝边框亮度提升至 `0.16`，产生极其微妙的高亮反馈。
* **搜索框 (`SessionSearchInput`)**:
  * 高度 28px，全圆角药丸框（`rounded-md`），内置微型 12px 放大镜图标，占位提示为“搜索会话...”。
  * 用户键入字符时，通过 300ms 防抖机制即时过滤当前列表中的标题文本；若未命中任何结果，列表平滑呈现“未找到相关会话”微小提示。
* **会话列表项 (`SessionItem`) 极致微交互**:
  * 高度统一 32px，圆角 6px，左右边距内嵌 8px。
  * **默认态**: 文本呈现中性冷灰 `#9CA3AF`，单行截断文本（`truncate`）。
  * **悬停态**: 背景过渡至 `rgba(255, 255, 255, 0.04)`，文字转为 `#D1D5DB`，右侧在 150ms 内淡入浮现悬停操作按钮 `...`。
  * **当前激活态**: 背景为微高亮 `rgba(255, 255, 255, 0.08)`，左侧内边框带有一道隐蔽的 2px 冰川青竖线指示，文字高亮为纯白 `#FFFFFF`。
  * **置顶标志 (Pinned)**: 若会话被置顶，标题文字左侧常驻一个顺时针旋转 45 度的微型青色 Pin 图标，并在列表中强制排序在最高优先级。
  * **原地行内重命名 (Inline Rename)**:
    * 用户在下拉菜单点击“重命名”或双击标题时，文字原地转为 24px 高度的极简输入框，自动获取聚焦并全选原文本。
    * 输入框外圈包裹一层 `1px solid #22D3EE` 微发光边框。
    * 键盘逻辑：按下 `Enter` 立即持久化并恢复为文字；按下 `Escape` 立即放弃修改并回滚原标题；点击页面外部任何区域自动保存。
  * **删除确认弹窗 (`DeleteConfirmModal`)**:
    * 遮罩层带有 `backdrop-blur-sm bg-black/60`，居中弹出一张 320px 宽度的暗黑微表面卡片。
    * 头部标有珊瑚红警告图标与“确定删除该会话？”提示，文案明确指出“此操作将永久抹除该会话下的所有历史记录与生成产物，无法撤销”。
    * 底部右侧放置“取消”与珊瑚红高亮的“确认删除”操作按钮。
* **侧边栏底部导航 (`BottomNav`)**:
  * 固定在侧边栏最底部，上方贯穿发丝分割线。
  * 包含“应用市场”与“偏好设置”两个快捷入口，高度 36px，左侧带小图标，悬停展现淡亮背景。

#### 4. 本任务验收标准 (Checkpoint)
1. 能够通过侧边栏新建空会话，并在列表中实时以“新对话”展示。
2. 历史会话能够根据真实创建时间正确归类在“今天”、“昨天”等不同分组中。
3. 可以在会话卡片上顺畅进行：置顶/取消置顶（即时跳至顶部）、原地重命名（无卡顿无跳动）、删除（弹窗确认后移除当前项）。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [FE-Step 2] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 FE-Step 3: Genesis 主对话区与智性阅读渲染器 (Messages & AST)

#### 1. 任务目标与交付边界
* 打造 Genesis 的主对话核心舞台，建立居中 `768px` 安全阅读版心。
* **用户消息 (User)**: 右对齐、深灰极简半透明微表面卡片，悬停展示复制与编辑重发入口。
* **AI 消息 (Assistant)**: **彻底去背景、零气泡底色、零多余头像**，直接以智性衬线排版融入暗岩画布。
* **Markdown 渲染引擎**: 定制终端风格代码块（语言标签、一键复制并反馈 Copied 动效）、表格极客边框、公式渲染、`rehype-sanitize` XSS 白名单过滤。
* **防掉帧节流优化**: 针对流式打字机高频注入，采用 50ms 批量提交（RAF/Throttle），防止重复 parse Markdown AST 造成页面剧烈掉帧。

#### 2. 涉及创建/修改文件
* `apps/web/components/chat/MessageContainer.tsx` (主聊天流滚动容器)
* `apps/web/components/chat/MessageList.tsx` (消息列表流)
* `apps/web/components/chat/UserMessageItem.tsx` (用户极简气泡卡片)
* `apps/web/components/chat/AssistantMessageItem.tsx` (AI 纯粹流式画卷)
* `apps/web/components/chat/MarkdownRenderer.tsx` (Markdown 渲染调度器)
* `apps/web/components/chat/CodeBlock.tsx` (Codex 工业级代码块容器)
* `apps/web/components/chat/AssistantActionBar.tsx` (AI 消息底部操作工具栏)
* `apps/web/components/chat/ThinkingPulse.tsx` (思考中的微光呼吸动效)

#### 3. 详细视觉与交互描述
* **主视线版心 (`MessageContainer`)**:
  * 内部纵向自动滚动，水平方向无论屏幕多宽，内容均锁定在最大宽度 `768px`（`max-w-3xl`）并居中对齐。
  * 底部留有 140px 的充足空白 Padding，确保最下方的一轮对话绝不会被底部悬浮的输入中枢所遮挡。
* **用户消息形态 (`UserMessageItem`)**:
  * 整体右对齐，最大宽度收敛在 80% 以内。
  * 卡片背景为微弱的白光透明度 `rgba(255, 255, 255, 0.04)`，搭配单像素发丝边框 `border-white/[0.08]`，圆角统一为 `12px`。
  * 内部文字采用无衬线高对比度文本，字号 14px，行高 1.6，段落自然换行。
  * 悬停交互：鼠标移至卡片上方时，卡片左侧悬空处淡入浮现一个 24px 的微小按钮，包含“复制正文”与“编辑重发”小图标，点击即可触发对应操作。
* **AI 消息形态 (`AssistantMessageItem`) - Claude 智性阅读质感**:
  * **完全摒弃传统聊天气泡底色**，文字直接流淌在底色之上。左侧不放任何机器人头像，清除一切非必要的视觉杂音。
  * 正文排版：字体切换为精选纸质衬线体（Newsreader / Georgia），字号 16px，行高放大至 1.75，带来深沉专注的白皮书阅读心智。
  * 段落间距固定为 16px；引用块（Blockquote）左边缘点缀一条 2px 宽的冰川青竖线，背景不着色，文字为微倾斜中灰色。
* **Codex 工业级代码块 (`CodeBlock`)**:
  * 位于正文中的代码块采用独立的暗黑微表面容器（`#0F1218`），包裹单像素微边框与 8px 圆角。
  * **头部微型状态栏**: 高度 28px，背景为 `rgba(255, 255, 255, 0.02)`，底部一条更细的分隔线。
    * 左侧以等宽小写字体展示语言类型（如 `typescript`, `python`, `sql`），字色为高亮冰川青 `#22D3EE`；
    * 右侧放置“一键复制”按钮。点击后，图标瞬时转变为翠绿色的 Checkmark，文字转为“Copied”，持续 1.5 秒后平滑复原。
  * **代码正文**: 采用等宽字体（Geist Mono），字号 13px，语法高亮采用极简冷调配色，横向超出自动出现极细内联滚动条。
* **思考中微动效 (`ThinkingPulse`)**:
  * 当后端正在准备回复或分析工具时，占位处展示一个直径 6px 的冰川青微型圆点，伴随 1.5 秒周期的柔和呼吸发光缩放动效（Opacity 0.4 到 1.0 循环，带扩散微光晕）。
* **AI 底部行动栏 (`AssistantActionBar`)**:
  * 在 AI 完整生成完毕后，正文底部 8px 处平滑浮现一行 24px 高度的低调图标按钮组：复制整篇回复、重新生成本轮、点赞/点踩、以及右侧微小的本次回复耗时与 Token 消耗 Badge（如 `1.2s · 450 tokens`）。

#### 4. 本任务验收标准 (Checkpoint)
1. 发送一段长文本及包含 Markdown 代码块、表格的消息，AI 回复去气泡化平滑排布于版心内。
2. 代码块顶部语言标签显示正确，点击复制能成功写入剪贴板并展现 1.5s 绿色 Copied 反馈。
3. 大量文字连续流式打印时，界面无肉眼可见的排版抖动与掉帧卡顿。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [FE-Step 3] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 FE-Step 4: Agent 核心物料 (Tool 折叠舱 + 命令中枢 + 粘滞算法)

#### 1. 任务目标与交付边界
* **ToolCallAccordion (工具调用工业折叠舱)**:
  * 收起态：32px 高度的微型发丝边框胶囊卡片，左侧显示极细旋转 Spinner / 翠绿对勾，中间显示 `skill::[name]`，右侧微秒耗时与旋转 Chevron。
  * 展开态：向下平滑拉出黑色终端面板，分块格式化高亮展示 Parameters JSON 与 Output 结果。
* **ChatInputBar (悬浮命令输入中枢)**:
  * 悬浮在窗口底部的精密控制坞（`max-w-3xl` 居中），带有毛玻璃与微发光边框。
  * 多行自动弹性拉伸输入框（1~6 行高度，超出滚动，`Enter` 发送，`Shift+Enter` 换行）。
  * 键入 `/` 呼出 Raycast 风格向上弹出的 Skill 检索选单，完整拦截键盘 `上下键`、`Enter`、`Tab` 与 `Escape`。
  * 选中后输入框上方贴附不可编辑的琥珀金 Skill 胶囊 Chip。
* **粘滞滚动算法 (Sticky Scroll)**: 距离底部 `< 60px` 锁死打字机下滚，向上翻看历史代码自动解绑，并在右下角浮现“回到底部”药丸 Badge。

#### 2. 涉及创建/修改文件
* `apps/web/components/chat/ToolCallAccordion.tsx` (工具调用工业折叠卡片)
* `apps/web/components/chat/ChatInputBar.tsx` (居底悬浮命令输入坞)
* `apps/web/components/chat/SkillMentionDropdown.tsx` (Raycast 风格 "/" 快捷选单)
* `apps/web/components/chat/ActiveSkillChip.tsx` (已选 Skill 胶囊标签)
* `apps/web/components/chat/ScrollToBottomBadge.tsx` (回到底部浮动指示器)
* `apps/web/hooks/useStickyScroll.ts` (智能滚动计算 Hook)

#### 3. 详细视觉与交互描述
* **工具调用折叠卡片 (`ToolCallAccordion`)**:
  * 紧密嵌入在消息流的上下文中，左右撑满版心。
  * **收起态 (Collapsed)**:
    * 高度固定为 32px，圆角 6px，背景色 `#0F1218`，四周环绕发丝边框。
    * 左侧状态区：
      * 执行中状态：直径 12px 的超细环形 Spinner（冰川青高亮，顺时针匀速旋转）；
      * 成功状态：翠绿色实心圆点中嵌入微型白色 Check；
      * 失败状态：珊瑚红色圆点指示。
    * 标题文本：等宽字体呈现，先浅灰显示“工具调用”，再加粗呈现具体名称（如 `skill::unit-test-generator` 或 `mcp::github::create_issue`）。
    * 右侧指标区：显示耗时毫秒数（如 `340ms`，文字淡灰 11px），最右侧为 12px 细线 Chevron 箭头。
  * **展开态 (Expanded)**:
    * 点击整行，卡片高度平滑动画下垂，Chevron 顺时针旋转 90 度。
    * 下方拉出纯黑底色（`#0B0D11`）的终端展示区，包含两段内容：
      * **Parameters**: 格式化高亮的只读 JSON 参数；
      * **Execution Output**: 工具返回的内容。若返回值超过 200px 高度，内部开启自适应微滚动条，右上角附带独立的“复制输出”微型按钮。
* **悬浮命令输入中枢 (`ChatInputBar`)**:
  * 悬浮于窗口底部，距离底边 24px，水平居中限制最大宽度 `768px`。
  * 容器背景为 `rgba(11, 13, 17, 0.85)`，辅以 `backdrop-blur-xl`，外框有一道 `1px solid rgba(255, 255, 255, 0.1)` 并带有极微弱的向外扩散阴影（`shadow-2xl`）。
  * **已激活 Skill 胶囊 (`ActiveSkillChip`)**:
    * 当用户通过选单选定了某个 Skill 时，输入框内部上方自动浮现一个 22px 高度的小胶囊。
    * 胶囊背景为琥珀金半透明（`rgba(245, 158, 11, 0.15)`），边框为琥珀金发丝线，文字为 `skill:[name]`，右侧带有一个微小的 `×`，点击即可解绑并恢复通用对话。
  * **输入框文本域 (Textarea)**:
    * 默认单行高度，随着输入文字增多自然向上弹性增高，最多增至 6 行（约 144px），超出后内部开启极细平滑滚动。
    * 背景全透明，无轮廓（`outline-none`），文字为 Zinc-100，占位提示“向 Genesis 提问，或键入 '/' 调用扩展能力...”。
  * **右侧行动按钮组**:
    * 左侧为上传附件微型回形针图标；
    * 右侧为主行动按钮：
      * 文本为空时：弱化灰度纸飞机图标；
      * 文本非空时：转为冰川青高亮的高光发送图标；
      * AI 正在流式生成时：按钮平滑变形为带有红色方块警示的“停止生成”圆形按钮，点击即刻通知后端中断。
* **Raycast 风格 "/" 快捷选单 (`SkillMentionDropdown`)**:
  * 当光标在输入框内键入 `/` 时，选单立即以弹簧动效向上悬浮弹出，对齐输入框左边缘。
  * 选单背景为 `#151821`，四周发丝边框，圆角 8px，内部分为“已安装 Skill”与“MCP 工具”两个小分区。
  * **键盘全拦截状态机**:
    * 按下 `ArrowDown` / `ArrowUp`: 选单中高亮焦点项上下循环跳动（高亮项呈现 `bg-white/[0.08]`）；
    * 按下 `Enter` 或 `Tab`: 瞬间选中当前高亮项，原输入框内的 `/` 及后续字符被自动清空，转化为顶部的 Skill 胶囊 Chip，光标归位至输入框首位；
    * 按下 `Escape`: 立即关闭选单，保留输入框现有文本。
* **智能粘滞滚动算法 (`useStickyScroll`)**:
  * 实时监听视口滚动事件：计算 `scrollHeight - scrollTop - clientHeight`（离底距离）。
  * 若离底距离 `< 60px`，判定用户处于阅读最新流状态，开启粘滞锁定，每来一个字符自动跟随到底部。
  * 若离底距离 `≥ 60px`（即用户主动往上翻看历史代码或分析上文），瞬间断开粘滞锁定，新 Token 生成绝不再强行拉扯用户视野。
  * 一旦断开粘滞，视口右下角距离底部 80px 处以 Fade-in 动效浮现一个药丸形状的“回到底部”悬浮 Badge（带有微小的向下箭头与冰川青光点），点击后平滑滚动回最下方并重新绑定粘滞。

#### 4. 本任务验收标准 (Checkpoint)
1. 可以在输入框键入 `/` 并完全依靠键盘方向键与回车完成 Skill 选中，生成琥珀金 Chip。
2. 触发 Tool 调用时，能看到高度 32px 的精致小卡片展示 Spinner 动效，点击能平滑展开查看 JSON 参数。
3. 在长消息输出过程中手动向上滚动屏幕，屏幕不再被强制拖回底部；点击右下角浮现的 Badge 能平滑回弹。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [FE-Step 4] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 FE-Step 5: SSE 全双工流通信、分支截断与会话熔断 (useChatStore)

#### 1. 任务目标与交付边界
* 封装底层的生产级 `lib/api/streaming.ts`，解析后端的 7 种标准 SSE Event（`session_info`, `tool_start`, `tool_result`, `text_delta`, `usage`, `done`, `error`）。
* 在 `useChatStore` 中打通完整的流式接收、思考中、工具执行中、最终完成等多态状态流转。
* 实现**停止生成 (Stop Generation)**：点击停止按钮立即 abort 本地 fetch 并调用 `POST /api/chat/{session_id}/stop`。
* 实现**编辑重发 (Branch Truncation)**：点击任意历史提问的“编辑”，回填修改后发送，自动带入 `parent_id` 并从 UI 上截断清除后续的废弃对话分支。
* 实现**会话切换熔断保护**：在 AI 正在推流生成时，若用户在侧边栏点击切换其他会话，客户端立即终止上一会话推流并重置状态，杜绝跨会话串流。

#### 2. 涉及创建/修改文件
* `apps/web/lib/api/streaming.ts` (强类型 SSE 解析器)
* `apps/web/stores/useChatStore.ts` (聊天全局状态中心、消息树、AbortController 维护)
* `apps/web/lib/api/chat.ts` (发送消息、停止生成、分页拉取历史 HTTP 封装)

#### 3. 详细视觉与交互描述
* **7 种 SSE Event 到界面的映射时序**:
  1. `session_info`: 校验会话有效性，将当前调用的模型型号写入 store；
  2. `tool_start`: 在消息列表中立即插入一条 `ToolCallAccordion`，状态置为 `running`，Spinner 旋转；
  3. `tool_result`: 找到对应 `tool_call_id` 的卡片，状态瞬间转为 `success`，填入输出内容与耗时毫秒；
  4. `text_delta`: 找到当前的 AI 消息节点，将增量文本逐字拼入正文，并通过 50ms 节流触发渲染；
  5. `usage`: 更新本次调用的 Token 统计；
  6. `done`: 结束流状态，展示底部的复制与点赞栏；
  7. `error`: 将当前消息卡片标记为 `failed`，底部浮现珊瑚红“生成失败，点击重试”按钮，保留已有片段。
* **停止生成中断交互**:
  * 用户点击右下角红色方块“停止生成”按钮。
  * 前端触发 `AbortController.abort()` 关闭当前 SSE 连接，同时向后端发起轻量级请求 `POST /api/chat/{session_id}/stop`。
  * 页面正文立即停留在已打印的最后一个字，不清除已生成内容，底部展示“用户已手动终止生成”浅灰提示。
* **编辑重发与分支截断 (Branch Truncation)**:
  * 用户悬停在某条历史提问，点击“编辑”图标，该卡片原地变为包含原文字的 TextArea。
  * 用户修改文字后点击“重新发送”：
    * 前端在 `useChatStore` 中提取该消息的 `parent_id`；
    * 立即将消息列表中该节点之后的所有轮次消息全部从界面上清除（视觉上完成分支截断）；
    * 携带 `parent_id` 发起新的流式请求，后续生成的回复直接衔接在此节点之后。
* **会话切换熔断机制**:
  * 当用户在 Session A 正在高速打字机生成时，突然在左侧点击了 Session B：
    * 立即自动触发 Session A 的 Stop 中断，销毁其 SSE 连接；
    * 立即清空当前中央舞台的消息队列，重置所有的流式临时占位符；
    * 调用 `GET /api/chat/{session_id}/messages` 纯净拉取 Session B 的历史记录并全量渲染。

#### 4. 本任务验收标准 (Checkpoint)
1. 发送提问后，控制台接收到 `tool_start` 时界面精确挂载 Tool 折叠卡片，随后无缝过渡到正文打字机流式输出。
2. 点击停止生成按钮，推流瞬间刹车，不报未捕获的 fetch 异常，界面保留当前截断内容。
3. 编辑中间某条历史提问重发，界面下方的后续问答全被干净清除，新回复正确拼接在编辑点下方。
4. **执行强制暂停**: 向用户输出汇报并询问：“当前 [FE-Step 5] 已全部完成并验证通过，请问是否继续进行下一个任务？”

---

### 任务 FE-Step 6: Genesis 应用市场、MCP 抽屉面板与设置中心

#### 1. 任务目标与交付边界
* 实现应用市场页面 `/marketplace`：
  * **发现 Tab**: 3 列现代卡片网格，展示图标、名称、类型标签（Skill / MCP）、一句话简介；
  * **详情 Modal**: 包含 README Markdown 渲染、版本记录，以及**权限声明警示卡片 (Permission Shield)**（针对代码执行与文件读取给出琥珀色警示）；
  * **已安装 Tab**: 高密度表格清单，提供“自动触发”即时 Toggle 与二次确认卸载；
  * **我的开发 Tab**: 自研插件上传表单（校验 manifest.json 与 zip 包）。
* 实现顶部栏 MCP 连接管理抽屉 (`McpDrawer`)：
  * 从右侧滑出半透明磨砂面板，列出已配置的 Server，支持单个 Tool 的勾选与一键重新探测。
* 实现偏好设置页面 `/settings`：
  * 外观控制台（深浅模式、衬线/无衬线正文切换、紧凑/舒适密度调节）；
  * 用量仪表盘看板（当月 Token 消耗、费用预估与 Top Skill 消耗分析折线图）。

#### 2. 涉及创建/修改文件
* `apps/web/app/(main)/marketplace/page.tsx` (市场主入口与三 Tab 切换)
* `apps/web/components/marketplace/PluginCard.tsx` (插件发现卡片)
* `apps/web/components/marketplace/PluginDetailModal.tsx` (详情遮罩弹窗)
* `apps/web/components/marketplace/PermissionShield.tsx` (权限声明警示徽章)
* `apps/web/components/marketplace/UploadPluginModal.tsx` (开发者上传弹窗)
* `apps/web/components/topbar/McpDrawer.tsx` (顶部 MCP 齿轮抽屉面板)
* `apps/web/app/(main)/settings/page.tsx` (偏好设置与用量主页)
* `apps/web/components/settings/AppearancePanel.tsx` (外观控制器)
* `apps/web/components/settings/UsageDashboard.tsx` (用量分析折线看板)

#### 3. 详细视觉与交互描述
* **应用市场发现页 (`/marketplace`)**:
  * 顶部带有居中的分类 Filter Chip（`全部`, `研发工作流`, `代码审查`, `系统集成`），选中项为发丝高亮带青色小点。
  * **卡片网格 (`PluginCard`)**: 3 列等宽排布，背景为 `#12151C`，单像素微边框。
    * 卡片头部：左侧为 36px 圆角插件图标，右侧为名称与类型标签（Skill 呈现琥珀色微标，MCP 呈现冰川青微标）；
    * 卡片中间：两行截断的低调灰字简述；
    * 卡片底部：版本号（如 `v1.2.0`）与操作按钮（未安装显示“安装”，已安装显示灰度“已启用”）。
* **详情与权限弹窗 (`PluginDetailModal`)**:
  * 覆盖暗黑磨砂遮罩，弹出一张宽 600px 的卡片。
  * **权限声明微型警示舱 (`PermissionShield`)**:
    * 当插件的 manifest 中声明了 `exec:sandbox` 或 `read:file` 等高危权限时，在卡片中央以浅琥珀色半透明底色（`bg-amber-500/10`）突出显示一个警示框。
    * 标明“此插件将在隔离沙箱中执行自定义代码并读取上下文”，像手机 App 权限弹窗一样给予用户确切的安全感知。
* **MCP 顶部齿轮抽屉 (`McpDrawer`)**:
  * 点击顶部导航栏的齿轮图标，抽屉从屏幕最右侧平滑滑出（宽度 360px，`bg-[#0F1218]`，左侧一条发丝分隔线）。
  * 列出所有配置好的 Remote MCP 连接，每个连接展示：Server 标识、当前在线状态绿点、探测到的工具数量。
  * 每个工具右侧带有一个细微的 Toggle 开关，点击即刻调用 API 持久化本会话的能力开关。
* **设置与用量看板 (`/settings`)**:
  * **外观微调**: 提供即时切换单选按钮，点击“衬线正文”或“紧凑间距”，无刷新即时在全局 CSS 变量中生效，刷新后依然记住。
  * **用量折线看板 (`UsageDashboard`)**:
    * 顶部展示三个微表面指标卡：本月 Token 消耗量、本月预估费用（\$）、最高频使用的 Skill。
    * 下方绘制一条精细的单像素折线图，悬停在拐点浮现当日消耗 Tooltip。

#### 4. 本任务验收标准 (Checkpoint)
1. 市场中能顺畅切换 Tab，点击插件卡片展开详情弹窗，权限警示高保真展现。
2. 点击安装 Skill，按钮进入 Loading 态，成功后状态变更为“已安装”，已安装列表中同步出现该项。
3. 外观面板切换字号与衬线体，主对话流即时以纸质衬线渲染，用量图表正常展示数据。
4. **执行强制暂停**: 向用户输出汇报并宣布：“🎉 [FE-Step 6] 已全部完成！Genesis 前端所有 6 个阶段模块均已高质量交付并验证完毕！”

---

## 3. 开发投喂与执行守则 (Prompts & Strict Instructions)

当你在 Cursor / Claude Code 中开始前端开发时，请务必遵守：
1. **第一次只投喂本文档的第 0、1 节以及 [FE-Step 1] 的完整内容**，并附带指令：“请严格遵照 FE-Step 1 进行实现，完成后立即停下并向我提问确认。”
2. **每次推进严格核对 Checkpoint**：只有当你亲自检查过当前步骤的界面与交互，并确认无误后，再将下一个 Step 的内容投喂给 AI。
3. **保持 Design Tokens 纯净**: 绝不擅自引入未在本文档中声明的随机 Hex 颜色或混乱圆角。代码原生感、极简克制与丝滑微交互是 Genesis 永远的核心基调。
