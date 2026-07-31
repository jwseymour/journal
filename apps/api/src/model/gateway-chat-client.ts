import { createGateway, generateText, stepCountIs, tool } from 'ai';
import { chatFailed } from '../errors.js';
import type { ChatClient, ChatCompletionRequest, ChatCompletionResult, ChatToolInvocation } from './chat-client.js';

/** A generous ceiling on how many tool-calling rounds one answer may take —
 * enough for "look up categories, call a couple of data tools, render a
 * couple of charts" without letting one request loop unboundedly against a
 * paid API. Not tuned, deliberately generous. */
const MAX_STEPS = 8;

/**
 * The one implementation of `ChatClient` that actually calls a model,
 * sibling to `GatewayModelClient`. Same gateway, same "confirmed by hand"
 * standard, different AI SDK primitive: `generateText` with `tools` instead
 * of `generateObject`, because a chat turn needs to call tools mid-answer
 * rather than produce one structured object.
 */
export class GatewayChatClient implements ChatClient {
  readonly #gateway: ReturnType<typeof createGateway>;
  readonly #modelId: string;

  constructor(apiKey: string, modelId: string) {
    this.#gateway = createGateway({ apiKey });
    this.#modelId = modelId;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const tools = Object.fromEntries(
      Object.entries(request.tools).map(([name, def]) => [
        name,
        tool({
          description: def.description,
          inputSchema: def.argsSchema,
          execute: def.execute,
        }),
      ]),
    );

    let result;
    try {
      result = await generateText({
        model: this.#gateway(this.#modelId),
        system: request.system,
        messages: request.messages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
      });
    } catch (cause) {
      throw chatFailed(`The model '${this.#modelId}' could not complete this chat turn.`, cause);
    }

    const toolInvocations: ChatToolInvocation[] = result.toolResults.map((toolResult) => ({
      toolName: toolResult.toolName,
      args: (toolResult as { input?: unknown }).input,
      result: (toolResult as { output?: unknown }).output,
    }));

    return { text: result.text, toolInvocations };
  }
}

/**
 * Stands in when `AI_GATEWAY_API_KEY` is not configured, mirroring
 * `UnconfiguredModelClient` — boot must not refuse to start over an optional
 * subsystem, so `POST /chat` fails clearly at the moment it is used instead.
 */
export class UnconfiguredChatClient implements ChatClient {
  async complete(): Promise<ChatCompletionResult> {
    throw chatFailed('AI_GATEWAY_API_KEY is not set. Chat needs a Vercel AI Gateway key — see README.md.');
  }
}
