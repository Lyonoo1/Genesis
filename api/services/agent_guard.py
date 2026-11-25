import hashlib
import json
import logging
import re
from collections import deque
from dataclasses import dataclass
from typing import Any, Optional

from core.exceptions import AppException
from core.sqlite_db import db_list_models

logger = logging.getLogger("genesis.agent_guard")


# ============================================================================
# 1. 模型上下文窗口真实推断与凭据回查
# ============================================================================


def infer_model_context_window(
    model: Optional[str],
    explicit_window: Optional[int] = None,
) -> int:
    """根据模型标识推断真实上下文窗口容量，修正历史默认 1M (1048576) 误配。"""
    name = (model or "").strip().lower()

    # 仅 Gemini / Qwen-Long / 明确 1M 型号默认支持 1M 上下文
    supports_1m = any(k in name for k in ("gemini", "qwen-long", "1m", "gpt-4.1", "llama-4"))

    if explicit_window and explicit_window > 0:
        # 历史版本对所有模型硬编码了 1048576，针对非 1M 模型自动纠偏为真实容量
        if explicit_window != 1048576 or supports_1m:
            return int(explicit_window)

    if supports_1m:
        return 1048576
    if any(k in name for k in ("deepseek",)):
        # DeepSeek V3 / R1 / Chat / Reasoner 当前主流上下文窗口为 128K
        return 131072
    if any(k in name for k in ("claude", "anthropic")):
        return 200000
    if any(k in name for k in ("o1", "o3", "o4")):
        return 200000
    if any(k in name for k in ("gpt-4o", "gpt-4-turbo", "gpt-5")):
        return 128000
    if any(k in name for k in ("qwen", "glm", "kimi", "moonshot")):
        return 131072
    return 128000


def resolve_effective_model_credentials(
    user_id: Optional[str],
    model: Optional[str],
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    provider: Optional[str] = None,
    context_window: Optional[int] = None,
) -> dict[str, Any]:
    """统一解析有效模型配置：优先请求显式传入，缺失时自动从用户已保存的 model_configs 回查兜底。"""
    resolved_model = (model or "").strip() or "gpt-4o"
    resolved_key = (api_key or "").strip() or None
    resolved_base = (base_url or "").strip() or None
    resolved_provider = (provider or "").strip() or None
    resolved_window = context_window

    if (not resolved_key or not resolved_base) and user_id:
        try:
            saved_models = db_list_models(str(user_id))
        except Exception as exc:
            logger.debug("回查用户 [%s] model_configs 失败: %s", user_id, exc)
            saved_models = []

        if saved_models:
            matched = None
            # 1) 优先精确匹配 modelId / name 且带有效 apiKey
            for item in saved_models:
                item_key = str(item.get("apiKey") or "").strip()
                if not item_key:
                    continue
                if (
                    str(item.get("modelId") or "").strip().lower() == resolved_model.lower()
                    or str(item.get("name") or "").strip().lower() == resolved_model.lower()
                ):
                    matched = item
                    break
            # 2) 回退到用户的默认模型（带有效 apiKey）
            if matched is None:
                for item in saved_models:
                    if item.get("isDefault") and str(item.get("apiKey") or "").strip():
                        matched = item
                        break
            # 3) 回退到任意一个配置了有效 apiKey 的模型
            if matched is None:
                for item in saved_models:
                    if str(item.get("apiKey") or "").strip():
                        matched = item
                        break

            if matched is not None:
                if not resolved_key:
                    resolved_key = str(matched.get("apiKey") or "").strip() or None
                if not resolved_base:
                    resolved_base = str(matched.get("baseUrl") or "").strip() or None
                if not resolved_provider:
                    resolved_provider = str(matched.get("provider") or "").strip() or None
                if not model and matched.get("modelId"):
                    resolved_model = str(matched["modelId"]).strip()
                if not resolved_window and matched.get("contextWindow"):
                    resolved_window = int(matched["contextWindow"])

    final_window = infer_model_context_window(resolved_model, resolved_window)
    return {
        "model": resolved_model,
        "api_key": resolved_key,
        "base_url": resolved_base,
        "provider": resolved_provider,
        "context_window": final_window,
    }


