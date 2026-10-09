import { create } from "zustand";
import { Message, ToolCallItem } from "@/types";
import { sendMessageStream, stopGenerationApi, fetchSessionMessagesApi } from "@/lib/api/chat";
import { useModelConfigStore } from "./useModelConfigStore";
import { useSessionStore } from "./useSessionStore";

interface ChatState {
  messagesBySession: Record<string, Message[]>;
  isStreaming: boolean;
  activeStreamingMessageId: string | null;
  streamingSessionId: string | null;
  abortController: AbortController | null;

  getMessages: (sessionId: string) => Message[];
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  editAndResendMessage: (sessionId: string, messageId: string, newContent: string) => Promise<void>;
  regenerateAssistantMessage: (sessionId: string, messageId: string) => Promise<void>;
  sendStreamMessage: (
    sessionId: string,
    content: string,
    skillId?: string | null,
    parentId?: string | null
  ) => Promise<void>;
  stopGeneration: (sessionId: string) => Promise<void>;
  switchSession: (newSessionId: string) => void;
  fetchMessages: (sessionId: string) => Promise<void>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  resetChatStore: () => void;
}

const INITIAL_DEMO_MESSAGES: Record<string, Message[]> = {};

export const useChatStore = create<ChatState>((set, get) => ({
  messagesBySession: INITIAL_DEMO_MESSAGES,
  isStreaming: false,
  activeStreamingMessageId: null,
  streamingSessionId: null,
  abortController: null,

  resetChatStore: () => {
    set({
      messagesBySession: {},
      isStreaming: false,
      activeStreamingMessageId: null,
      streamingSessionId: null,
    });
  },

  getMessages: (sessionId: string) => {
    return get().messagesBySession[sessionId] || [];
  },

  addMessage: (sessionId: string, message: Message) => {
    set((state) => {
      const current = state.messagesBySession[sessionId] || [];
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...current, message],
        },
      };
    });
  },

  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => {
    set((state) => {
      const current = state.messagesBySession[sessionId] || [];
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: current.map((m) =>
            m.id === messageId ? { ...m, ...updates } : m
          ),
        },
      };
    });
  },

  sendStreamMessage: async (
    sessionId: string,
    content: string,
    skillId?: string | null,
    parentId?: string | null
  ) => {
    const { isStreaming, stopGeneration } = get();
    if (isStreaming) {
      await stopGeneration(sessionId);
    }

    const userMsgId = `user_${Date.now()}`;
    const aiMsgId = `ai_${Date.now() + 1}`;

    const userMsg: Message = {
      id: userMsgId,
      session_id: sessionId,
      parent_id: parentId,
      role: "user",
      content,
      active_skill_id: skillId,
      status: "success",
      created_at: new Date().toISOString(),
    };

    const aiMsg: Message = {
      id: aiMsgId,
      session_id: sessionId,
      parent_id: userMsgId,
      role: "assistant",
      content: "",
      raw_tool_calls: [],
      status: "streaming",
      created_at: new Date().toISOString(),
    };

    const currentMessages = get().messagesBySession[sessionId] || [];
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...currentMessages, userMsg, aiMsg],
      },
      isStreaming: true,
      activeStreamingMessageId: aiMsgId,
      streamingSessionId: sessionId,
    }));

    const controller = new AbortController();
    set({ abortController: controller });

    const activeModel = useModelConfigStore.getState().getActiveModel();

    try {
      await sendMessageStream({
        sessionId,
        content,
        parentId: userMsgId,
        skillId,
        model: activeModel?.modelId || "deepseek-chat",
        api_key: activeModel?.apiKey || undefined,
        base_url: activeModel?.baseUrl || undefined,
        provider: activeModel?.provider || "openai",
        max_tokens: activeModel?.maxTokens || undefined,
        context_window: activeModel?.contextWindow || 1048576,
        signal: controller.signal,
        onEvent: (msg) => {
          if (controller.signal.aborted) return;

          switch (msg.event) {
            case "session_info":
              break;

            case "tool_call_start":
            case "tool_start": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) => {
                      if (m.id !== aiMsgId) return m;
                      const toolItem: ToolCallItem = {
                        id: data.tool_call_id,
                        name: data.name,
                        args: data.args || data.arguments || {},
                        status: "running",
                      };
                      return {
                        ...m,
                        raw_tool_calls: [...(m.raw_tool_calls || []), toolItem],
                      };
                    }),
                  },
                };
              });
              break;
            }

            case "tool_call_result":
            case "tool_result": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) => {
                      if (m.id !== aiMsgId) return m;
                      const tools = (m.raw_tool_calls || []).map((tc) =>
                        tc.id === data.tool_call_id
                          ? {
                              ...tc,
                              output: (data.output || data.result) as unknown as string | Record<string, unknown>,
                              latency_ms: data.latency_ms,
                              status: data.is_error ? ("failed" as const) : ("success" as const),
                            }
                          : tc
                      );
                      return { ...m, raw_tool_calls: tools };
                    }),
                  },
                };
              });
              break;
            }


            case "reasoning_delta": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            reasoning_content:
                              (m.reasoning_content || "") + data.delta,
                          }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "text_delta": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? { ...m, content: (m.content || "") + data.delta }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "usage": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            metrics: {
                              latency_ms: data.latency_ms,
                              tokens: data.tokens,
                            },
                          }
                        : m
                    ),
                  },
                };
              });
              break;
            }

            case "session_title_updated": {
              const data = msg.data;
              if (data?.title) {
                const targetSid = data.session_id || sessionId;
                useSessionStore
                  .getState()
                  .updateSessionDetails(targetSid, { title: data.title });
              }
              break;
            }

            case "done": {
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId ? { ...m, status: "success" } : m
                    ),
                  },
                  isStreaming: false,
                  activeStreamingMessageId: null,
                  streamingSessionId: null,
                  abortController: null,
                };
              });
              break;
            }

            case "error": {
              const data = msg.data;
              set((state) => {
                const list = state.messagesBySession[sessionId] || [];
                return {
                  messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: list.map((m) =>
                      m.id === aiMsgId
                        ? {
                            ...m,
                            status: "failed",
                            content:
                              (m.content || "") +
                              `\n\n*(生成中断: ${data.message || "服务异常"})*`,
                          }
                        : m
                    ),
                  },
                  isStreaming: false,
                  activeStreamingMessageId: null,
                  streamingSessionId: null,
                  abortController: null,
                };
              });
              break;
            }
          }
        },
      });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        // 用户手动停止，保留已有片段
        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === aiMsgId
                  ? {
                      ...m,
                      status: "success",
                      content:
                        (m.content || "") + "\n\n*(用户已手动终止生成)*",
                    }
                  : m
              ),
            },
          };
        });
      } else {
        set((state) => {
          const list = state.messagesBySession[sessionId] || [];
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.map((m) =>
                m.id === aiMsgId
                  ? {
                      ...m,
                      status: "failed",
                      content:
                        (m.content || "") +
                        `\n\n*(连接失败: ${err instanceof Error ? err.message : "未知错误"})*`,
                    }
                  : m
              ),
            },
          };
        });
      }
    } finally {
      set({
        isStreaming: false,
        activeStreamingMessageId: null,
        streamingSessionId: null,
        abortController: null,
      });
    }
  },

  stopGeneration: async (sessionId: string) => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
    }
    set({
      isStreaming: false,
      activeStreamingMessageId: null,
      streamingSessionId: null,
      abortController: null,
    });
    await stopGenerationApi(sessionId);
  },

  switchSession: (newSessionId: string) => {
    const { isStreaming, streamingSessionId, stopGeneration, fetchMessages } = get();
    // 会话切换熔断保护：若用户切走正在推流的会话，立即熔断上一会话，杜绝串流
    if (isStreaming && streamingSessionId && streamingSessionId !== newSessionId) {
      stopGeneration(streamingSessionId);
    }
    if (newSessionId) {
      fetchMessages(newSessionId);
    }
  },

  fetchMessages: async (sessionId: string) => {
    if (!sessionId) return;
    // 若当前会话正在推流中，切勿打断或覆盖
    if (get().isStreaming && get().streamingSessionId === sessionId) {
      return;
    }
    try {
      const res = await fetchSessionMessagesApi(sessionId);
      if (res && Array.isArray(res.items)) {
        const local = get().messagesBySession[sessionId] || [];
        // 若远程返回空但本地已存在消息（例如新建会话刚发送的消息），保留本地状态
        if (res.items.length === 0 && local.length > 0) {
          return;
        }
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: res.items,
          },
        }));
      }
    } catch (err) {
      console.warn(`[useChatStore] fetchMessages failed for ${sessionId}:`, err);
    }
  },

  editAndResendMessage: async (
    sessionId: string,
    messageId: string,
    newContent: string
  ) => {
    const current = get().messagesBySession[sessionId] || [];
    const index = current.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    // 单线分支物理修剪：截断晚于当前节点的废弃分支
    const target = current[index];
    const pruned = current.slice(0, index);

    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: pruned,
      },
    }));

    // 重新发起提问流
    await get().sendStreamMessage(
      sessionId,
      newContent,
      target.active_skill_id,
      target.parent_id
    );
  },

  regenerateAssistantMessage: async (sessionId: string, messageId: string) => {
    const current = get().messagesBySession[sessionId] || [];
    const index = current.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    const assistantMsg = current[index];
    // 找到该 AI 消息的对应用户提问节点
    const parentUserMsg = current
      .slice(0, index)
      .reverse()
      .find((m) => m.role === "user");

    if (!parentUserMsg || !parentUserMsg.content) return;

    // 截断该 AI 消息及之后的内容
    const pruned = current.slice(0, index);
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: pruned,
      },
    }));

    await get().sendStreamMessage(
      sessionId,
      parentUserMsg.content,
      parentUserMsg.active_skill_id,
      parentUserMsg.id
    );
  },

  setMessages: (sessionId: string, messages: Message[]) => {
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: messages,
      },
    }));
  },
}));
