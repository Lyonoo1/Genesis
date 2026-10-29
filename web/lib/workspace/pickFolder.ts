export interface PickedFolder {
  name: string;
  path?: string; // 桌面端原生绝对物理路径 (如 /Users/xxx/project 或 C:\xxx\project)
  handle?: FileSystemDirectoryHandle; // 浏览器端句柄 (Web 模式)
}

/**
 * 统一文件夹选择器：
 * - 桌面端 (Electron): 唤起操作系统原生文件夹选择器 (Finder / Explorer)，返回物理绝对路径；
 * - 网页端 (Web): 优雅降级使用 Chromium File System Access API (showDirectoryPicker)。
 */
export async function pickFolder(): Promise<PickedFolder | null> {
  // 1. Electron 桌面端原生 OS 选择框
  if (
    typeof window !== "undefined" &&
    (window as any).electronAPI &&
    typeof (window as any).electronAPI.selectDirectory === "function"
  ) {
    try {
      const res = await (window as any).electronAPI.selectDirectory();
      if (!res || !res.path) return null;
      return {
        name: res.name || res.path.split(/[\\/]/).pop() || "workspace",
        path: res.path,
      };
    } catch (err) {
      console.warn("[pickFolder] Electron selectDirectory failed:", err);
    }
  }

  // 2. 浏览器 Web 端 showDirectoryPicker
  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    try {
      const handle: FileSystemDirectoryHandle = await (
        window as Window & {
          showDirectoryPicker: (opts?: {
            mode?: string;
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker({
        mode: "readwrite",
      });
      if (handle) {
        return {
          name: handle.name,
          handle,
        };
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.warn("[pickFolder] showDirectoryPicker error:", err);
      }
      return null;
    }
  }

  // 3. 浏览器环境且不支持安全上下文提示
  if (typeof window !== "undefined") {
    if (!window.isSecureContext) {
      alert(
        "受浏览器安全策略限制：在非 HTTPS（HTTP IP）环境下，浏览器默认禁用本地文件访问功能。\n\n解决办法：\n1. 访问 chrome://flags/#unsafely-treat-insecure-origin-as-secure\n2. 将 " +
          window.location.origin +
          " 添加到白名单并设为 Enabled，点击 Relaunch 重启浏览器即可；\n3. 或者使用 Genesis 桌面端。"
      );
    } else {
      alert("当前浏览器环境不支持直接选择文件夹，请使用最新版 Chrome/Edge/Arc 或使用 Genesis 桌面端。");
    }
  }

  return null;
}
