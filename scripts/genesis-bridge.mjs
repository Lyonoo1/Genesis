#!/usr/bin/env node

/**
 * Genesis Local Bridge CLI (全功能反向长连接隧道客户端)
 * 
 * 作用：建立访客本地 Mac/PC 与云端 Genesis AI Agent 的双向加密安全隧道。
 * 允许云端智能体：
 * 1. 实时读取、写入和精确修改本地物理文件
 * 2. 检索工作区文件内容 (grepSearch) 与定位文件 (findByName)
 * 3. 提取完整目录树供右栏工作台实时浏览
 * 4. 在本地执行 Shell 终端指令 (npm test, git diff, npm run dev 等)
 * 
 * 零额外依赖：基于 Node.js 18+ 原生内置 WebSocket 与文件系统 API 运行。
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";

const CONFIG_DIR = path.join(os.homedir(), ".genesis");
const SAVED_TOKEN_FILE = path.join(CONFIG_DIR, "bridge_token");

function getSavedToken() {
  try {
    if (fsSync.existsSync(SAVED_TOKEN_FILE)) {
      return fsSync.readFileSync(SAVED_TOKEN_FILE, "utf-8").trim();
    }
  } catch {}
  return "";
}

function saveToken(token) {
  try {
    if (!fsSync.existsSync(CONFIG_DIR)) {
      fsSync.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    fsSync.writeFileSync(SAVED_TOKEN_FILE, token, { encoding: "utf-8", mode: 0o600 });
  } catch {}
}

// ── 命令行参数解析 ──
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    server: process.env.GENESIS_SERVER || "http://124.221.147.57/genesis",
    token: process.env.GENESIS_TOKEN || getSavedToken() || "",
    dir: process.env.GENESIS_DIR || process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--server" || arg === "-s") {
      options.server = args[++i];
    } else if (arg === "--token" || arg === "-t") {
      options.token = args[++i];
      if (options.token) {
        saveToken(options.token);
      }
    } else if (arg === "--dir" || arg === "-d") {
      options.dir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
\x1b[1mGenesis Local Bridge\x1b[0m - 本地反向长连接隧道

\x1b[36m使用方法:\x1b[0m
  node scripts/genesis-bridge.mjs [选项]

\x1b[36m选项:\x1b[0m
  -s, --server <url>   Genesis 服务端地址 (默认: http://124.221.147.57)
  -t, --token <jwt>    Genesis 登录用户的 JWT Token 凭证 (提供一次后将自动保存在本地)
  -d, --dir <path>     允许云端 Agent 操作的本地工作区目录 (默认: 当前执行目录)
  -h, --help           查看帮助文档

\x1b[36m示例:\x1b[0m
  node scripts/genesis-bridge.mjs --token eyJhb... --dir ~/Desktop/my-project
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
  console.error("请前往 Genesis 网页端「设置 -> Bridge」页面复制你的登录 Token。");
  console.error("\x1b[33m运行示例:\x1b[0m");
  console.error(`  node scripts/genesis-bridge.mjs --server ${config.server} --token <你的Token> --dir ${WORKSPACE_ROOT}\n`);
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

const IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".DS_Store",
  ".turbo",
  ".cache",
  ".output",
  ".genesis",
  ".genesis_outputs",
]);

// 递归构建目录树
async function buildTree(baseDir, currentDir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return [];
  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    const nodes = [];
    for (const entry of entries) {
      if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, full).split(path.sep).join("/");

      if (entry.isDirectory()) {
        const children = await buildTree(baseDir, full, depth + 1, maxDepth);
        nodes.push({
          name: entry.name,
          path: relPath,
          kind: "directory",
          children,
        });
      } else if (entry.isFile()) {
        let size = 0;
        try {
          const stat = await fs.stat(full);
          size = stat.size;
        } catch {}
        nodes.push({
          name: entry.name,
          path: relPath,
          kind: "file",
          size,
        });
      }
    }
    return nodes;
  } catch {
    return [];
  }
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

  // 5. 遍历目录平铺列表
  "fs.listDir": async ({ path: dirPath = ".", recursive = false }) => {
    const target = resolveSafePath(dirPath);
    
    async function scan(currentDir, isRec) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = path.join(currentDir, entry.name);
        const isDir = entry.isDirectory();
        items.push({
          name: entry.name,
          path: path.relative(WORKSPACE_ROOT, full).split(path.sep).join("/"),
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

  // 6. 获取完整多级文件树 (供工作台 FileExplorer 渲染)
  "fs.getTree": async ({ max_depth = 6 } = {}) => {
    const tree = await buildTree(WORKSPACE_ROOT, WORKSPACE_ROOT, 0, max_depth);
    return { success: true, tree };
  },

  // 7. 内容关键词或正则表达式检索
  "fs.grepSearch": async ({
    query,
    path: searchRel = ".",
    case_sensitive = false,
    is_regex = false,
    max_results = 50,
  }) => {
    if (!query) return { success: false, error: "检索关键词 query 不能为空" };
    const target = resolveSafePath(searchRel);

    let regex = null;
    if (is_regex) {
      try {
        regex = new RegExp(query, case_sensitive ? "g" : "gi");
      } catch (e) {
        return { success: false, error: `无效正则表达式: ${e.message}` };
      }
    }

    const matches = [];
    let filesScanned = 0;
    const maxFilesScanned = 1500;

    async function walk(dir, depth = 0) {
      if (depth > 8 || matches.length >= max_results || filesScanned >= maxFilesScanned) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= max_results || filesScanned >= maxFilesScanned) break;
        if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          filesScanned++;
          try {
            const stat = await fs.stat(full);
            if (stat.size > 2 * 1024 * 1024) continue;
            const content = await fs.readFile(full, "utf-8");
            const lines = content.split(/\r?\n/);
            const relFile = path.relative(WORKSPACE_ROOT, full).split(path.sep).join("/");
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= max_results) break;
              const line = lines[i];
              let isMatch = false;
              if (is_regex && regex) {
                isMatch = regex.test(line);
                regex.lastIndex = 0;
              } else if (!case_sensitive) {
                isMatch = line.toLowerCase().includes(query.toLowerCase());
              } else {
                isMatch = line.includes(query);
              }
              if (isMatch) {
                matches.push({
                  file: relFile,
                  line_number: i + 1,
                  line_content: line.slice(0, 300).trim(),
                });
              }
            }
          } catch {}
        }
      }
    }

    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { success: false, error: `检索路径不存在: ${searchRel}` };
    if (stat.isFile()) {
      const content = await fs.readFile(target, "utf-8");
      const lines = content.split(/\r?\n/);
      const relFile = path.relative(WORKSPACE_ROOT, target).split(path.sep).join("/");
      for (let i = 0; i < lines.length && matches.length < max_results; i++) {
        const line = lines[i];
        let isMatch = is_regex && regex ? regex.test(line) : (!case_sensitive ? line.toLowerCase().includes(query.toLowerCase()) : line.includes(query));
        if (isMatch) {
          matches.push({ file: relFile, line_number: i + 1, line_content: line.slice(0, 300).trim() });
        }
      }
    } else {
      await walk(target);
    }

    console.log(`\x1b[34m[关键词检索]\x1b[0m "${query}" (匹配 ${matches.length} 处)`);
    return {
      success: true,
      query,
      total_matches: matches.length,
      matches,
      truncated: matches.length >= max_results || filesScanned >= maxFilesScanned,
    };
  },

  // 8. 按文件名或通配符查找文件
  "fs.findByName": async ({
    pattern = "*",
    path: searchRel = ".",
    type = "any",
    max_results = 50,
  }) => {
    if (!pattern) return { success: false, error: "搜索模式 pattern 不能为空" };
    const target = resolveSafePath(searchRel);

    function globToRegex(pat) {
      if (pat === "*") return /.*/;
      const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      return new RegExp(`^${escaped}$`, "i");
    }
    const reg = globToRegex(pattern);
    const matches = [];

    async function walk(dir, depth = 0) {
      if (depth > 8 || matches.length >= max_results) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= max_results) break;
        if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        const isFile = entry.isFile();
        const relPath = path.relative(WORKSPACE_ROOT, full).split(path.sep).join("/");

        let matchesType = false;
        if (type === "any") matchesType = true;
        else if (type === "dir" || type === "directory") matchesType = isDir;
        else if (type === "file") matchesType = isFile;

        if (matchesType && reg.test(entry.name)) {
          let size = 0;
          if (isFile) {
            try {
              const stat = await fs.stat(full);
              size = stat.size;
            } catch {}
          }
          matches.push({
            name: entry.name,
            path: relPath,
            is_dir: isDir,
            size,
          });
        }

        if (isDir) {
          await walk(full, depth + 1);
        }
      }
    }

    await walk(target);
    console.log(`\x1b[34m[文件查找]\x1b[0m "${pattern}" (找到 ${matches.length} 个结果)`);
    return {
      success: true,
      pattern,
      total_matches: matches.length,
      matches,
      truncated: matches.length >= max_results,
    };
  },

  // 9. 本地执行 Shell 命令
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

  // 10. 心跳保活
  "bridge.ping": async () => {
    return { pong: Date.now() };
  },
};

// ── 格式化 WebSocket URL ──
function getWsUrl(serverUrl, token) {
  let url = serverUrl.replace(/^http(s)?:\/\//, (m) => (m.startsWith("https") ? "wss://" : "ws://"));
  url = url.replace(/\/+$/, "");
  const needsGenesis = (url.includes("124.221.147.57") || url.includes("petpalapp.cn")) && !url.includes("/genesis");
  const prefix = needsGenesis ? "/genesis" : "";
  return `${url}${prefix}/api/bridge/ws?token=${encodeURIComponent(token)}`;
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
      console.log(`  工作区挂载目录: ${WORKSPACE_ROOT}`);
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
