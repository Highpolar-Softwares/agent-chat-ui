import React, {
  createContext,
  useContext,
  ReactNode,
  useState,
  useEffect,
} from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import { type Message } from "@langchain/langgraph-sdk";
import {
  uiMessageReducer,
  isUIMessage,
  isRemoveUIMessage,
  type UIMessage,
  type RemoveUIMessage,
} from "@langchain/langgraph-sdk/react-ui";
import { useQueryState } from "nuqs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LangGraphLogoSVG } from "@/components/icons/langgraph";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";
import { PasswordInput } from "@/components/ui/password-input";
import { getApiKey } from "@/lib/api-key";
import { useThreads } from "./Thread";
import { toast } from "sonner";
import { AIMessage } from "@langchain/core/messages";

export type StateType = { messages: Message[]; ui?: UIMessage[] };

const useTypedStream = useStream<
  StateType,
  {
    UpdateType: {
      messages?: Message[] | Message | string;
      ui?: (UIMessage | RemoveUIMessage)[] | UIMessage | RemoveUIMessage;
      context?: Record<string, unknown>;
    };
    CustomEventType: UIMessage | RemoveUIMessage;
  }
>;

type StreamContextType = ReturnType<typeof useTypedStream>;
const StreamContext = createContext<StreamContextType | undefined>(undefined);

