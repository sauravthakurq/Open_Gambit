import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { analysisRequestSchema, isApprovedBaseUrl, requiresApiKey } from '@/lib/aiRequestValidation';

const DEFAULT_BASE_URLS: Record<string, string> = {
  'xAI': 'https://api.x.ai/v1',
  'DeepSeek': 'https://api.deepseek.com/v1',
  'Groq': 'https://api.groq.com/openai/v1',
  'Mistral': 'https://api.mistral.ai/v1',
  'OpenRouter': 'https://openrouter.ai/api/v1',
  'Ollama': 'http://localhost:11434/v1',
  'LM Studio': 'http://localhost:1234/v1',
};

const SYSTEM_PROMPT = `You are a Grandmaster Chess AI Analyst.
You will be provided with the PGN of a completed game.
Your task is to analyze the game and return a highly detailed, premium post-game report.

CRITICAL INSTRUCTION: You MUST return ONLY a raw JSON object. Do not include markdown blocks, greetings, or conversational text. Your output must parse perfectly with JSON.parse().

The JSON must exactly match this structure:
{
  "gameSummary": "A premium 2-3 sentence summary of the game narrative.",
  "openingDetection": "Name of the opening (e.g. 'Sicilian Defense: Najdorf Variation')",
  "openingAccuracy": 85, // integer 0-100
  "whiteAccuracy": 88, // integer 0-100
  "blackAccuracy": 72, // integer 0-100
  "moveClassifications": {
    "best": 12,
    "brilliant": 1,
    "great": 2,
    "missedWin": 0,
    "inaccuracy": 3,
    "mistake": 2,
    "blunder": 1
  },
  "criticalTurningPoint": "Description of the critical turning point in the game.",
  "tacticalOpportunities": "Analysis of missed or captured tactical opportunities.",
  "strategicSuggestions": "High-level strategic advice based on the gameplay.",
  "endgameEvaluation": "Evaluation of the endgame technique (or why it didn't reach endgame).",
  "aiCoachSummary": "A personalized, encouraging coach's summary of the player's performance.",
  "overallGameRating": "A descriptive rating (e.g. 'Masterful', 'Solid', 'Chaotic')",
  "estimatedEloPerformance": {
    "white": 1600,
    "black": 1450
  },
  "personalizedImprovementTips": [
    "Tip 1...",
    "Tip 2..."
  ]
}`;

export async function POST(req: Request) {
  try {
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > 64_000) {
      return new Response(JSON.stringify({ error: 'Request body is too large' }), { status: 413 });
    }

    const parsedRequest = analysisRequestSchema.safeParse(await req.json());
    if (!parsedRequest.success) {
      return new Response(JSON.stringify({ error: 'Invalid request payload' }), { status: 400 });
    }

    const { pgn, provider, model, apiKey, baseUrl, organization } = parsedRequest.data;

    if (!isApprovedBaseUrl(provider, baseUrl)) {
      return new Response(JSON.stringify({ error: 'Custom provider endpoints are not supported' }), { status: 400 });
    }

    if (requiresApiKey(provider) && !apiKey) {
      return new Response(JSON.stringify({ error: 'API key is required' }), { status: 400 });
    }

    const finalBaseUrl = baseUrl || DEFAULT_BASE_URLS[provider] || undefined;

    let llmModel;
    if (provider === 'OpenAI') {
      const openai = createOpenAI({ apiKey, baseURL: finalBaseUrl, organization: organization || undefined });
      llmModel = openai(model);
    } else if (provider === 'Anthropic') {
      const anthropic = createAnthropic({ apiKey, baseURL: finalBaseUrl || 'https://api.anthropic.com/v1' });
      llmModel = anthropic(model);
    } else if (provider === 'Google') {
      const google = createGoogleGenerativeAI({ apiKey, ...(finalBaseUrl && finalBaseUrl !== 'https://generativelanguage.googleapis.com/v1beta' ? { baseURL: finalBaseUrl } : {}) });
      llmModel = google(model);
    } else {
      const compatibleProvider = createOpenAI({ apiKey: apiKey || 'dummy-key', baseURL: finalBaseUrl, organization: organization || undefined });
      llmModel = compatibleProvider(model);
    }

    const { text } = await generateText({
      model: llmModel,
      system: SYSTEM_PROMPT,
      prompt: `Analyze the following chess game:\n\n${pgn}`,
      temperature: 0.2, // Low temperature for consistent JSON structure
      maxOutputTokens: 2500,
    });

    // Clean potential markdown blocks
    let cleanedText = text.trim();
    if (cleanedText.startsWith('\`\`\`json')) {
      cleanedText = cleanedText.replace(/^\`\`\`json\n?/, '').replace(/\n?\`\`\`$/, '');
    } else if (cleanedText.startsWith('\`\`\`')) {
      cleanedText = cleanedText.replace(/^\`\`\`\n?/, '').replace(/\n?\`\`\`$/, '');
    }

    try {
      const jsonResult = JSON.parse(cleanedText);
      return new Response(JSON.stringify(jsonResult), { status: 200 });
    } catch (parseError) {
      console.error('Failed to parse AI Analysis JSON:', cleanedText);
      return new Response(JSON.stringify({ error: 'AI returned malformed data', raw: cleanedText }), { status: 500 });
    }

  } catch (error: any) {
    console.error('[AI Analysis Error]:', error);
    return new Response(JSON.stringify({ error: error.message || 'Analysis failed' }), { status: error.status || 500 });
  }
}
