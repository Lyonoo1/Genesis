/**
 * 通用剪贴板写入工具 (兼容 HTTPS 与 纯 HTTP/IP 访问下的降级写入)
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;

  // 1. 优先使用现代 Clipboard API (仅在 HTTPS 或 localhost 下为 secure context)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 失败后流转到 fallback 兜底
    }
  }

  // 2. 纯 HTTP 公网 IP 访问兼容 (document.execCommand 兜底)
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    textArea.remove();
    return successful;
  } catch (err) {
    console.error("Fallback copy failed:", err);
    return false;
  }
}
