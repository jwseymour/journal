import type { z } from 'zod';

/**
 * The seam for the chat feature ("further features", `requirements.md` §8),
 * a sibling to `ModelClient` rather than a reuse of it — `ModelClient.extract`
 * is schema-locked one-shot structured extraction, the wrong shape for a
 * multi-turn conversation that needs to call tools mid-answer. Same
 * discipline as `model-client.ts` even so: this is the interface, prompts
 * and orchestration above it know nothing about the Vercel AI Gateway, the
 * AI SDK, or which provider is serving a request.
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * One capability the model may invoke mid-conversation. `argsSchema` is
 * validated the same way `ExtractionRequest.schema` is — Zod is already the
 * trusted boundary for anything a model produces in this codebase.
 *
 * Deliberately not generic over its args/result type: `ChatOrchestrator`
 * stores many of these together in one `Record<string, ChatTool>`, so each
 * `execute` narrows its own `args` from `unknown` internally (the AI SDK has
 * already validated it against `argsSchema` by the time this runs) rather
 * than the interface pretending to know each tool's shape statically.
 */
export interface ChatTool {
  description: string;
  argsSchema: z.ZodType<unknown>;
  execute: (args: unknown) => Promise<unknown> | unknown;
}

export interface ChatCompletionRequest {
  /** Instructions that hold for the whole turn — never per-message content,
   * the same division `ExtractionRequest.system`/`prompt` already draws. */
  system: string;
  messages: ChatMessage[];
  tools: Record<string, ChatTool>;
}

/** One tool invocation the model actually made, in call order. */
export interface ChatToolInvocation {
  toolName: string;
  args: unknown;
  result: unknown;
}

export interface ChatCompletionResult {
  text: string;
  toolInvocations: ChatToolInvocation[];
}

export interface ChatClient {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
