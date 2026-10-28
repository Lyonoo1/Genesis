// File System Access API 本地工作区管理器 (IndexedDB 句柄持久化与文件 IO)

const DB_NAME = "GenesisWorkspaceDB";
const STORE_NAME = "handles";

export interface WorkspaceFileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: string;
  children?: WorkspaceFileNode[];
}

const IGNORE_PATTERNS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  ".cache",
  ".DS_Store",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  ".genesis",
  ".idea",
]);

// 1. IndexedDB 存储与提取文件句柄
async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB is not supported"));
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDirectoryHandle(
  projectId: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDirectoryHandle(
  projectId: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function removeDirectoryHandle(projectId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(projectId);
    if (projectId !== "genesis-default-workspace") {
      store.delete("genesis-default-workspace");
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface PermissionCapableHandle {
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  entries?: () => AsyncIterable<[string, FileSystemHandle]>;
}

interface WritableCapableFileHandle {
  createWritable?: () => Promise<FileSystemWritableFileStream>;
}

// 2. 权限校验与唤醒
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  requestWrite = true
): Promise<boolean> {
  try {
    const options = {
      mode: requestWrite ? "readwrite" : "read",
    } as const;
    const permHandle = handle as unknown as PermissionCapableHandle;
    if (typeof permHandle.queryPermission === "function") {
      const status = await permHandle.queryPermission(options);
      if (status === "granted") return true;
    }
    // 关键防卡死：requestPermission 必须在直接的用户手势（如点击唤醒）中触发
    // 若不是 requestWrite（即仅为后台静默探针模式），严禁调用 requestPermission，否则触发浏览器 SecurityError 导致状态冻结
    if (requestWrite && typeof permHandle.requestPermission === "function") {
      const status = await permHandle.requestPermission(options);
      return status === "granted";
    }
    return false;
  } catch {
    return false;
  }
}

// 格式化文件大小
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 3. 递归扫描本地目录树 (带深度保护、文件上限与防卡死优化)
export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  currentPath = "",
  depth = 0,
  maxDepth = 4,
  countRef = { current: 0 },
  maxFiles = 600
): Promise<WorkspaceFileNode[]> {
  if (depth > maxDepth || countRef.current >= maxFiles) {
    return [];
  }

  const nodes: WorkspaceFileNode[] = [];
  const dirHandle = handle as unknown as PermissionCapableHandle;

  if (typeof dirHandle.entries === "function") {
    try {
      for await (const [name, entry] of dirHandle.entries()) {
        if (name.startsWith(".") || IGNORE_PATTERNS.has(name)) continue;
        if (countRef.current >= maxFiles) break;

        const relPath = currentPath ? `${currentPath}/${name}` : name;
        if (entry.kind === "directory") {
          const children = await scanDirectory(
            entry as FileSystemDirectoryHandle,
            relPath,
            depth + 1,
            maxDepth,
            countRef,
            maxFiles
          );
          nodes.push({
            name,
            path: relPath,
            kind: "directory",
            children,
          });
        } else {
          countRef.current += 1;
          // 文件轻量扫描，避免对每个文件同步阻塞调用 getFile() 导致主线程严重卡顿
          nodes.push({
            name,
            path: relPath,
            kind: "file",
          });
        }
      }
    } catch (err) {
      console.warn(`扫描目录 ${currentPath || "根目录"} 异常:`, err);
    }
  }

  // 目录排前面，文件排后面，按名称排序
  return nodes.sort((a, b) => {
    if (a.kind === b.kind) return a.name.localeCompare(b.name);
    return a.kind === "directory" ? -1 : 1;
  });
}

// 格式化相对路径并防止 . 或 .. 导致 File System Access API 抛错
export function normalizeRelativePath(filePath: string): string[] {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && s !== "." && s !== "..");
}

// 4. 读取本地文件内容
export async function readLocalFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<{ content: string; size: string; name: string }> {
  let parts = normalizeRelativePath(relativePath);
  if (parts.length === 0) {
    throw new Error("无效的文件路径");
  }
  // 若首段是当前根目录名称，去除避免自身查找导致 NotFoundError
  if (parts.length > 1 && parts[0] === handle.name) {
    parts = parts.slice(1);
  }
  let currentHandle: FileSystemDirectoryHandle = handle;

  for (let i = 0; i < parts.length - 1; i++) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
  }

  const fileName = parts[parts.length - 1];
  const fileHandle: FileSystemFileHandle = await currentHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  const content = await file.text();
  return {
    content,
    size: formatBytes(file.size),
    name: file.name,
  };
}

// 5. 写入本地文件内容
export async function writeLocalFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string,
  content: string
): Promise<void> {
  let parts = normalizeRelativePath(relativePath);
  if (parts.length === 0) {
    throw new Error("无效的文件路径");
  }
  // 若首段是当前根目录名称，去除避免自身查找导致 NotFoundError
  if (parts.length > 1 && parts[0] === handle.name) {
    parts = parts.slice(1);
  }
  let currentHandle: FileSystemDirectoryHandle = handle;

  for (let i = 0; i < parts.length - 1; i++) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i], { create: true });
  }

  const fileName = parts[parts.length - 1];
  const fileHandle: FileSystemFileHandle = await currentHandle.getFileHandle(fileName, {
    create: true,
  });
  const fileWritableHandle = fileHandle as unknown as WritableCapableFileHandle;
  if (typeof fileWritableHandle.createWritable === "function") {
    const writable = await fileWritableHandle.createWritable();
    await writable.write(content);
    await writable.close();
  } else {
    throw new Error("当前文件句柄不支持写操作 (createWritable 不可用)");
  }
}

