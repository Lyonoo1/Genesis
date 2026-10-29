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
import { pickFolder } from "@/lib/workspace/pickFolder";
import { useSessionStore } from "@/stores/useSessionStore";

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

    const isDesktopEnv =
      typeof window !== "undefined" &&
      (Boolean((window as any).electronAPI?.isDesktop) ||
        process.env.NEXT_PUBLIC_BASE_PATH === "");

    // 如果是桌面端环境，检查当前项目是否已有关联的物理路径
    if (isDesktopEnv) {
      const proj = useSessionStore
        .getState()
        .projects.find((p) => p && p.id === projectId);
      const folderPath = proj?.folder_path;
      const folderName = proj?.folder_name || proj?.name;
      if (folderPath || folderName) {
        setDirectoryName(folderName || "本地项目");
        setStatus("CONNECTED");
        return;
      }
      setStatus("DISCONNECTED_DEVICE");
      return;
    }

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
        try {
          // 5秒超时保护，防止复杂工程或深层目录造成前端主线程无限期阻塞
          const treePromise = scanDirectory(handle);
          const timeoutPromise = new Promise<WorkspaceFileNode[]>((resolve) =>
            setTimeout(() => resolve([]), 5000)
          );
          const tree = await Promise.race([treePromise, timeoutPromise]);
          setFileTree(tree);
        } catch (scanErr) {
          console.warn("扫描本地工作区失败:", scanErr);
        } finally {
          setIsScanning(false);
        }
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
  const attachDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const res = await pickFolder();
      if (!res) return null;

      if (res.path && projectId) {
        useSessionStore.getState().updateProject(projectId, {
          folder_name: res.name,
          folder_path: res.path,
        });
      }

      if (res.handle) {
        const targetKey = projectId || "genesis-default-workspace";
        await saveDirectoryHandle(targetKey, res.handle);

        setRootHandle(res.handle);
        setDirectoryName(res.name);
        setStatus("CONNECTED");

        setIsScanning(true);
        let tree: WorkspaceFileNode[] = [];
        try {
          tree = await scanDirectory(res.handle);
          setFileTree(tree);
        } finally {
          setIsScanning(false);
        }

        const firstFile = findFirstFile(tree);
        if (firstFile) {
          selectFile(firstFile.path, res.handle);
        }
        return res.handle;
      } else if (res.path) {
        setDirectoryName(res.name);
        setStatus("CONNECTED");
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
        }
        return null;
      }

      return null;
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("关联本地文件夹失败:", err);
      }
      return null;
    }
  };

  // 3. 一键恢复授权（同设备刷新后）
  const requestAccess = async (): Promise<boolean> => {
    if (!rootHandle) {
      const handle = await attachDirectory();
      return !!handle;
    }

    try {
      const granted = await verifyPermission(rootHandle, true);
      if (granted) {
        setStatus("CONNECTED");
        setIsScanning(true);
        let tree: WorkspaceFileNode[] = [];
        try {
          tree = await scanDirectory(rootHandle);
          setFileTree(tree);
        } finally {
          setIsScanning(false);
        }

        if (activeFilePath) {
          selectFile(activeFilePath, rootHandle);
        } else {
          const first = findFirstFile(tree);
          if (first) selectFile(first.path, rootHandle);
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error("授权失败:", err);
      return false;
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
    if (handle) {
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
      return;
    }

    // 桌面端或无 handle 状态下，从服务端/本地 API 读取
    try {
      setIsLoadingFile(true);
      setActiveFilePath(filePath);
      const { fetchWorkspaceFileApi } = await import("@/lib/api/workspace");
      const res = await fetchWorkspaceFileApi(filePath, null, projectId);
      if (res?.success) {
        setActiveFileContent(res.content);
        setActiveFileSize(`${(res.size / 1024).toFixed(1)} KB`);
      }
    } catch (err) {
      console.error(`读取文件失败 (${filePath}):`, err);
      setActiveFileContent(`// 读取文件失败: ${filePath}\n// 可能是文件被移动或编码不支持`);
    } finally {
      setIsLoadingFile(false);
    }
  };

  // 6. 保存或修改文件
  const saveFile = async (filePath: string, content: string) => {
    if (rootHandle) {
      await writeLocalFile(rootHandle, filePath, content);
      setActiveFileContent(content);
      return;
    }

    try {
      const { writeWorkspaceFileApi } = await import("@/lib/api/workspace");
      await writeWorkspaceFileApi(filePath, content, null, projectId);
      setActiveFileContent(content);
    } catch (e) {
      console.warn("保存工作区文件失败:", e);
    }
  };

  // 7. 刷新目录树
  const refreshTree = useCallback(async () => {
    if (!rootHandle) return;
    setIsScanning(true);
    try {
      const tree = await scanDirectory(rootHandle);
      setFileTree(tree);
    } finally {
      setIsScanning(false);
    }
  }, [rootHandle]);

  // 8. 监听全局工作区变更事件 (例如 Agent 执行了删除或写入文件)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleWorkspaceRefresh = () => {
      refreshTree();
    };
    window.addEventListener("genesis:workspace-refresh", handleWorkspaceRefresh);
    return () => {
      window.removeEventListener("genesis:workspace-refresh", handleWorkspaceRefresh);
    };
  }, [refreshTree]);

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
    switchDirectory: attachDirectory,
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
