import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Optional
import httpx

from core.config import settings
from core.exceptions import AppException, ErrorCode

logger = logging.getLogger("genesis.llm_adapter")


@dataclass
class StreamChunk:
    """内部统一流式 Chunk 结构体"""

    type: str  # text | tool_start | tool_delta | tool_finish | finish
    text: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_name: Optional[str] = None
    arguments: Optional[dict[str, Any]] = None
    finish_reason: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0


class LLMAdapter:
    """双模型流式协议抹平器：支持 OpenAI 兼容规范与 Anthropic 原生规范"""

    def __init__(
        self,
        openai_key: Optional[str] = None,
        openai_base: Optional[str] = None,
        anthropic_key: Optional[str] = None,
        anthropic_base: Optional[str] = None,
    ):
        self.openai_key = openai_key or settings.OPENAI_API_KEY
        self.openai_base = openai_base or settings.OPENAI_BASE_URL
        self.anthropic_key = anthropic_key or settings.ANTHROPIC_API_KEY
        self.anthropic_base = anthropic_base or settings.ANTHROPIC_BASE_URL

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        model: str = "gpt-4o",
        temperature: float = 0.7,
        max_tokens: int = 10000,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """统一流式入口：支持动态用户传入密钥与 Base URL"""
        is_anthropic = provider == "anthropic" or "claude" in model.lower()

        if is_anthropic:
            async for chunk in self._stream_anthropic(
                messages=messages,
                tools=tools,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                api_key=api_key,
                base_url=base_url,
            ):
                yield chunk
        else:
            async for chunk in self._stream_openai_compatible(
                messages=messages,
                tools=tools,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                api_key=api_key,
                base_url=base_url,
            ):
                yield chunk

    async def _stream_openai_compatible(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        model: str = "gpt-4o",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """处理 OpenAI 兼容规范的流式响应 (OpenAI, DeepSeek, Qwen, Ollama 等)"""
        active_key = api_key or self.openai_key
        active_base = base_url or self.openai_base

        if not active_key:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message="未配置有效 API Key，请在模型配置面板中填入你的 API Key",
            )

        headers = {
            "Authorization": f"Bearer {active_key}",
            "Content-Type": "application/json",
        }

        model_name = model.lower()
        is_o_series = (
            model_name.startswith(("o1", "o3", "o4"))
            or "/o1" in model_name
            or "/o3" in model_name
            or "/o4" in model_name
        )
        is_reasoning_model = is_o_series or any(
            k in model_name
            for k in ["reasoner", "r1", "deepseek-reasoner", "deepseek-flash"]
        )

        # 自动安全自适应：防止 max_tokens 超出大模型上游的最大输出上限或导致网络超时
        # DeepSeek 官方硬限制为 [1, 393216]，推荐单次生成安全预算为 32768 (32K)
        # Claude 单次上限通常为 8192
        # OpenAI GPT-4o 4096~16384
        safe_max_tokens = max_tokens
        if not safe_max_tokens or safe_max_tokens > 65536:
            if any(k in model_name for k in ["deepseek", "r1"]):
                safe_max_tokens = 32768
            elif any(k in model_name for k in ["claude", "anthropic"]):
                safe_max_tokens = 8192
            elif is_o_series or any(k in model_name for k in ["o1", "o3", "o4"]):
                safe_max_tokens = 32768
            elif any(k in model_name for k in ["gpt-4o"]):
                safe_max_tokens = 16384
            else:
                safe_max_tokens = 32768

        # 终极保护：绝对不超过 DeepSeek 官方上限 393216，杜绝 HTTP 400 校验错误
        if safe_max_tokens and safe_max_tokens > 393216:
            safe_max_tokens = 393216

        # 清洗消息中的非标准字段（如 is_error），避免严格上游/代理网关报错 HTTP 400
        clean_messages: list[dict[str, Any]] = []
        for m in messages:
            clean_m = dict(m)
            clean_m.pop("is_error", None)
            clean_messages.append(clean_m)

        payload: dict[str, Any] = {
            "model": model,
            "messages": clean_messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        # OpenAI o1/o3/o4 推理模型参数适配：max_completion_tokens 替代 max_tokens，并移除 temperature
        if is_o_series:
            payload["max_completion_tokens"] = safe_max_tokens
        else:
            payload["max_tokens"] = safe_max_tokens

        if not is_reasoning_model:
            payload["temperature"] = temperature
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        url = f"{active_base.rstrip('/')}/chat/completions"


        # 内存中工具参数聚合缓冲区: tool_index -> {"id": ..., "name": ..., "raw_args": ...}
        tool_call_buffers: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"
        input_tokens = 0
        output_tokens = 0

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as response:
                    if response.status_code != 200:
                        err_bytes = await response.aread()
                        err_text = err_bytes.decode("utf-8", errors="replace")
                        raise AppException(
                            code=ErrorCode.INTERNAL_SERVER_ERROR,
                            message=f"大模型上游请求失败 (HTTP {response.status_code}): {err_text}",
                        )

                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or not line.startswith("data:"):
                            continue
                        raw_data = line[len("data:"):].strip()
                        if raw_data == "[DONE]":
                            break

                        try:
                            chunk = json.loads(raw_data)
                        except json.JSONDecodeError:
                            continue

                        # 记录 Token 消耗 (stream_options)
                        usage = chunk.get("usage")
                        if usage:
                            input_tokens = usage.get("prompt_tokens", input_tokens)
                            output_tokens = usage.get("completion_tokens", output_tokens)

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue

                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        reason = choice.get("finish_reason")
                        if reason:
                            finish_reason = reason

                        # 0. 深度思考增量 (DeepSeek R1 / o1 / Kimi 等)
                        reasoning_delta = delta.get("reasoning_content") or delta.get("reasoning")
                        if reasoning_delta:
                            yield StreamChunk(type="reasoning", text=reasoning_delta)

                        # 1. 普通文本增量
                        content_delta = delta.get("content")
                        if content_delta:
                            yield StreamChunk(type="text", text=content_delta)

                        # 2. 工具调用增量
                        tool_calls = delta.get("tool_calls")
                        if tool_calls:
                            for tc in tool_calls:
                                index = tc.get("index", 0)
                                if index not in tool_call_buffers:
                                    tc_id = tc.get("id") or f"call_{index}"
                                    fn = tc.get("function") or {}
                                    name = fn.get("name") or ""
                                    tool_call_buffers[index] = {
                                        "id": tc_id,
                                        "name": name,
                                        "raw_args": fn.get("arguments") or "",
                                    }
                                    yield StreamChunk(
                                        type="tool_start",
                                        tool_call_id=tc_id,
                                        tool_name=name,
                                    )
                                else:
                                    # 累积参数
                                    buf = tool_call_buffers[index]
                                    fn = tc.get("function") or {}
                                    arg_piece = fn.get("arguments") or ""
                                    buf["raw_args"] += arg_piece
                                    if fn.get("name"):
                                        buf["name"] = fn["name"]
                                    yield StreamChunk(
                                        type="tool_delta",
                                        tool_call_id=buf["id"],
                                        text=arg_piece,
                                    )

            except httpx.RequestError as exc:
                raise AppException(
                    code=ErrorCode.INTERNAL_SERVER_ERROR,
                    message=f"连接大模型上游异常: {str(exc)}",
                )

        # 3. 聚合结束：发送 tool_finish
        for index, buf in tool_call_buffers.items():
            args = {}
            raw_args = buf["raw_args"].strip()
            if raw_args:
                try:
                    args = json.loads(raw_args)
                except Exception:
                    args = {"raw": raw_args}
            yield StreamChunk(
                type="tool_finish",
                tool_call_id=buf["id"],
                tool_name=buf["name"],
                arguments=args,
            )

        # 4. 单轮结束
        yield StreamChunk(
            type="finish",
            finish_reason=finish_reason,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    @classmethod
    def convert_to_anthropic_messages(
        cls,
        messages: list[dict[str, Any]],
    ) -> tuple[Optional[str], list[dict[str, Any]]]:
        """将通用消息格式转换为 Anthropic 规范格式，执行严格角色交替、多工具合并与提示词缓存断点注入"""
        system_prompts: list[str] = []
        raw_non_system: list[dict[str, Any]] = []

        for m in messages:
            role = m.get("role")
            if role == "system":
                c = m.get("content") or ""
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict):
                            t = b.get("text") or b.get("content") or ""
                            if t:
                                system_prompts.append(str(t).strip())
                        else:
                            system_prompts.append(str(b).strip())
                elif isinstance(c, str):
                    if c.strip():
                        system_prompts.append(c.strip())
                else:
                    system_prompts.append(str(c).strip())
            else:
                raw_non_system.append(m)

        system_text = "\n\n".join(system_prompts).strip() if system_prompts else None

        converted_items: list[dict[str, Any]] = []
        for m in raw_non_system:
            role = m.get("role")
            content = m.get("content")

            if role == "tool":
                # 工具调用返回结果 -> role: "user", block: "tool_result"
                if content is None:
                    tool_content: Any = ""
                elif isinstance(content, str):
                    tool_content = content
                elif isinstance(content, list) and all(isinstance(x, dict) and "type" in x for x in content):
                    tool_content = content
                elif isinstance(content, (dict, list)):
                    tool_content = json.dumps(content, ensure_ascii=False)
                else:
                    tool_content = str(content)

                tool_block: dict[str, Any] = {
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id") or "unknown_call",
                    "content": tool_content,
                }
                if m.get("is_error") or str(m.get("status", "")).lower() == "failed":
                    tool_block["is_error"] = True
                converted_items.append({"role": "user", "content": [tool_block]})

            elif role == "user":
                if isinstance(content, list):
                    blocks = []
                    for b in content:
                        if isinstance(b, dict):
                            b_copy = dict(b)
                            b_copy.pop("cache_control", None)
                            blocks.append(b_copy)
                        else:
                            blocks.append({"type": "text", "text": str(b)})
                    converted_items.append({"role": "user", "content": blocks})
                else:
                    text_str = str(content) if content is not None else ""
                    converted_items.append({"role": "user", "content": [{"type": "text", "text": text_str}]})

            elif role == "assistant":
                blocks: list[dict[str, Any]] = []
                if content:
                    if isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict):
                                b_copy = dict(b)
                                b_copy.pop("cache_control", None)
                                blocks.append(b_copy)
                            else:
                                blocks.append({"type": "text", "text": str(b)})
                    else:
                        blocks.append({"type": "text", "text": str(content)})

                tool_calls = m.get("tool_calls") or m.get("raw_tool_calls")
                if tool_calls and isinstance(tool_calls, list):
                    existing_tc_ids = {
                        b.get("id")
                        for b in blocks
                        if isinstance(b, dict) and b.get("type") == "tool_use"
                    }
                    for tc in tool_calls:
                        if hasattr(tc, "model_dump"):
                            tc = tc.model_dump()
                        elif hasattr(tc, "__dict__"):
                            tc = tc.__dict__
                        if not isinstance(tc, dict):
                            continue

                        tc_id = tc.get("id") or "tool_call"
                        if tc_id in existing_tc_ids:
                            continue

                        if "function" in tc and isinstance(tc["function"], dict):
                            fn_name = tc["function"].get("name") or "unknown_tool"
                            raw_args = tc["function"].get("arguments") or {}
                        else:
                            fn_name = tc.get("name") or "unknown_tool"
                            raw_args = tc.get("args") or tc.get("arguments") or {}

                        if isinstance(raw_args, str):
                            try:
                                parsed_args = json.loads(raw_args)
                            except Exception:
                                parsed_args = {"raw": raw_args}
                        elif isinstance(raw_args, dict):
                            parsed_args = raw_args
                        else:
                            parsed_args = {}

                        blocks.append(
                            {
                                "type": "tool_use",
                                "id": tc_id,
                                "name": fn_name,
                                "input": parsed_args,
                            }
                        )
                        existing_tc_ids.add(tc_id)

                if not blocks:
                    blocks.append({"type": "text", "text": " "})

                converted_items.append({"role": "assistant", "content": blocks})

        # 连续相同角色消息合并（多工具 tool 结果合并为单条 role: user 消息，严格交替）
        merged_messages: list[dict[str, Any]] = []
        for item in converted_items:
            if not merged_messages:
                merged_messages.append(item)
            else:
                last_msg = merged_messages[-1]
                if last_msg["role"] == item["role"]:
                    last_msg["content"].extend(item["content"])
                else:
                    merged_messages.append(item)

        # 确保消息列表以 user 开头
        if merged_messages and merged_messages[0]["role"] != "user":
            merged_messages.insert(0, {"role": "user", "content": [{"type": "text", "text": "Continue"}]})
        elif not merged_messages:
            merged_messages.append({"role": "user", "content": [{"type": "text", "text": "Hello"}]})

        # 清除历史旧 cache_control 标记，确保总断点数 <= 4
        for msg in merged_messages:
            for b in msg.get("content", []):
                if isinstance(b, dict):
                    b.pop("cache_control", None)

        # 断点 3 & 4：找到转换后 messages 列表中最后两条 role == "user" 的消息，在各自最后一个 block 上注入 ephemeral 缓存标记
        user_indices = [idx for idx, m in enumerate(merged_messages) if m.get("role") == "user"]
        target_indices = user_indices[-2:] if len(user_indices) >= 2 else user_indices
        for idx in target_indices:
            user_msg = merged_messages[idx]
            if user_msg.get("content"):
                user_msg["content"][-1]["cache_control"] = {"type": "ephemeral"}

        return system_text, merged_messages

    @classmethod
    def build_anthropic_system(
        cls,
        system_prompt: Optional[str],
    ) -> Optional[list[dict[str, Any]]]:
        """为 Anthropic 构建带断点 1 (cache_control) 的 system 块列表"""
        if not system_prompt or not system_prompt.strip():
            return None
        return [
            {
                "type": "text",
                "text": system_prompt.strip(),
                "cache_control": {"type": "ephemeral"},
            }
        ]

    @classmethod
    def convert_to_anthropic_tools(
        cls,
        tools: Optional[list[dict[str, Any]]],
    ) -> Optional[list[dict[str, Any]]]:
        """将通用 Tools 转换为 Anthropic 格式，并在最后一个工具定义上注入断点 2 的 cache_control"""
        if not tools:
            return None

        anthropic_tools: list[dict[str, Any]] = []
        for t in tools:
            if hasattr(t, "model_dump"):
                t = t.model_dump()
            elif hasattr(t, "__dict__"):
                t = t.__dict__

            if not isinstance(t, dict):
                continue

            if "input_schema" in t:
                tool_copy = dict(t)
                tool_copy.pop("cache_control", None)
                anthropic_tools.append(tool_copy)
            else:
                fn = t.get("function") or {}
                anthropic_tools.append(
                    {
                        "name": fn.get("name") or t.get("name"),
                        "description": fn.get("description") or t.get("description", ""),
                        "input_schema": fn.get("parameters") or t.get("parameters") or {"type": "object", "properties": {}},
                    }
                )

        if anthropic_tools:
            anthropic_tools[-1]["cache_control"] = {"type": "ephemeral"}

        return anthropic_tools or None

    async def _stream_anthropic(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        model: str = "claude-3-5-sonnet-20241022",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """处理 Anthropic 原生 Messages 流式协议"""
        active_key = api_key or self.anthropic_key
        active_base = base_url or self.anthropic_base

        if not active_key:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message="未检测到有效 ANTHROPIC_API_KEY，请在模型配置面板中填入你的 API Key",
            )

        headers = {
            "x-api-key": active_key,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
            "content-type": "application/json",
        }

        # 1. 转换消息并注入断点 3 & 4 (严格角色交替与多工具合并)
        system_prompt, anthropic_messages = self.convert_to_anthropic_messages(messages)

        anthropic_max_tokens = min(max_tokens or 8192, 8192)
        payload: dict[str, Any] = {
            "model": model,
            "messages": anthropic_messages,
            "max_tokens": anthropic_max_tokens,
            "temperature": temperature,
            "stream": True,
        }

        # 2. 断点 1：在 system 块末尾注入 cache_control
        anthropic_system = self.build_anthropic_system(system_prompt)
        if anthropic_system:
            payload["system"] = anthropic_system

        # 3. 断点 2：在 tools 列表的最后一个工具定义上注入 cache_control
        anthropic_tools = self.convert_to_anthropic_tools(tools)
        if anthropic_tools:
            payload["tools"] = anthropic_tools

        url = f"{active_base.rstrip('/')}/messages"
        finish_reason = "stop"
        input_tokens = 0
        output_tokens = 0

        # Anthropic content blocks: index -> {"id": ..., "name": ..., "raw_json": ...}
        active_tool_blocks: dict[int, dict[str, Any]] = {}

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as response:
                    if response.status_code != 200:
                        err_bytes = await response.aread()
                        err_text = err_bytes.decode("utf-8", errors="replace")
                        raise AppException(
                            code=ErrorCode.INTERNAL_SERVER_ERROR,
                            message=f"Anthropic 上游请求失败 (HTTP {response.status_code}): {err_text}",
                        )

                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or not line.startswith("data:"):
                            continue
                        raw_data = line[len("data:"):].strip()

                        try:
                            event = json.loads(raw_data)
                        except json.JSONDecodeError:
                            continue

                        event_type = event.get("type")

                        if event_type == "message_start":
                            msg = event.get("message") or {}
                            usage = msg.get("usage") or {}
                            cached_tokens = (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
                            input_tokens = usage.get("input_tokens", input_tokens) + cached_tokens

                        elif event_type == "content_block_start":
                            index = event.get("index", 0)
                            content_block = event.get("content_block") or {}
                            if content_block.get("type") == "tool_use":
                                t_id = content_block.get("id")
                                t_name = content_block.get("name")
                                active_tool_blocks[index] = {
                                    "id": t_id,
                                    "name": t_name,
                                    "raw_json": "",
                                }
                                yield StreamChunk(
                                    type="tool_start",
                                    tool_call_id=t_id,
                                    tool_name=t_name,
                                )

                        elif event_type == "content_block_delta":
                            index = event.get("index", 0)
                            delta = event.get("delta") or {}
                            delta_type = delta.get("type")
                            if delta_type == "text_delta":
                                yield StreamChunk(type="text", text=delta.get("text"))
                            elif delta_type == "thinking_delta":
                                yield StreamChunk(type="reasoning", text=delta.get("thinking"))
                            elif delta_type == "input_json_delta":
                                piece = delta.get("partial_json", "")
                                if index in active_tool_blocks:
                                    active_tool_blocks[index]["raw_json"] += piece
                                    yield StreamChunk(
                                        type="tool_delta",
                                        tool_call_id=active_tool_blocks[index]["id"],
                                        text=piece,
                                    )

                        elif event_type == "content_block_stop":
                            index = event.get("index", 0)
                            if index in active_tool_blocks:
                                buf = active_tool_blocks[index]
                                args = {}
                                raw_json = buf["raw_json"].strip()
                                if raw_json:
                                    try:
                                        args = json.loads(raw_json)
                                    except Exception:
                                        args = {"raw": raw_json}
                                yield StreamChunk(
                                    type="tool_finish",
                                    tool_call_id=buf["id"],
                                    tool_name=buf["name"],
                                    arguments=args,
                                )

                        elif event_type == "message_delta":
                            delta = event.get("delta") or {}
                            if delta.get("stop_reason") == "tool_use":
                                finish_reason = "tool_calls"
                            elif delta.get("stop_reason"):
                                finish_reason = delta["stop_reason"]
                            usage = event.get("usage") or {}
                            output_tokens = usage.get("output_tokens", output_tokens)

            except httpx.RequestError as exc:
                raise AppException(
                    code=ErrorCode.INTERNAL_SERVER_ERROR,
                    message=f"连接 Anthropic 上游异常: {str(exc)}",
                )

        yield StreamChunk(
            type="finish",
            finish_reason=finish_reason,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    async def test_connection(
        self,
        provider: str,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 10.0,
    ) -> tuple[bool, Optional[int], Optional[str]]:
        """测试用户配置的模型连通性并返回 (success, latency_ms, error_message)"""
        import time
        t0 = time.time()
        is_anthropic = provider == "anthropic" or "claude" in model.lower()

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                if is_anthropic:
                    url = f"{base_url.rstrip('/')}/messages"
                    headers = {
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    }
                    payload = {
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                    }
                    resp = await client.post(url, json=payload, headers=headers)
                else:
                    url = f"{base_url.rstrip('/')}/chat/completions"
                    headers = {
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    }
                    model_name = model.lower()
                    is_o_series = (
                        model_name.startswith(("o1", "o3", "o4"))
                        or "/o1" in model_name
                        or "/o3" in model_name
                        or "/o4" in model_name
                    )
                    payload: dict[str, Any] = {
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                    }
                    if is_o_series:
                        payload["max_completion_tokens"] = 1
                    else:
                        payload["max_tokens"] = 1
                    resp = await client.post(url, json=payload, headers=headers)

                latency_ms = int((time.time() - t0) * 1000)
                if resp.status_code == 200:
                    return True, latency_ms, None
                else:
                    err_text = resp.text[:200]
                    return False, latency_ms, f"HTTP {resp.status_code}: {err_text}"

            except Exception as exc:
                latency_ms = int((time.time() - t0) * 1000)
                return False, latency_ms, str(exc)


# 单例
llm_adapter = LLMAdapter()

