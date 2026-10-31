import { z } from "zod";

const providers = [
  "OpenAI",
  "Anthropic",
  "Google",
  "xAI",
  "DeepSeek",
  "Groq",
  "Mistral",
  "OpenRouter",
  "Ollama",
  "LM Studio",
] as const;

export type AIProvider = (typeof providers)[number];

const providerSchema = z.enum(providers);

const commonFields = {
  provider: providerSchema,
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(512).optional(),
  baseUrl: z.string().url().max(200).optional(),
  organization: z.string().trim().min(1).max(200).optional(),
};

export const chatRequestSchema = z.object({
  ...commonFields,
  prompt: z.string().trim().min(1).max(16_000),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4_096).optional(),
}).strict();

export const analysisRequestSchema = z.object({
  ...commonFields,
  pgn: z.string().trim().min(1).max(50_000),
}).strict();

const approvedBaseUrls: Partial<Record<AIProvider, string>> = {
  xAI: "https://api.x.ai/v1",
  DeepSeek: "https://api.deepseek.com/v1",
  Groq: "https://api.groq.com/openai/v1",
  Mistral: "https://api.mistral.ai/v1",
  OpenRouter: "https://openrouter.ai/api/v1",
  Ollama: "http://localhost:11434/v1",
  "LM Studio": "http://localhost:1234/v1",
};

/**
 * Prevents server-side requests to arbitrary user-provided hosts. Provider
 * endpoints are intentionally fixed; add a reviewed provider here if needed.
 */
export function isApprovedBaseUrl(provider: AIProvider, baseUrl?: string) {
  if (!baseUrl) return true;
  const approved = approvedBaseUrls[provider];
  return Boolean(approved && baseUrl.replace(/\/$/, "") === approved);
}

export function requiresApiKey(provider: AIProvider) {
  return provider !== "Ollama" && provider !== "LM Studio";
}