# ============================================================================
# 2. 结构化错误清洗（禁止裸露 Python dict 字符串给前端）
# ============================================================================


def extract_clean_error(err: Exception) -> tuple[str, str]:
    """将后端异常统一清洗为 (error_code, clean_human_message)。"""
    if isinstance(err, AppException):
        detail = err.detail
        if isinstance(detail, dict):
            err_obj = detail.get("error") if isinstance(detail.get("error"), dict) else detail
            code = str(err_obj.get("code") or "APP_ERROR")
            msg = str(err_obj.get("message") or str(err))
            return code, msg.strip()
        return "APP_ERROR", str(detail or err).strip()

    raw = str(err).strip()
    # 兜底清洗形如 "400: {'error': {'code': '...', 'message': '...'}}" 的序列化文本
    msg_match = re.search(r"['\"]message['\"]\s*:\s*['\"]([^'\"]+)['\"]", raw)
    code_match = re.search(r"['\"]code['\"]\s*:\s*['\"]([^'\"]+)['\"]", raw)
    if msg_match:
        code = code_match.group(1) if code_match else "EXECUTION_ERROR"
        return code, msg_match.group(1).strip()

    lower = raw.lower()
    if "api key" in lower or "401" in lower or "unauthorized" in lower:
        return "AUTH_ERROR", "模型鉴权失败或未配置有效 API Key，请在模型设置中检查密钥配置。"
    if "429" in lower or "rate limit" in lower:
        return "RATE_LIMITED", "模型接口触发频率限制，请稍后重试。"
    if "timeout" in lower or "timed out" in lower:
        return "TIMEOUT", "模型请求超时，请检查网络连接或稍后重试。"
    return "EXECUTION_ERROR", raw or "执行过程中发生未知异常"


# ============================================================================
# 3. 语义级防死循环检测器 (DoomLoopDetector)
# ============================================================================


@dataclass
class LoopCheckResult:
    triggered: bool = False
    severity: str = "none"  # none | soft_nudge | hard_stop
    reason: str = ""
    detail: str = ""


