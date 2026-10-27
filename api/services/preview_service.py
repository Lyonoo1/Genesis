import logging
import re

logger = logging.getLogger("genesis.preview_service")

PREVIEW_BRIDGE_SCRIPT = """<script id="__genesis_preview_bridge__">
(function() {
  if (window.__GENESIS_PREVIEW_BRIDGE_INJECTED__) return;
  window.__GENESIS_PREVIEW_BRIDGE_INJECTED__ = true;
  function report(type, message, stack) {
    try {
      var msgText = "";
      if (typeof message === 'string') {
        msgText = message;
      } else if (message && message.message) {
        msgText = message.message;
      } else {
        try { msgText = JSON.stringify(message); } catch(_) { msgText = String(message); }
      }
      window.parent.postMessage({
        source: 'genesis-preview-bridge',
        type: type || 'runtime_error',
        message: msgText,
        stack: typeof stack === 'string' ? stack : ''
      }, '*');
    } catch (_) {}
  }
  window.addEventListener('error', function(e) {
    var target = e.target || e.srcElement;
    var msg = e.message;
    if (!msg && target && target !== window) {
      var tag = (target.tagName || 'ELEMENT').toLowerCase();
      var src = target.src || target.href || '';
      msg = '资源加载失败: <' + tag + (src ? (' src="' + src + '"') : '') + '>';
    }
    report('error', msg || 'Unknown runtime error', e.error ? e.error.stack : (e.filename ? (e.filename + ':' + e.lineno) : ''));
  }, true);
  window.addEventListener('unhandledrejection', function(e) {
    report('unhandledrejection', (e.reason && e.reason.message) || String(e.reason), e.reason ? e.reason.stack : '');
  });
  var origConsoleError = console.error;
  console.error = function() {
    var args = Array.prototype.slice.call(arguments);
    var msg = args.map(function(a) {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch(_) { return String(a); }
      }
      return String(a);
    }).join(' ');
    report('console.error', msg, (new Error()).stack || '');
    origConsoleError.apply(console, arguments);
  };
})();
</script>"""


def inject_preview_bridge(html_content: str) -> str:
    """在 HTML 中注入 genesis-preview-bridge 探针脚本，实时向工作台 iframe 外层推送运行时崩溃与 console.error"""
    if not html_content or "__genesis_preview_bridge__" in html_content:
        return html_content

    # 1. 优先注入在 <head> 顶部
    head_match = re.search(r"<head[^>]*>", html_content, re.IGNORECASE)
    if head_match:
        idx = head_match.end()
        return html_content[:idx] + "\n" + PREVIEW_BRIDGE_SCRIPT + "\n" + html_content[idx:]

    # 2. 其次注入在 <html> 之后
    html_match = re.search(r"<html[^>]*>", html_content, re.IGNORECASE)
    if html_match:
        idx = html_match.end()
        return html_content[:idx] + "\n<head>\n" + PREVIEW_BRIDGE_SCRIPT + "\n</head>\n" + html_content[idx:]

    # 3. 兜底直接前置追加
    return PREVIEW_BRIDGE_SCRIPT + "\n" + html_content
