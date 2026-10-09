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

        is_reasoning_model = any(
            k in model.lower()
            for k in ["reasoner", "r1", "o1", "o3", "deepseek-reasoner", "deepseek-flash"]
        )

        # 自动安全自适应：防止 max_tokens 超出大模型上游的最大输出上限或导致网络超时
        # DeepSeek 官方硬限制为 [1, 393216]，推荐单次生成安全预算为 32768 (32K)
        # Claude 单次上限通常为 8192
        # OpenAI GPT-4o 4096~16384
        safe_max_tokens = max_tokens
        if not safe_max_tokens or safe_max_tokens > 65536:
            if any(k in model.lower() for k in ["deepseek", "r1"]):
                safe_max_tokens = 32768
            elif any(k in model.lower() for k in ["claude", "anthropic"]):
                safe_max_tokens = 8192
            elif any(k in model.lower() for k in ["o1", "o3"]):
                safe_max_tokens = 32768
            elif any(k in model.lower() for k in ["gpt-4o"]):
                safe_max_tokens = 16384
            else:
                safe_max_tokens = 32768

        # 终极保护：绝对不超过 DeepSeek 官方上限 393216，杜绝 HTTP 400 校验错误
        if safe_max_tokens and safe_max_tokens > 393216:
            safe_max_tokens = 393216

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "max_tokens": safe_max_tokens,
            "stream_options": {"include_usage": True},
        }
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
            "content-type": "application/json",
        }

        # 转换 system 消息
        system_prompt = ""
        user_assistant_messages = []
        for m in messages:
            if m["role"] == "system":
                system_prompt += f"{m.get('content', '')}\n"
            else:
                user_assistant_messages.append(m)

        anthropic_max_tokens = min(max_tokens or 8192, 8192)
        payload: dict[str, Any] = {
            "model": model,
            "messages": user_assistant_messages,
            "max_tokens": anthropic_max_tokens,
            "temperature": temperature,
            "stream": True,
        }
        if system_prompt.strip():
            payload["system"] = system_prompt.strip()

        # 转换 tools 为 Anthropic 格式
        if tools:
            anthropic_tools = []
            for t in tools:
                fn = t.get("function") or {}
                anthropic_tools.append(
                    {
                        "name": fn.get("name"),
                        "description": fn.get("description", ""),
                        "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                    }
                )
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
                            input_tokens = usage.get("input_tokens", input_tokens)

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
                    payload = {
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                    }
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

