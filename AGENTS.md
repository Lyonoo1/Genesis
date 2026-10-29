# ⚠️ 双端兼容核心开发守则 (Web & Desktop Dual-Platform Rules)

> **最高约束**：本项目同时维护 **Web 浏览器端 (`Genesis/web` + `api`)** 与 **本地桌面端 (`genesis-desktop`)** 两种交付形态。
> **任何代码修改、功能新增或重构，默认必须同时兼容两端，严禁破坏任一端的运行与构建！**

---

## 一、 架构认知与分工边界

| 维度 | Web 浏览器端 | 本地桌面端 (genesis-desktop) |
| :--- | :--- | :--- |
| **运行宿主** | Chrome / Safari / Edge 浏览器 | Electron 33 原生窗口 (Chromium) |
| **前端交付形式**| Next.js 14 完整构建 (带 basePath 支持) | Next.js 静态导出 (`output: 'export'`, `web/out`) |
| **后端运行机制**| 独立部署 / Docker / 云端 FastAPI | PyInstaller 编译为二进制 (`genesis-engine`) 作为 Sidecar 本地伴生启动 |
| **数据持久化** | PostgreSQL / Supabase 或本地 SQLite | 本地 SQLite (强制重定向至用户系统 AppData / Application Support) |
| **文件与系统调用**| 受限沙箱；依赖 File System Access API 或 Genesis Bridge | 本地环境直接调用；FastAPI 本地直接读写与执行 shell |

---

## 二、 修改前必知与硬性红线

### 1. 前端禁区 (`Genesis/web`)
* **严禁编写动态 Next.js API Routes**：
  * ❌ 严禁在 `web/src/app/api/...` 中编写依赖 Node.js runtime 的服务端接口。
  * ✅ 所有接口、数据交互、流式通信必须收敛在 FastAPI (`Genesis/api`) 中。因为桌面端打包使用 `DESKTOP_BUILD=true next build` 导出纯静态 HTML/JS/CSS，任何 Node 动态路由都会导致打包彻底崩溃。
* **严禁硬编码绝对 URL / 路径**：
  * Web 端可能挂载在 `/genesis` 二级目录（Nginx 反代），而桌面端运行在根路径 `""`。
  * 页面跳转与资源加载必须使用 Next.js `<Link>` / `router.push` 或结合环境变量 `process.env.NEXT_PUBLIC_BASE_PATH`。
* **文件系统交互需做双端抽象**：
  * 浏览器端调用原生 `showDirectoryPicker` 时，需考虑安全上下文限制与降级处理。
  * 涉及本地特殊能力（如调用本地应用、原生菜单、系统通知）时，必须通过环境变量或 `window.electronAPI` 做平台特性分支，严禁无检查直接假定处于单一环境。

### 2. 后端与数据层禁区 (`Genesis/api`)
* **数据库变更必须双模兼容 (SQLite + PostgreSQL)**：
  * 桌面端强制使用 SQLite，Web 端支持 SQLite 与 PostgreSQL (Supabase)。
  * ❌ 严禁引入仅 PostgreSQL 支持而 SQLite 不兼容的高级特性（如专有锁语法、特定的 JSON 操作符、特有类型转换），除非在 ORM/迁移层做了降级处理。
* **数据目录必须动态适配**：
  * ❌ 严禁把数据库或配置写死在当前工作目录相对路径 `./data.db`（桌面端安装到系统只读目录如 `/Applications` 或 `Program Files` 时会导致写权限报错崩溃）。
  * ✅ 必须使用 `appdirs` / `platformdirs` 将本地单机数据存放在用户可写目录（macOS: `~/Library/Application Support/Genesis`, Windows: `%APPDATA%/Genesis`）。

### 3. 依赖与打包禁区
* **Python 新增依赖必须评估 PyInstaller 兼容性**：
  * 在 `Genesis/api` 新增第三方库后，必须评估该库是否包含 C 扩展、动态模块加载或外部资源文件。
  * 若新增了类似 `playwright`, `cffi`, `grpc`, `onnxruntime` 等动态加载模块，**必须同步在 `genesis-desktop/pyinstaller.spec` 的 `hiddenimports` 或 `datas` 中显式登记**，避免桌面端打包后运行静默报 `ModuleNotFoundError`。
* **进程清理与子进程管理**：
  * 在后端创建的任何后台进程、终端 PTY、长连接任务，必须提供优雅退出清理机制，确保 Electron 退出触发 `tree-kill` 时能连根销毁，不残留孤儿进程占用端口。

---

## 三、 代码提交前强制验证流水线 (Verification Checklist)

任何涉及业务逻辑、前端页面或后端接口的修改，在宣称完成前，**必须在终端依次执行并通过以下两道校验**：

```bash
# 1. 验证普通 Web 端编译通过
cd /Users/lyon/Desktop/agentProject/Genesis/web && pnpm build

# 2. 验证桌面端静态 Export 编译无死角
cd /Users/lyon/Desktop/agentProject/Genesis/web && npx cross-env DESKTOP_BUILD=true pnpm build
```

> [!CAUTION]
> 只要上述步骤 2 失败（如出现 `Static Export Error`, `Page with dynamic server-side data cannot be exported`），说明修改破坏了桌面端兼容性，必须立刻修正，绝不可带病合并。
