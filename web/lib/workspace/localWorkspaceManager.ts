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
  ".DS_Store",
  "__pycache__",
  ".venv",
  "venv",
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
    tx.objectStore(STORE_NAME).delete(projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 2. 权限校验与唤醒
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  requestWrite = true
): Promise<boolean> {
  try {
    const options: any = {
      mode: requestWrite ? "readwrite" : "read",
    };
    if (typeof (handle as any).queryPermission === "function") {
      const status = await (handle as any).queryPermission(options);
      if (status === "granted") return true;
    }
    if (typeof (handle as any).requestPermission === "function") {
      const status = await (handle as any).requestPermission(options);
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

// 3. 递归扫描本地目录树
export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  currentPath = ""
): Promise<WorkspaceFileNode[]> {
  const nodes: WorkspaceFileNode[] = [];

  for await (const [name, entry] of (handle as any).entries()) {
    if (IGNORE_PATTERNS.has(name) || name.startsWith(".")) continue;

    const relPath = currentPath ? `${currentPath}/${name}` : name;
    if (entry.kind === "directory") {
      const children = await scanDirectory(entry as FileSystemDirectoryHandle, relPath);
      nodes.push({
        name,
        path: relPath,
        kind: "directory",
        children,
      });
    } else {
      let sizeStr: string | undefined;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        sizeStr = formatBytes(file.size);
      } catch {
        // ignore size calculation error
      }
      nodes.push({
        name,
        path: relPath,
        kind: "file",
        size: sizeStr,
      });
    }
  }

  // 目录排前面，文件排后面，按名称排序
  return nodes.sort((a, b) => {
    if (a.kind === b.kind) return a.name.localeCompare(b.name);
    return a.kind === "directory" ? -1 : 1;
  });
}

// 4. 读取本地文件内容
export async function readLocalFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<{ content: string; size: string; name: string }> {
  const parts = relativePath.split("/").filter(Boolean);
  let currentHandle: any = handle;

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
  const parts = relativePath.split("/").filter(Boolean);
  let currentHandle: any = handle;

  for (let i = 0; i < parts.length - 1; i++) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i], { create: true });
  }

  const fileName = parts[parts.length - 1];
  const fileHandle: FileSystemFileHandle = await currentHandle.getFileHandle(fileName, {
    create: true,
  });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(content);
  await writable.close();
}