class DoomLoopDetector:
    """
    进度感知的语义级防死循环检测器（替代粗暴的 20 步固定截断）：
    - 允许复杂工程任务正常推进（高安全预算，如 80 步）
    - 精准识别 3 类真正的死循环病态：
      1) exact_repeat: 同一工具+相同规范化参数在滑动窗口内重复调用 >= repeat_threshold 次，
         或连续 2 次完全相同调用且输出指纹也完全相同
      2) cycle_ping_pong: 出现长度为 2~3 的周期性乒乓调用（如 A-B-A-B）
      3) consecutive_error_stall: 连续 >= error_streak_threshold 步所有工具调用全部失败
    - 分级干预：首次触发下发 soft_nudge（让模型自我纠偏换思路），若继续重复则 hard_stop + 收尾总结
    """

    def __init__(
        self,
        window_size: int = 12,
        repeat_threshold: int = 3,
        error_streak_threshold: int = 4,
        max_soft_nudges: int = 1,
    ) -> None:
        self.window_size = window_size
        self.repeat_threshold = repeat_threshold
        self.error_streak_threshold = error_streak_threshold
        self.max_soft_nudges = max_soft_nudges

        self._call_history: deque[tuple[str, str]] = deque(maxlen=window_size)
        self._step_signatures: deque[str] = deque(maxlen=window_size)
        self._consecutive_error_steps: int = 0
        self.soft_nudges_used: int = 0

    @staticmethod
    def _canonical_signature(tool_name: str, tool_args: Any) -> str:
        try:
            normalized_args = json.dumps(
                tool_args if isinstance(tool_args, (dict, list)) else {"raw": str(tool_args)},
                sort_keys=True,
                ensure_ascii=False,
            )
        except Exception:
            normalized_args = str(tool_args)
        digest = hashlib.sha1(f"{tool_name}::{normalized_args}".encode("utf-8")).hexdigest()[:12]
        return f"{tool_name}#{digest}"

    @staticmethod
    def _output_fingerprint(output: Any) -> str:
        try:
            text = (
                json.dumps(output, sort_keys=True, ensure_ascii=False)
                if isinstance(output, (dict, list))
                else str(output)
            )
        except Exception:
            text = str(output)
        return hashlib.sha1(text[:1024].encode("utf-8", errors="ignore")).hexdigest()[:12]

    def record_step(
        self,
        tool_records: list[dict[str, Any]],
    ) -> LoopCheckResult:
        """
        记录单步所有工具执行结果并评估是否存在死循环。
        tool_records 每项包含: {"name": str, "args": Any, "is_error": bool, "output": Any}
        """
        if not tool_records:
            return LoopCheckResult()

        step_sigs: list[str] = []
        all_errors = True
        stagnant_repeat_hit: Optional[str] = None
        window_repeat_hit: Optional[str] = None

        for rec in tool_records:
            name = str(rec.get("name") or "")
            args = rec.get("args")
            is_error = bool(rec.get("is_error", False))
            out_fp = self._output_fingerprint(rec.get("output"))
            sig = self._canonical_signature(name, args)
            step_sigs.append(sig)
            if not is_error:
                all_errors = False

            # 检测连续完全相同的 (调用签名 + 结果指纹)
            if self._call_history and self._call_history[-1] == (sig, out_fp):
                stagnant_repeat_hit = name

            self._call_history.append((sig, out_fp))

            # 统计滑动窗口内同一工具+参数出现次数
            same_count = sum(1 for past_sig, _ in self._call_history if past_sig == sig)
            if same_count >= self.repeat_threshold:
                window_repeat_hit = name

        step_sig = "|".join(step_sigs)
        self._step_signatures.append(step_sig)

        if all_errors:
            self._consecutive_error_steps += 1
        else:
            self._consecutive_error_steps = 0

        # 检测周期乒乓模式 (A-B-A-B 或 A-B-C-A-B-C)
        cycle_detected = False
        sigs = list(self._step_signatures)
        for period in (2, 3):
            if len(sigs) >= period * 2:
                if sigs[-period:] == sigs[-2 * period : -period]:
                    # 排除所有元素完全相同（已由 exact_repeat 覆盖，但也视为循环）
                    cycle_detected = True
                    break

        reason = ""
        detail = ""
        if self._consecutive_error_steps >= self.error_streak_threshold:
            reason = "consecutive_error_stall"
            detail = f"连续 {self._consecutive_error_steps} 步工具调用全部失败，当前思路陷入阻塞"
        elif window_repeat_hit:
            reason = "exact_repeat"
            detail = f"工具 `{window_repeat_hit}` 以相同参数重复调用已达 {self.repeat_threshold} 次"
        elif cycle_detected:
            reason = "cycle_ping_pong"
            detail = "检测到周期性重复工具调用循环（A-B-A-B）"
        elif stagnant_repeat_hit and len(self._call_history) >= 2:
            # 连续两次一模一样的调用且返回完全相同，先给一次温和纠偏
            same_pair_count = sum(
                1 for item in self._call_history if item == self._call_history[-1]
            )
            if same_pair_count >= 2:
                reason = "stagnant_repeat"
                detail = f"连续重复调用 `{stagnant_repeat_hit}` 且返回结果无任何变化"

        if not reason:
            return LoopCheckResult()

        if self.soft_nudges_used < self.max_soft_nudges:
            self.soft_nudges_used += 1
            return LoopCheckResult(
                triggered=True,
                severity="soft_nudge",
                reason=reason,
                detail=detail,
            )

        return LoopCheckResult(
            triggered=True,
            severity="hard_stop",
            reason=reason,
            detail=detail,
        )

    def build_soft_nudge_message(self, result: LoopCheckResult) -> str:
        return (
            f"[系统护栏提醒] 检测到执行疑似陷入重复循环（{result.detail}）。"
            "请勿继续重复相同的工具调用：请立即更换排查策略，或直接基于目前已经收集到的证据向用户输出清晰的阶段性结论与后续建议。"
        )