async function sleep(ms = 4000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkGraphStatus(
  apiUrl: string,
  apiKey: string | null,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/info`, {
      ...(apiKey && {
        headers: {
          "X-Api-Key": apiKey,
        },
      }),
    });

    return res.ok;
  } catch (e) {
    console.error(e);
    return false;
  }
}

const StreamSession = ({
  children,
  apiKey,
  apiUrl,
  assistantId,
}: {
  children: ReactNode;
  apiKey: string | null;
  apiUrl: string;
  assistantId: string;
}) => {
  const [threadId, setThreadId] = useQueryState("threadId");
  const { getThreads, setThreads } = useThreads();
  const [liveMessage, setLiveMessage] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const streamValue = useTypedStream({
    apiUrl,
    apiKey: apiKey ?? undefined,
    assistantId,
    threadId: threadId ?? null,

    onCustomEvent: (event, options) => {
      if (isUIMessage(event) || isRemoveUIMessage(event)) {
        console.log("UI message received:", event);
        options.mutate((prev) => {
          const ui = uiMessageReducer(prev.ui ?? [], event);
          return { ...prev, ui };
        });
      }
    },
    /* … your config … */
    onUpdateEvent: (update) => {
      console.log("🔄 state-update from server:", update);
      setLiveMessage("");
    },

    // 3) tap into the token events here:
    onLangChainEvent: ({ event, data }) => {
      console.log("LangChain event received:", event, data);

      if (event === "on_chain_stream" || event === "on_chat_model_stream") {
        // Handle chain stream events if needed
        const dataWithChunk = data as any;
        if (dataWithChunk?.chunk && dataWithChunk.chunk.id) {
          const chunkId = dataWithChunk.chunk.id;
          const chunkContent = dataWithChunk.chunk.content;

          // Only process if we have valid content
          if (
            chunkContent !== undefined &&
            chunkContent !== null &&
            chunkContent !== ""
          ) {
            setMessages((prevMessages) => {
              const existingMessageIndex = prevMessages.findIndex(
                (msg) => msg.id === chunkId,
              );

              if (existingMessageIndex !== -1) {
                // Message exists, append content
                const updatedMessages = [...prevMessages];
                const existingMessage = updatedMessages[existingMessageIndex];

                if (typeof chunkContent === "string") {
                  updatedMessages[existingMessageIndex] = {
                    ...existingMessage,
                    content: (existingMessage.content || "") + chunkContent,
                  };
                } else if (Array.isArray(chunkContent)) {
                  updatedMessages[existingMessageIndex] = {
                    ...existingMessage,
                    content: Array.isArray(existingMessage.content)
                      ? [...existingMessage.content, ...chunkContent]
                      : [existingMessage.content, ...chunkContent],
                  };
                }

                return updatedMessages;
              } else {
                // Message doesn't exist, add as new message
                return [
                  ...prevMessages,
                  {
                    id: chunkId,
                    content: chunkContent,
                    ...dataWithChunk.chunk,
                  },
                ];
              }
            });
          }
        }
      } else if (
        event === "on_chain_end" ||
        event === "on_tool_end" ||
        event === "on_chat_model_end"
      ) {
        // Handle chain end event
        const dataWithOutput = data as any;
        if (
          dataWithOutput?.output?.messages &&
          Array.isArray(dataWithOutput.output.messages)
        ) {
          const newMessages = dataWithOutput.output.messages;

          setMessages((prevMessages) => {
            // Use prevMessages instead of stale messages state
            const existingIds = new Set(prevMessages.map((msg) => msg.id));
            const uniqueNewMessages = newMessages.filter(
              (msg: any) => msg.id && !existingIds.has(msg.id),
            );

            // Only add messages if we have new unique ones
            if (uniqueNewMessages.length > 0) {
              return [...prevMessages, ...uniqueNewMessages];
            }

            return prevMessages;
          });
        }
      } else if (
        event === "on_chain_start" ||
        event === "on_tool_start" ||
        event === "on_chat_model_start"
      ) {
        // Handle chain start event
      }
    },
    onThreadId: (id) => {
      setThreadId(id);
      setLiveMessage("");
      // Refetch threads list when thread ID changes.
      // Wait for some seconds before fetching so we're able to get the new thread that was created.
      sleep().then(() => getThreads().then(setThreads).catch(console.error));
    },
  });

  useEffect(() => {
    checkGraphStatus(apiUrl, apiKey).then((ok) => {
      if (!ok) {
        toast.error("Failed to connect to LangGraph server", {
          description: () => (
            <p>
              Please ensure your graph is running at <code>{apiUrl}</code> and
              your API key is correctly set (if connecting to a deployed graph).
            </p>
          ),
          duration: 10000,
          richColors: true,
          closeButton: true,
        });
      }
    });
  }, [apiKey, apiUrl]);
  useEffect(() => {
    console.log("StreamProvider values:", streamValue);

    // Check for messages in streamValue.messages that are not in our local messages state
    if (streamValue.messages && Array.isArray(streamValue.messages)) {
      const streamMessages = streamValue.messages;

      setMessages((prevMessages) => {
        // Get existing message IDs from our local state
        const existingIds = new Set(prevMessages.map((msg) => msg.id));

        // Find messages from streamValue that are not in our local state
        const newMessagesFromStream = streamMessages.filter(
          (msg: any) => msg.id && !existingIds.has(msg.id),
        );

        // Only update if we have new messages to add
        if (newMessagesFromStream.length > 0) {
          console.log(
            "Adding new messages from streamValue:",
            newMessagesFromStream,
          );
          return [...prevMessages, ...newMessagesFromStream];
        }

        return prevMessages;
      });
    }

    return () => {};
  }, [streamValue]);

  useEffect(() => {
    console.log("---------MESSAGES UPDATED------------", messages);

    return () => {};
  }, [messages]);
  return (
    <StreamContext.Provider
      value={{
        ...streamValue,
        messages: messages,
        // messages: streamValue.isLoading
        //   ? streamValue.messages.concat([new AIMessage(liveMessage)])
        //   : streamValue.messages,
      }}
    >
      {children}
    </StreamContext.Provider>
  );
};

// Default values for the form
const DEFAULT_API_URL = "http://localhost:2024";
const DEFAULT_ASSISTANT_ID = "agent";

export const StreamProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  // Get environment variables
  const envApiUrl: string | undefined = process.env.NEXT_PUBLIC_API_URL;
  const envAssistantId: string | undefined =
    process.env.NEXT_PUBLIC_ASSISTANT_ID;

  // Use URL params with env var fallbacks
  const [apiUrl, setApiUrl] = useQueryState("apiUrl", {
    defaultValue: envApiUrl || "",
  });
  const [assistantId, setAssistantId] = useQueryState("assistantId", {
    defaultValue: envAssistantId || "",
  });

  // For API key, use localStorage with env var fallback
  const [apiKey, _setApiKey] = useState(() => {
    const storedKey = getApiKey();
    return storedKey || "";
  });

  const setApiKey = (key: string) => {
    window.localStorage.setItem("lg:chat:apiKey", key);
    _setApiKey(key);
  };

  // Determine final values to use, prioritizing URL params then env vars
  const finalApiUrl = apiUrl || envApiUrl;
  const finalAssistantId = assistantId || envAssistantId;

  // Show the form if we: don't have an API URL, or don't have an assistant ID
  if (!finalApiUrl || !finalAssistantId) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="animate-in fade-in-0 zoom-in-95 bg-background flex max-w-3xl flex-col rounded-lg border shadow-lg">
          <div className="mt-14 flex flex-col gap-2 border-b p-6">
            <div className="flex flex-col items-start gap-2">
              <LangGraphLogoSVG className="h-7" />
              <h1 className="text-xl font-semibold tracking-tight">
                Agent Chat
              </h1>
            </div>
            <p className="text-muted-foreground">
              Welcome to Agent Chat! Before you get started, you need to enter
              the URL of the deployment and the assistant / graph ID.
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();

              const form = e.target as HTMLFormElement;
              const formData = new FormData(form);
              const apiUrl = formData.get("apiUrl") as string;
              const assistantId = formData.get("assistantId") as string;
              const apiKey = formData.get("apiKey") as string;

              setApiUrl(apiUrl);
              setApiKey(apiKey);
              setAssistantId(assistantId);

              form.reset();
            }}
            className="bg-muted/50 flex flex-col gap-6 p-6"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="apiUrl">
                Deployment URL<span className="text-rose-500">*</span>
              </Label>
              <p className="text-muted-foreground text-sm">
                This is the URL of your LangGraph deployment. Can be a local, or
                production deployment.
              </p>
              <Input
                id="apiUrl"
                name="apiUrl"
                className="bg-background"
                defaultValue={apiUrl || DEFAULT_API_URL}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="assistantId">
                Assistant / Graph ID<span className="text-rose-500">*</span>
              </Label>
              <p className="text-muted-foreground text-sm">
                This is the ID of the graph (can be the graph name), or
                assistant to fetch threads from, and invoke when actions are
                taken.
              </p>
              <Input
                id="assistantId"
                name="assistantId"
                className="bg-background"
                defaultValue={assistantId || DEFAULT_ASSISTANT_ID}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="apiKey">LangSmith API Key</Label>
              <p className="text-muted-foreground text-sm">
                This is <strong>NOT</strong> required if using a local LangGraph
                server. This value is stored in your browser's local storage and
                is only used to authenticate requests sent to your LangGraph
                server.
              </p>
              <PasswordInput
                id="apiKey"
                name="apiKey"
                defaultValue={apiKey ?? ""}
                className="bg-background"
                placeholder="lsv2_pt_..."
              />
            </div>

            <div className="mt-2 flex justify-end">
              <Button
                type="submit"
                size="lg"
              >
                Continue
                <ArrowRight className="size-5" />
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <StreamSession
      apiKey={apiKey}
      apiUrl={apiUrl}
      assistantId={assistantId}
    >
      {children}
    </StreamSession>
  );
};

// Create a custom hook to use the context
export const useStreamContext = (): StreamContextType => {
  const context = useContext(StreamContext);
  if (context === undefined) {
    throw new Error("useStreamContext must be used within a StreamProvider");
  }
  return context;
};

export default StreamContext;
