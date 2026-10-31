import { describe, expect, it } from 'vitest';
import {
  analysisRequestSchema,
  chatRequestSchema,
  isApprovedBaseUrl,
  requiresApiKey,
} from '../src/lib/aiRequestValidation';

describe('AI request validation', () => {
  it('accepts a bounded valid chat request', () => {
    const result = chatRequestSchema.safeParse({
      provider: 'OpenAI',
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      prompt: 'FEN: startpos\nLegal Moves: e2e4',
      temperature: 0.2,
      maxTokens: 10,
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown providers and unexpected payload fields', () => {
    expect(chatRequestSchema.safeParse({
      provider: 'Untrusted proxy',
      model: 'model',
      prompt: 'move',
    }).success).toBe(false);

    expect(chatRequestSchema.safeParse({
      provider: 'OpenAI',
      model: 'model',
      prompt: 'move',
      unsafeField: true,
    }).success).toBe(false);
  });

  it('rejects oversized prompts and malformed analysis payloads', () => {
    expect(chatRequestSchema.safeParse({
      provider: 'OpenAI',
      model: 'model',
      prompt: 'x'.repeat(16_001),
    }).success).toBe(false);

    expect(analysisRequestSchema.safeParse({
      provider: 'OpenAI',
      model: 'model',
      pgn: '',
    }).success).toBe(false);
  });

  it('only permits reviewed provider endpoints', () => {
    expect(isApprovedBaseUrl('Groq', 'https://api.groq.com/openai/v1')).toBe(true);
    expect(isApprovedBaseUrl('Groq', 'https://example.com/v1')).toBe(false);
    expect(isApprovedBaseUrl('OpenAI', 'https://example.com/v1')).toBe(false);
    expect(isApprovedBaseUrl('OpenAI')).toBe(true);
  });

  it('requires credentials only for cloud providers', () => {
    expect(requiresApiKey('OpenAI')).toBe(true);
    expect(requiresApiKey('Ollama')).toBe(false);
    expect(requiresApiKey('LM Studio')).toBe(false);
  });
});
