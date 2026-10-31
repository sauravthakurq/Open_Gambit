import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { chatRequestSchema, isApprovedBaseUrl, requiresApiKey } from '@/lib/aiRequestValidation';

const DEFAULT_BASE_URLS: Record<string, string> = {
  'xAI': 'https://api.x.ai/v1',
  'DeepSeek': 'https://api.deepseek.com/v1',
  'Groq': 'https://api.groq.com/openai/v1',
  'Mistral': 'https://api.mistral.ai/v1',
  'OpenRouter': 'https://openrouter.ai/api/v1',
  'Ollama': 'http://localhost:11434/v1',
  'LM Studio': 'http://localhost:1234/v1',
};

/** Extract retry delay in ms from rate limit error messages */
function parseRetryAfterMs(errorMessage: string): number | null {
  // "Please retry in 27.843601661s"
  const match = errorMessage.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    return Math.ceil(seconds * 1000) + 500; // add 500ms buffer
  }
  return null;
}

/** Check if an error is a rate limit / quota error */
function isRateLimitError(error: any): boolean {
  const msg = (error?.message || '').toLowerCase();
  return (
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('429') ||
    error?.status === 429
  );
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  try {
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > 64_000) {
      return new Response(JSON.stringify({ error: 'Request body is too large' }), { status: 413 });
    }

    const parsedRequest = chatRequestSchema.safeParse(await req.json());
    if (!parsedRequest.success) {
      return new Response(JSON.stringify({ error: 'Invalid request payload' }), { status: 400 });
    }

    const { provider, model, apiKey, baseUrl, organization, temperature, maxTokens, prompt } = parsedRequest.data;

    if (!isApprovedBaseUrl(provider, baseUrl)) {
      return new Response(JSON.stringify({ error: 'Custom provider endpoints are not supported' }), { status: 400 });
    }

    if (requiresApiKey(provider) && !apiKey) {
      return new Response(JSON.stringify({ error: 'API key is required' }), { status: 400 });
    }

    const finalBaseUrl = baseUrl || DEFAULT_BASE_URLS[provider] || undefined;

    let llmModel;
    if (provider === 'OpenAI') {
      const openai = createOpenAI({
        apiKey,
        baseURL: finalBaseUrl,
        organization: organization || undefined,
      });
      llmModel = openai(model);
    } else if (provider === 'Anthropic') {
      const anthropic = createAnthropic({
        apiKey,
        // Use default Anthropic endpoint — custom baseUrl rarely needed
        baseURL: finalBaseUrl || 'https://api.anthropic.com/v1',
      });
      llmModel = anthropic(model);
    } else if (provider === 'Google') {
      const google = createGoogleGenerativeAI({
        apiKey,
        // Google SDK uses its own base URL, don't override unless explicitly set
        ...(finalBaseUrl && finalBaseUrl !== 'https://generativelanguage.googleapis.com/v1beta' ? { baseURL: finalBaseUrl } : {}),
      });
      llmModel = google(model);
    } else {
      // For all other providers (DeepSeek, xAI, Groq, Mistral, OpenRouter, Cohere, Custom, etc)
      // OpenAI-compatible REST API via baseURL
      const compatibleProvider = createOpenAI({
        apiKey: apiKey || 'dummy-key',
        baseURL: finalBaseUrl,
        organization: organization || undefined,
      });
      llmModel = compatibleProvider(model);
    }

    // Retry loop with smart rate-limit handling
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { text } = await generateText({
          model: llmModel,
          system: `You are an expert chess engine and grandmaster. You will be provided with the current board state in FEN notation, the move history in PGN, and a strict list of ALL currently legal UCI moves. 
Your ONLY goal is to evaluate the position and return the absolute best legal move in strict UCI format (e.g. 'e2e4', 'e7e8q').
CRITICAL RULES:
1. You MUST respond with exactly 4 or 5 lowercase letters/numbers and absolutely nothing else.
2. No conversational text, no markdown, no punctuation.
3. Your move MUST be chosen from the provided list of Legal Moves. If you suggest a move not in the list, you lose the game immediately.`,
          prompt,
          maxOutputTokens: 10,
          temperature: temperature !== undefined ? temperature : 0.1,
        });

        // Clean the LLM output aggressively: remove newlines, quotes, markdown, and trim
        let cleanedMove = text.trim().toLowerCase();
        cleanedMove = cleanedMove.replace(/[^a-h1-8qrbn]/g, ''); // Extract only valid UCI characters

        console.log(`[AI Response] Status: 200 OK | Move: ${cleanedMove}`);
        return new Response(JSON.stringify({ bestMove: cleanedMove }), { status: 200 });

      } catch (error: any) {
        lastError = error;
        console.error(`[AI SDK Error] (attempt ${attempt}/3):`, error?.message || error);

        if (isRateLimitError(error)) {
          const retryAfterMs = parseRetryAfterMs(error.message || '');
          if (retryAfterMs) {
            console.log(`Rate limited. Waiting ${retryAfterMs}ms before retry...`);
            await sleep(retryAfterMs);
          } else {
            // Exponential backoff: 5s, 15s, 30s
            const backoff = attempt === 1 ? 5000 : attempt === 2 ? 15000 : 30000;
            console.log(`Rate limited. Backing off ${backoff}ms...`);
            await sleep(backoff);
          }
          // Return 429 so the client knows to back off too (not 500)
          if (attempt === 3) {
            return new Response(
              JSON.stringify({
                error: 'rate_limited',
                message: error.message,
                retryAfterMs: parseRetryAfterMs(error.message || '') ?? 30000,
              }),
              { status: 429 }
            );
          }
          continue; // retry after sleep
        }

        // Non-rate-limit error: fail fast
        if (error?.status === 401 || (error?.message || '').toLowerCase().includes('api key') || (error?.message || '').toLowerCase().includes('401')) {
          console.error(`[AI Authentication Error] 401 Unauthorized for provider ${provider}. API Key is likely invalid or expired.`);
          return new Response(JSON.stringify({ error: 'invalid_api_key', message: error.message }), { status: 401 });
        }
        
        if (error?.status === 400 || error?.status === 404 || (error?.message || '').toLowerCase().includes('model')) {
          console.error(`[AI Model Error] ${error?.status} for provider ${provider}. Model unsupported or invalid parameters.`);
          return new Response(JSON.stringify({ error: 'invalid_model', message: error.message }), { status: 400 });
        }
        
        console.error(`[AI General Error] ${error?.status || 500} for provider ${provider}: ${error?.message}`);
        return new Response(JSON.stringify({ error: 'api_error', message: error.message }), { status: 500 });
      }
    }

    return new Response(
      JSON.stringify({ error: `Failed after 3 attempts. Last error: ${lastError?.message}` }),
      { status: 500 }
    );
  } catch (error: any) {
    console.error('AI SDK Fatal Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
