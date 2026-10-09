"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getDirectoryHandle,
  saveDirectoryHandle,
  removeDirectoryHandle,
  verifyPermission,
  scanDirectory,
  readLocalFile,
  writeLocalFile,
  WorkspaceFileNode,
} from "@/lib/workspace/localWorkspaceManager";

export type WorkspaceStatus =
  | "UNSUPPORTED" // 浏览器不支持 File System Access API
  | "CONNECTED" // 已关联并拥有读写权限
  | "NEED_PERMISSION" // 同一设备已缓存句柄，需轻点一次重新授权
  | "DISCONNECTED_DEVICE" // 换电脑或未关联本地目录
  | "LOADING";

export function useLocalWorkspace(projectId: string | null) {
  const [status, setStatus] = useState<WorkspaceStatus>("LOADING");
  const [directoryName, setDirectoryName] = useState<string>("");
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>("");
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const [activeFileSize, setActiveFileSize] = useState<string>("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // 1. 初始化检查当前设备 IndexedDB 状态
  const checkStatus = useCallback(async () => {
    if (typeof window === "undefined") return;

    if (!("showDirectoryPicker" in window)) {
      setStatus("UNSUPPORTED");
      return;
    }

    const targetKey = projectId || "genesis-default-workspace";

    try {
      setStatus("LOADING");
      const handle = await getDirectoryHandle(targetKey);
      if (!handle) {
        // 关键逻辑：换电脑或首次访问时，该设备上无对应 handle
        setStatus("DISCONNECTED_DEVICE");
        setRootHandle(null);
        setFileTree([]);
        return;
      }

      setDirectoryName(handle.name);
      setRootHandle(handle);

      // 查询权限状态（不触发弹窗）
      const hasPermission = await verifyPermission(handle, false);
      if (hasPermission) {
        setStatus("CONNECTED");
        setIsScanning(true);
        const tree = await scanDirectory(handle);
        setFileTree(tree);
        setIsScanning(false);
      } else {
        // 同一设备：句柄存在但浏览器需要用户点击确认唤醒
        setStatus("NEED_PERMISSION");
      }
    } catch (err) {
      console.warn("检查本地工作区状态异常:", err);
      setStatus("DISCONNECTED_DEVICE");
    }
  }, [projectId]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // 2. 绑定或换电脑重新关联本地文件夹
  const attachDirectory = async () => {
    if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
      alert("当前浏览器不支持访问本地文件夹，请使用最新版 Chrome、Edge 或 Arc。");
      return;
    }

    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
      });

      const targetKey = projectId || "genesis-default-workspace";
      await saveDirectoryHandle(targetKey, handle);

      setRootHandle(handle);
      setDirectoryName(handle.name);
      setStatus("CONNECTED");

      setIsScanning(true);
      const tree = await scanDirectory(handle);
      setFileTree(tree);
      setIsScanning(false);

      // 默认选中第一个文件
      const firstFile = findFirstFile(tree);
      if (firstFile) {
        selectFile(firstFile.path, handle);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("关联本地文件夹失败:", err);
      }
    }
  };

  // 3. 一键恢复授权（同设备刷新后）
  const requestAccess = async () => {
    if (!rootHandle) {
      attachDirectory();
      return;
    }

    try {
      const granted = await verifyPermission(rootHandle, true);
      if (granted) {
        setStatus("CONNECTED");
        setIsScanning(true);
        const tree = await scanDirectory(rootHandle);
        setFileTree(tree);
        setIsScanning(false);

        if (activeFilePath) {
          selectFile(activeFilePath, rootHandle);
        } else {
          const first = findFirstFile(tree);
          if (first) selectFile(first.path, rootHandle);
        }
      }
    } catch (err) {
      console.error("授权失败:", err);
    }
  };

  // 4. 断开与当前设备的本地绑定
  const disconnect = async () => {
    const targetKey = projectId || "genesis-default-workspace";
    await removeDirectoryHandle(targetKey);
    setRootHandle(null);
    setDirectoryName("");
    setFileTree([]);
    setActiveFilePath("");
    setActiveFileContent("");
    setActiveFileSize("");
    setStatus("DISCONNECTED_DEVICE");
  };

  // 5. 选中并读取指定文件
  const selectFile = async (filePath: string, targetHandle?: FileSystemDirectoryHandle) => {
    const handle = targetHandle || rootHandle;
    if (!handle) return;

    try {
      setIsLoadingFile(true);
      setActiveFilePath(filePath);
      const res = await readLocalFile(handle, filePath);
      setActiveFileContent(res.content);
      setActiveFileSize(res.size);
    } catch (err) {
      console.error(`读取文件失败 (${filePath}):`, err);
      setActiveFileContent(`// 读取文件失败: ${filePath}\n// 可能是文件被移动或编码不支持`);
    } finally {
      setIsLoadingFile(false);
    }
  };

  // 6. 保存或修改文件
  const saveFile = async (filePath: string, content: string) => {
    if (!rootHandle) return;
    await writeLocalFile(rootHandle, filePath, content);
    setActiveFileContent(content);
  };

  // 7. 刷新目录树
  const refreshTree = async () => {
    if (!rootHandle) return;
    setIsScanning(true);
    try {
      const tree = await scanDirectory(rootHandle);
      setFileTree(tree);
    } finally {
      setIsScanning(false);
    }
  };

  return {
    status,
    directoryName,
    fileTree,
    isScanning,
    activeFilePath,
    activeFileContent,
    activeFileSize,
    isLoadingFile,
    attachDirectory,
    requestAccess,
    disconnect,
    selectFile,
    saveFile,
    refreshTree,
  };
}

// 辅助方法：递归查找树中第一个文件
function findFirstFile(nodes: WorkspaceFileNode[]): WorkspaceFileNode | null {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    if (node.children) {
      const found = findFirstFile(node.children);
      if (found) return found;
    }
  }
  return null;
}
