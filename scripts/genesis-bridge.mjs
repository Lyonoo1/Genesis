#!/usr/bin/env node

/**
 * Genesis Local Bridge CLI (全功能反向隧道客户端)
 * 
 * 作用：建立访客本地 Mac/PC 与云端 Genesis AI Agent 的双向加密安全隧道。
 * 允许云端智能体：
 * 1. 实时读取、写入和精确修改本地物理文件
 * 2. 在本地执行 Shell 终端指令 (npm test, git diff, npm run dev 等)
 * 
 * 零额外依赖：基于 Node.js 18+ 原生内置 WebSocket 与文件系统 API 运行。
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec, spawn } from "node:child_process";

// ── 命令行参数解析 ──
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    server: process.env.GENESIS_SERVER || "http://localhost:8000",
    token: process.env.GENESIS_TOKEN || "",
    dir: process.env.GENESIS_DIR || process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--server" || arg === "-s") {
      options.server = args[++i];
    } else if (arg === "--token" || arg === "-t") {
      options.token = args[++i];
    } else if (arg === "--dir" || arg === "-d") {
      options.dir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Genesis Local Bridge - 本地反向长连接隧道

使用方法:
  npx genesis-bridge [选项]
  node scripts/genesis-bridge.mjs [选项]

选项:
  -s, --server <url>   Genesis 服务端地址 (默认: http://localhost:8000)
  -t, --token <jwt>    Genesis 登录用户的 JWT Token凭证 (必须提供)
  -d, --dir <path>     允许云端 Agent 访问操作的本地工作区目录 (默认: 当前目录)
  -h, --help           查看帮助文档

示例:
  node scripts/genesis-bridge.mjs --server https://genesis.example.com --token eyJhb... --dir ~/code/my-app
      `);
      process.exit(0);
    }
  }

  return options;
}

const config = parseArgs();
const WORKSPACE_ROOT = path.resolve(config.dir);

if (!config.token) {
  console.error("\x1b[31m[错误] 必须提供身份凭证 --token <jwt>\x1b[0m");
  console.error("请前往 Genesis 网页端「设置」页面复制你的登录 Token。");
  process.exit(1);
}

if (!fsSync.existsSync(WORKSPACE_ROOT)) {
  console.error(`\x1b[31m[错误] 指定的工作区目录不存在: ${WORKSPACE_ROOT}\x1b[0m`);
  process.exit(1);
}

// ── 安全路径解析防穿越 ──
function resolveSafePath(relPath) {
  const clean = (relPath || "").trim();
  const target = path.resolve(WORKSPACE_ROOT, clean);
  if (!target.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`安全策略拦截：禁止越权访问工作区外部路径 '${relPath}'`);
  }
  return target;
}

// ── RPC 方法分拣执行 ──
const RPC_HANDLERS = {
  // 1. 读取文件
  "fs.readFile": async ({ path: filePath }) => {
    const target = resolveSafePath(filePath);
    const content = await fs.readFile(target, "utf-8");
    return { success: true, content, path: filePath };
  },

  // 2. 写入文件
  "fs.writeFile": async ({ path: filePath, content }) => {
    const target = resolveSafePath(filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    console.log(`\x1b[32m[文件写入]\x1b[0m ${filePath}`);
    return { success: true, path: filePath, bytes: Buffer.byteLength(content, "utf-8") };
  },

  // 3. 行级/字符串差异替换
  "fs.editFile": async ({ path: filePath, old_string, new_string }) => {
    const target = resolveSafePath(filePath);
    const content = await fs.readFile(target, "utf-8");
    if (!content.includes(old_string)) {
      return { success: false, error: "未在目标文件中匹配到待替换的内容 old_string" };
    }
    const updated = content.replace(old_string, new_string);
    await fs.writeFile(target, updated, "utf-8");
    console.log(`\x1b[33m[文件修改]\x1b[0m ${filePath}`);
    return { success: true, path: filePath };
  },

  // 4. 删除文件
  "fs.deleteFile": async ({ path: filePath }) => {
    const target = resolveSafePath(filePath);
    await fs.unlink(target);
    console.log(`\x1b[31m[文件删除]\x1b[0m ${filePath}`);
    return { success: true, path: filePath };
  },

  // 5. 遍历目录
  "fs.listDir": async ({ path: dirPath = ".", recursive = false }) => {
    const target = resolveSafePath(dirPath);
    const ignores = new Set([".git", "node_modules", ".next", ".venv", "__pycache__", "dist", "build"]);
    
    async function scan(currentDir, isRec) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (ignores.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        const isDir = entry.isDirectory();
        items.push({
          name: entry.name,
          path: path.relative(WORKSPACE_ROOT, full),
          is_dir: isDir,
        });
        if (isRec && isDir && items.length < 200) {
          const sub = await scan(full, true);
          items.push(...sub);
        }
      }
      return items;
    }

    const items = await scan(target, Boolean(recursive));
    return { success: true, items: items.slice(0, 300) };
  },

  // 6. 本地执行 Shell 命令
  "shell.execute": async ({ command, timeout = 60 }) => {
    console.log(`\x1b[36m[命令执行]\x1b[0m ${command}`);
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: WORKSPACE_ROOT,
          timeout: timeout * 1000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            resolve({
              success: false,
              error: `执行超时 (超过 ${timeout} 秒)`,
              stdout,
              stderr,
              exit_code: 124,
            });
            return;
          }
          resolve({
            success: !error,
            stdout: stdout || "",
            stderr: stderr || "",
            exit_code: error ? error.code || 1 : 0,
          });
        }
      );
    });
  },

  // 7. 心跳保活
  "bridge.ping": async () => {
    return { pong: Date.now() };
  },
};

// ── 格式化 WebSocket URL ──
function getWsUrl(serverUrl, token) {
  let url = serverUrl.replace(/^http(s)?:\/\//, (m) => (m.startsWith("https") ? "wss://" : "ws://"));
  url = url.replace(/\/+$/, "");
  return `${url}/api/bridge/ws?token=${encodeURIComponent(token)}`;
}

// ── 建立反向长连接隧道 ──
function connect() {
  const wsUrl = getWsUrl(config.server, config.token);
  console.log(`\n\x1b[1m⚡ 正在连接 Genesis 云端网关...\x1b[0m`);
  console.log(`  - 目标地址: ${config.server}`);
  console.log(`  - 本地工作区: ${WORKSPACE_ROOT}\n`);

  const ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    console.log("\x1b[32m✔ 物理连接握手成功，正在注册本地节点元数据...\x1b[0m");
    const hello = {
      type: "bridge_hello",
      metadata: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        cwd: WORKSPACE_ROOT,
        node_version: process.version,
      },
    };
    ws.send(JSON.stringify(hello));
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "bridge_ready") {
      console.log(`\x1b[32m✔ 隧道已就绪！云端 Agent 现在可以实时编辑与操作你的本地代码。\x1b[0m`);
      console.log(`  保持当前终端运行，按 Ctrl+C 可断开。\n`);
      return;
    }

    const { id, method, params } = msg;
    if (!id || !method) return;

    const handler = RPC_HANDLERS[method];
    let result = null;
    let error = null;

    if (!handler) {
      error = `未知的方法指令: ${method}`;
    } else {
      try {
        result = await handler(params || {});
      } catch (err) {
        error = err.message || String(err);
      }
    }

    // 回传 RPC 结果给云端
    ws.send(
      JSON.stringify({
        id,
        result,
        error,
      })
    );
  });

  ws.addEventListener("close", (event) => {
    console.log(`\x1b[33m! 隧道连接已断开 (code: ${event.code})，5秒后自动重连...\x1b[0m`);
    setTimeout(connect, 5000);
  });

  ws.addEventListener("error", (err) => {
    console.error(`\x1b[31m[连接异常]\x1b[0m ${err.message || "无法连接到云端网关"}`);
  });
}

connect();
