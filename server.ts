import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, LiveServerMessage, Modality, ThinkingLevel } from '@google/genai';
import { buildChronometricContext } from './src/services/chronometry.js';
import {
  AI_AGENTS,
  AGENT_LIST,
  detectTaskIntent,
  buildDynamicResponseGuidance,
  AgentId,
  AgentRoutingResult,
} from './src/services/agents.js';
import {
  checkUserAccessAndLimits,
  recordChatEvent,
  recordSearchEvent,
  recordImageEvent,
  recordVoiceSessionEvent,
  getOrCreateSessionUser,
} from './src/services/adminStore.js';
import {
  createAdminRouter,
  handlePaymentWebhook,
  resolveRequestUserId,
  parseCookies,
} from './src/services/adminRoutes.js';
import { createUserAuthRouter } from './src/services/userAuthRoutes.js';
import { createNotificationRouter } from './src/services/notificationRoutes.js';
import {
  getGeminiProviderInstance,
  getQwenProviderInstance,
  resolveBackendGeminiModelPair,
} from './src/services/aiProvider.js';
import { createApiV1Router } from './src/services/apiV1Routes.js';
import { createAppBuilderRouter } from './src/services/appBuilderRoutes.js';
import { createCreatorStudioRouter } from './src/services/creatorStudioRoutes.js';
import { createSubscriptionRouter } from './src/services/subscriptionRoutes.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Body parsing with safe limits
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS support for Capacitor Android APK (https://localhost, capacitor://localhost) and separate web frontends
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, x-andaman-session-token, x-creator-user-id'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Supported Gemini Models (mapped to ANDAMAN display names)
export const AVAILABLE_MODELS = [
  {
    id: 'gemini-3.8-flash',
    name: 'ANDAMAN 2.9 PRO',
    badge: 'Pro Reasoning',
    description: 'Fast, multimodal, state-of-the-art general intelligence for everyday tasks, coding, and reasoning.',
    supportsVision: true,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'ANDAMAN LITE',
    badge: 'Ultra Fast',
    description: 'Lightweight and low latency for instant responses and concise answers.',
    supportsVision: true,
  },
  {
    id: 'andaman-5.2',
    name: 'ANDAMAN 5.2',
    badge: 'Flagship',
    description: 'Advanced deep reasoning, multi-step analysis, and high-precision problem solving.',
    supportsVision: true,
  },
];

export const LIVE_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];

const DEFAULT_SYSTEM_INSTRUCTION = `You are ANDAMAN AI, an intelligent, modern, friendly, and ultra-fast personal AI assistant.
CRITICAL IDENTITY & SILENT ROUTING RULE:
- All internal specialist agents work silently in the background.
- NEVER display, mention, or refer to internal agent names (such as AERON, NOVEX, VEXOR, ZENIQ, PIXORA, or CODEX) in user-facing responses.
- Never state which internal agent is processing or answering. Users must see only the final answer directly from ANDAMAN AI.

# CORE RESPONSE QUALITY & FORMATTING CONSTITUTION (CHATGPT-GRADE)

1. Smart Message Understanding & Adaptive Length
- Understand every user message according to its actual meaning and intent (greetings, casual conversation, questions, explanations, app ideas, website development, coding, image-generation prompts, business plans, translations, writing, troubleshooting, and general knowledge).
- Do NOT treat every message as a request for a long essay. Choose the response length according to the user's needs:
  • Greetings & Simple Conversational Messages ("Hi", "Hello", "Thanks", "কেমন আছো?", "नमस्ते"): Respond naturally, warmly, and briefly in 1–2 sentences without headings or lists.
  • Simple Direct Questions: Answer directly and concisely first.
  • Explanations, Guides, Coding, Prompts & Multi-Part Questions: Provide complete, well-organized, beginner-friendly answers without stopping prematurely.

2. ChatGPT-Style Response Formatting
- For questions that need explanation or depth, organize your answer clearly so beginners can understand it effortlessly:
  • Use clear headings (##) and subheadings (###).
  • Use numbered steps (1., 2., 3.) for sequential instructions and workflows.
  • Use bullet points (-) for features, examples, pros/cons, and key points.
  • Write short paragraphs (2–4 sentences) with clean visual spacing.
  • Include concrete real-world examples when they improve understanding.
  • Use fenced Markdown code blocks (\`\`\`html, \`\`\`tsx, \`\`\`python, \`\`\`bash, \`\`\`prompt) for code and copyable prompts.
  • Use Markdown tables ONLY when comparing structured attributes.
  • Finish detailed explanations with a clear conclusion or helpful next step.
- Avoid messy formatting, unnecessary repetition, incomplete sentences, and long unbroken walls of text.

3. Line-by-Line Step-by-Step Explanations ("How-To" Requests)
- Whenever a user asks how to do something (e.g., how to create an app, set up a tool, deploy a site, or troubleshoot an issue), explain it line by line and step by step for a beginner:
  • **Step 1: What to open** (exact tool, website, editor, or app to open).
  • **Step 2: Where to click** (exact buttons, menus, or tabs to click, bolding UI names).
  • **Step 3: What to enter or copy** (exact text, prompt, command, or code to enter/copy).
  • **Step 4: What to do next** (how to run, build, save, or proceed).
  • **Step 5: How to verify that it works** (how to test and confirm success).
- Never skip important steps, and adapt instructions to the user's experience level.

4. Complete Ready-to-Copy Prompt Generation
- When a user asks for an AI prompt (for an app, website, image, video, dashboard, chatbot, or tool), generate a complete, ready-to-copy prompt inside a fenced \`\`\`prompt block, and structure the prompt specification with clear headings and numbered requirements covering:
  1. **Objective**
  2. **Design and Style**
  3. **Required Features**
  4. **Behavior and Logic**
  5. **Technical Requirements**
  6. **Error Handling**
  7. **Testing Instructions**

5. Language & Personalization (English, Bengali, Hindi)
- Reply in the language used by the user unless they explicitly request another language:
  • If the user writes in Bengali (বাংলা), respond in clear, natural Bengali.
  • If the user writes in English, respond in clear, natural English.
  • If the user writes in Hindi (हिन्दी), respond in clear, natural Hindi.
- Keep code syntax, CLI commands, and API identifiers in standard universal code format.
- Respect the user's requested format, tone, and level of detail.

6. Accuracy, Honesty & Complete Answers
- Never invent facts, sources, API results, URLs, or technical capabilities.
- When current or external information is needed, rely on the verified web search results provided to you and clearly distinguish verified facts from uncertainty.
- Never claim an external action (e.g., setting an OS alarm, deploying a live server, or running a search that failed) succeeded unless verified.
- Address every part of a multi-part question completely without stopping after just an introduction. If a request is genuinely ambiguous, provide helpful guidance first and ask at most ONE short clarification question at the end.`;

/**
 * Sanitizes internal errors so raw stack traces, file paths, or secret keys/tokens
 * are never exposed to end users.
 */
function sanitizeClientError(err: any, fallbackMessage = 'An unexpected error occurred while processing your request.'): string {
  if (!err) return fallbackMessage;
  const raw = typeof err === 'string' ? err : err?.message || fallbackMessage;

  // Strip any accidental key/token strings, file paths, or stack lines
  let cleaned = String(raw)
    .replace(/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
    .replace(/tvly-[0-9A-Za-z-_]{15,}/g, '[REDACTED]')
    .replace(/Bearer\s+[0-9A-Za-z._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bat\s+[^\n]+(\n|$)/g, '')
    .trim();

  if (/quota|429|rate limit|resource_exhausted/i.test(cleaned)) {
    return 'The AI service is temporarily rate-limited or out of quota. Please wait a moment and try again.';
  }
  if (/timeout|timed out|etimedout|econnreset|socket hang up/i.test(cleaned)) {
    return 'The request timed out while waiting for the AI service. Please try again.';
  }
  if (/api_key_invalid|invalid api key|unauthenticated|401/i.test(cleaned)) {
    return 'The configured API key was rejected by the upstream service. Please verify your API key in AI Studio Secrets.';
  }

  if (cleaned.length > 360) {
    cleaned = cleaned.slice(0, 360) + '...';
  }
  return cleaned || fallbackMessage;
}

/**
 * Executes an async operation with a strict timeout and safe retry for transient network/5xx errors.
 */
async function withTimeoutAndRetry<T>(
  operation: () => Promise<T>,
  options: { timeoutMs?: number; retries?: number; delayMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 40000, retries = 1, delayMs = 600 } = options;
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        ),
      ]);
      return result;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || '');
      const isTransient =
        /502|503|504|overloaded|unavailable|econnreset|etimedout|timeout|timed out|fetch failed|network|socket hang up/i.test(msg);
      if (attempt < retries && isTransient) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Cached Gemini SDK client to avoid per-request instantiation overhead
let cachedServerGeminiClient: GoogleGenAI | null = null;
let cachedServerGeminiKey: string | null = null;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (cachedServerGeminiClient && cachedServerGeminiKey === apiKey) {
    return cachedServerGeminiClient;
  }
  cachedServerGeminiKey = apiKey;
  cachedServerGeminiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return cachedServerGeminiClient;
}

// Hybrid Intent Router: Fast Deterministic + Optional Lightweight AI Classification
export async function routeMessageToAgent(
  ai: GoogleGenAI | null,
  query: string,
  options?: { explicitWebSearch?: boolean; hasImageAttachment?: boolean; useAiClassifier?: boolean }
): Promise<AgentRoutingResult> {
  const baseResult = detectTaskIntent(query, options);

  // If high confidence or no AI client or short query, return immediately (avoids redundant model calls)
  if (
    baseResult.confidence === 'high' ||
    !ai ||
    options?.useAiClassifier === false ||
    query.trim().split(/\s+/).length <= 4
  ) {
    return baseResult;
  }

  // For medium-confidence / nuanced queries, optionally classify with ultra-fast gemini-3.1-flash-lite
  try {
    const classifyPromise = ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `Classify the following user message into ONE primary assistant ID from this exact list:
- AERON: General personal assistant, everyday conversation, daily planning, routines, reminders
- NOVEX: Research and reasoning assistant, current web information, smartphone/product prices, latest news, comparisons
- VEXOR: Coding and debugging assistant, diagnosing bugs, fixing errors, stack traces, code review
- ZENIQ: Learning and explanation assistant, explaining educational/scientific concepts, translation, summarization
- PIXORA: Image generation assistant, generating or drawing an AI image, picture, photo, or artwork
- CODEX: Programming and app development assistant, building websites, full apps, or software features

Return ONLY the single uppercase assistant ID (AERON, NOVEX, VEXOR, ZENIQ, PIXORA, or CODEX).

User message: "${query.slice(0, 400)}"`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1800));
    const res = await Promise.race([classifyPromise, timeoutPromise]);
    if (res && res.text) {
      const cleaned = res.text.trim().toUpperCase();
      const matchedId = (['AERON', 'NOVEX', 'VEXOR', 'ZENIQ', 'PIXORA', 'CODEX'] as AgentId[]).find(
        (id) => cleaned.includes(id)
      );
      if (matchedId && AI_AGENTS[matchedId]) {
        const agent = AI_AGENTS[matchedId];
        return {
          agentId: matchedId,
          agentName: agent.name,
          agentTitle: agent.title,
          reason: `Routed by AI intent classifier to ${agent.name} (${agent.title})`,
          confidence: 'ai',
          requiresWebSearch: matchedId === 'NOVEX' || options?.explicitWebSearch === true,
          requiresImageGeneration: matchedId === 'PIXORA',
        };
      }
    }
  } catch (err: any) {
    // Gracefully fall back to deterministic routing without failing the request
  }

  return baseResult;
}

// Status endpoint
app.get('/api/status', (req, res) => {
  resolveRequestUserId(req, res);
  const ai = getGeminiClient();
  const qwenProvider = getQwenProviderInstance();
  const hasTavilyKey = !!(process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY.trim() !== '' && process.env.TAVILY_API_KEY !== 'MY_TAVILY_API_KEY');
  res.json({
    hasKey: !!ai,
    hasTavilyKey,
    searchProvider: hasTavilyKey ? 'tavily' : 'open-web',
    defaultModel: 'gemini-3.8-flash',
    availableModels: [...AVAILABLE_MODELS, ...qwenProvider.listModels()],
    qwen: {
      modelId: qwenProvider.getDefaultModel(),
      endpointConfigured: qwenProvider.isEndpointConfigured(),
      fallbackToGemini: qwenProvider.isFallbackToGeminiEnabled(),
    },
    liveVoices: LIVE_VOICES,
    agents: AGENT_LIST.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      shortRole: a.shortRole,
      description: a.description,
    })),
    appName: 'ANDAMAN AI',
    status: 'online',
    supportsLiveCall: true,
  });
});

// Get all 6 AI Assistants metadata
app.get('/api/agents', (req, res) => {
  res.json({
    agents: AGENT_LIST,
    defaultAgent: 'AERON',
  });
});

// Test / Inspect Automatic Intent Routing
app.post('/api/agents/route', async (req, res) => {
  const { query, webSearch, useAiClassifier = false } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Valid query string is required.' });
  }
  const ai = useAiClassifier ? getGeminiClient() : null;
  const routing = await routeMessageToAgent(ai, query, {
    explicitWebSearch: webSearch,
    useAiClassifier,
  });
  res.json(routing);
});

// Search Rate Limiting: Max 30 requests per minute per IP
const searchRateLimits = new Map<string, number[]>();

function checkSearchRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 30;

  const timestamps = searchRateLimits.get(ip) || [];
  const validTimestamps = timestamps.filter((t) => now - t < windowMs);

  if (validTimestamps.length >= maxRequests) {
    return false;
  }

  validTimestamps.push(now);
  searchRateLimits.set(ip, validTimestamps);
  return true;
}

export interface SearchSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceName?: string;
  publishedDate?: string;
  score?: number;
}

export interface SearchResult {
  query: string;
  sources: SearchSource[];
  provider: 'tavily' | 'open-web';
  isKeyMissing?: boolean;
}

const searchResultCache = new Map<string, { result: SearchResult; expiresAt: number }>();

// Real-time Internet Search Executor
export async function executeWebSearch(query: string): Promise<SearchResult> {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) {
    throw new Error('Search query cannot be empty.');
  }

  if (cleanQuery.length > 300) {
    throw new Error('Search query is too long (maximum 300 characters).');
  }

  const cacheKey = cleanQuery.toLowerCase();
  const cached = searchResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const tavilyKey = process.env.TAVILY_API_KEY?.trim();

  // Tier 1: Real-time search using Tavily Search API
  if (tavilyKey && tavilyKey !== 'MY_TAVILY_API_KEY' && tavilyKey.length > 5) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: cleanQuery,
          search_depth: 'basic',
          include_answer: false,
          max_results: 5,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errDetail =
          errorData?.detail?.error || `HTTP ${response.status} from Tavily Search API`;
        throw new Error(errDetail);
      }

      const data = await response.json();
      const rawResults = Array.isArray(data.results) ? data.results : [];

      if (rawResults.length > 0) {
        const sources: SearchSource[] = rawResults.map((item: any, idx: number) => {
          let domain = '';
          try {
            domain = new URL(item.url).hostname.replace(/^www\./, '');
          } catch {
            domain = 'Web Source';
          }

          return {
            id: String(idx + 1),
            title: item.title || 'Web Result',
            url: item.url,
            snippet: (item.content || '').slice(0, 450),
            sourceName: domain,
            publishedDate: item.published_date || '',
            score: typeof item.score === 'number' ? item.score : undefined,
          };
        });

        const tavilyResult: SearchResult = {
          query: cleanQuery,
          sources,
          provider: 'tavily',
        };
        searchResultCache.set(cacheKey, {
          result: tavilyResult,
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
        return tavilyResult;
      }
    } catch (tavilyErr: any) {
      console.warn('Tavily Search API warning:', tavilyErr?.message);
    }
  }

  // Tier 2: Open Web Live Knowledge Engine (Google News RSS, DuckDuckGo Instant Answer & Wikipedia)
  try {
    const newsRssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      cleanQuery
    )}&hl=en-IN&gl=IN&ceid=IN:en`;

    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      cleanQuery
    )}&utf8=&format=json&srlimit=4`;

    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      cleanQuery
    )}&format=json&no_html=1&skip_disambig=1`;

    const [newsRes, wikiRes, ddgRes] = await Promise.allSettled([
      fetch(newsRssUrl, { signal: AbortSignal.timeout(2600) }),
      fetch(wikiUrl, { signal: AbortSignal.timeout(2600) }),
      fetch(ddgUrl, { signal: AbortSignal.timeout(2600) }),
    ]);

    const sources: SearchSource[] = [];

    // Process Google News RSS for current news, smartphone prices, and product releases
    if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
      const xmlText = await newsRes.value.text().catch(() => '');
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match: RegExpExecArray | null;
      let count = 0;
      while ((match = itemRegex.exec(xmlText)) !== null && count < 3) {
        const block = match[1];
        const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
        const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
        const pubDateRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
        const sourceTag = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .trim();
        const descRaw = (block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();

        if (rawTitle && link) {
          let formattedDate = pubDateRaw;
          try {
            if (pubDateRaw) {
              formattedDate = new Date(pubDateRaw).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });
            }
          } catch {}

          sources.push({
            id: String(sources.length + 1),
            title: rawTitle,
            url: link,
            snippet: descRaw || rawTitle,
            sourceName: sourceTag || 'news.google.com',
            publishedDate: formattedDate || undefined,
          });
          count++;
        }
      }
    }

    // Process DuckDuckGo instant answer
    if (ddgRes.status === 'fulfilled' && ddgRes.value.ok) {
      const ddgData = await ddgRes.value.json().catch(() => ({}));
      if (ddgData.Abstract && ddgData.AbstractURL) {
        let domain = '';
        try {
          domain = new URL(ddgData.AbstractURL).hostname.replace(/^www\./, '');
        } catch {
          domain = 'duckduckgo.com';
        }
        sources.push({
          id: String(sources.length + 1),
          title: ddgData.Heading || cleanQuery,
          url: ddgData.AbstractURL,
          snippet: ddgData.Abstract,
          sourceName: domain,
          publishedDate: 'Live Reference',
        });
      }
      if (Array.isArray(ddgData.RelatedTopics)) {
        for (const topic of ddgData.RelatedTopics.slice(0, 2)) {
          if (topic.FirstURL && topic.Text) {
            let domain = '';
            try {
              domain = new URL(topic.FirstURL).hostname.replace(/^www\./, '');
            } catch {
              domain = 'duckduckgo.com';
            }
            sources.push({
              id: String(sources.length + 1),
              title: topic.Text.split(' - ')[0] || cleanQuery,
              url: topic.FirstURL,
              snippet: topic.Text,
              sourceName: domain,
            });
          }
        }
      }
    }

    // Process Wikipedia search results
    if (wikiRes.status === 'fulfilled' && wikiRes.value.ok) {
      const wikiData = await wikiRes.value.json().catch(() => ({}));
      const searchItems = wikiData?.query?.search;
      if (Array.isArray(searchItems)) {
        for (const item of searchItems.slice(0, 3)) {
          const cleanSnippet = (item.snippet || '')
            .replace(/<[^>]+>/g, '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');

          const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
            item.title.replace(/ /g, '_')
          )}`;

          sources.push({
            id: String(sources.length + 1),
            title: item.title,
            url: pageUrl,
            snippet: cleanSnippet,
            sourceName: 'wikipedia.org',
            publishedDate: item.timestamp
              ? new Date(item.timestamp).toLocaleDateString()
              : undefined,
          });
        }
      }
    }

    if (sources.length > 0) {
      const openWebResult: SearchResult = {
        query: cleanQuery,
        sources: sources.slice(0, 5).map((s, idx) => ({ ...s, id: String(idx + 1) })),
        provider: 'open-web',
        isKeyMissing: !tavilyKey,
      };
      searchResultCache.set(cacheKey, {
        result: openWebResult,
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      return openWebResult;
    }
  } catch (openErr: any) {
    console.warn('Open web search warning:', openErr?.message);
  }

  // If no search key and no results were found:
  throw new Error(
    'Internet Search is unavailable. To search across real-time websites and news, please set TAVILY_API_KEY in your AI Studio Secrets panel.'
  );
}

// Smart Search Intent Detector (synced with NOVEX agent router)
export function detectSearchIntent(query: string, explicitEnabled?: boolean): boolean {
  if (explicitEnabled === true) return true;
  if (explicitEnabled === false) return false;

  const routing = detectTaskIntent(query);
  if (routing.agentId === 'NOVEX' || routing.requiresWebSearch) {
    return true;
  }

  const q = (query || '').toLowerCase().trim();
  if (!q) return false;

  const patterns = [
    /\b(search|google|browse|lookup|look up|find on web)\b/i,
    /\b(latest|current|news|breaking news|today|yesterday|recent|this week|this month)\b/i,
    /\b(weather|stock|price of|who won|winner|championship|score)\b/i,
    /\b(2025|2026|2027)\b/i,
    /\b(what happened to|status of|upcoming|release date)\b/i,
    /https?:\/\//i,
    /\.(com|org|gov|io|ai|net)\b/i,
  ];

  return patterns.some((p) => p.test(q));
}

// Standalone Search Endpoint
app.post('/api/search', async (req, res) => {
  const userId = resolveRequestUserId(req, res);
  const access = checkUserAccessAndLimits(userId, 'search');
  if (!access.allowed) {
    return res.status(access.statusCode || 403).json({ error: access.reason });
  }

  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkSearchRateLimit(clientIp)) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Please wait a moment before searching again.',
    });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Valid search query string is required.' });
  }

  const startTime = Date.now();
  try {
    const result = await executeWebSearch(query);
    recordSearchEvent({
      userId,
      query,
      provider: result.provider,
      resultsCount: result.sources.length,
      latencyMs: Date.now() - startTime,
      success: true,
    });
    res.json(result);
  } catch (err: any) {
    recordSearchEvent({
      userId,
      query,
      provider: 'none',
      resultsCount: 0,
      latencyMs: Date.now() - startTime,
      success: false,
      errorMessage: err?.message,
    });
    res.status(503).json({
      error: err?.message || 'Search execution failed.',
      isKeyMissing: !process.env.TAVILY_API_KEY,
    });
  }
});

// Search Status Endpoint
app.get('/api/search/status', (req, res) => {
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const hasTavilyKey = !!(tavilyKey && tavilyKey !== 'MY_TAVILY_API_KEY' && tavilyKey.length > 5);
  const geminiClient = getGeminiClient();

  res.json({
    hasTavilyKey,
    hasGeminiKey: !!geminiClient,
    searchProvider: hasTavilyKey ? 'tavily' : 'open-web',
    searchProvidersSupported: ['tavily', 'open-web'],
  });
});

// ==========================================
// AI Image Generation Engine (PIXORA — Imagen 3 & Gemini Flash Image)
// ==========================================

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  style?: string; // 'realistic' | 'cinematic' | 'anime' | '3d' | 'illustration' | 'digital-art';
  imageToEdit?: string; // base64 string
  languagePreference?: string;
}

export interface ImageGenerationResult {
  id: string;
  url: string; // data:image/...;base64,...
  prompt: string;
  revisedPrompt: string;
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  style?: string;
  modelUsed: string;
}

export function detectImageIntent(query: string): boolean {
  const routing = detectTaskIntent(query);
  return Boolean(routing.requiresImageGeneration);
}

export function extractImageOptionsFromPrompt(prompt: string): {
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  style?: string;
} {
  const lower = prompt.toLowerCase();
  let aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' = '1:1';
  let style: string | undefined = undefined;

  if (
    lower.includes('16:9') ||
    lower.includes('landscape') ||
    lower.includes('widescreen') ||
    lower.includes('horizontal') ||
    lower.includes('wallpaper')
  ) {
    aspectRatio = '16:9';
  } else if (
    lower.includes('9:16') ||
    lower.includes('vertical') ||
    lower.includes('story') ||
    lower.includes('reel') ||
    lower.includes('phone wallpaper')
  ) {
    aspectRatio = '9:16';
  } else if (lower.includes('3:4') || lower.includes('portrait')) {
    aspectRatio = '3:4';
  } else if (lower.includes('4:3')) {
    aspectRatio = '4:3';
  }

  if (
    lower.includes('realistic') ||
    lower.includes('photorealistic') ||
    lower.includes('hyperrealistic') ||
    lower.includes('real photo')
  ) {
    style = 'realistic';
  } else if (
    lower.includes('cinematic') ||
    lower.includes('movie scene') ||
    lower.includes('dramatic lighting')
  ) {
    style = 'cinematic';
  } else if (lower.includes('anime') || lower.includes('manga') || lower.includes('ghibli')) {
    style = 'anime';
  } else if (lower.includes('3d') || lower.includes('3d render') || lower.includes('cgi') || lower.includes('pixar')) {
    style = '3d';
  } else if (lower.includes('illustration') || lower.includes('drawing') || lower.includes('sketch') || lower.includes('vector')) {
    style = 'illustration';
  } else if (lower.includes('digital art') || lower.includes('concept art')) {
    style = 'digital-art';
  }

  return { aspectRatio, style };
}

async function enhanceImagePrompt(
  ai: GoogleGenAI,
  rawPrompt: string,
  style?: string
): Promise<string> {
  const cleanedUserPrompt = rawPrompt
    .replace(/^(?:please\s+)?(?:generate|create|draw|paint|render|make|design|produce|show\s+me)\s+(?:an?\s+)?(?:image|picture|photo|photograph|portrait|illustration|artwork|wallpaper|logo|poster|3d\s+render)\s+(?:of|for|showing|depicting|with)?\s*/i, '')
    .trim() || rawPrompt.trim();

  const styleHint =
    style === 'photorealistic'
      ? 'Photorealistic 8k DSLR photography, natural lighting, lifelike textures, realistic depth of field.'
      : style === 'cinematic'
      ? 'Cinematic film still, dramatic natural lighting, rich color grading, shallow depth of field, ultra-detailed.'
      : style === '3d-render'
      ? 'Photorealistic 3D Octane render, physically based materials, studio lighting, raytraced reflections.'
      : style === 'anime'
      ? 'High-detail anime masterpiece illustration, vibrant colors, expressive lighting.'
      : 'Ultra-realistic, high-resolution, natural lighting, lifelike skin and surface textures, balanced colors, rich depth.';

  try {
    const res = await withTimeoutAndRetry(
      () =>
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: `You are an expert photography and visual prompt director.
Rewrite the user's image request into a clear, vivid, photorealistic English image generation prompt that stays 100% faithful to the exact subject, setting, objects, and mood requested by the user.
Rules:
1. Preserve every specific detail from the user's request (e.g. subject, clothing, environment, vehicle, lighting, time of day).
2. Enhance with realistic visual details: natural lighting, lifelike textures, accurate anatomy/proportions, realistic shadows and reflections, and natural depth of field.
3. NEVER add black backgrounds unless explicitly requested.
4. NEVER include text, typography, letters, watermarks, logos, captions, or signatures inside the image unless the user explicitly asked for text.
5. If the user's request is in Bengali, Hindi, or another language, translate it accurately into English.
6. Style guidance: ${styleHint}
Return ONLY the final descriptive prompt as a single paragraph (max 95 words) with no quotes or preamble.

User Request: "${rawPrompt}"`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        }),
      { timeoutMs: 5500, retries: 0 }
    );

    const enhanced = res.text?.trim().replace(/^["']|["']$/g, '');
    if (enhanced && enhanced.length > 12 && enhanced.length < 750) {
      return `${enhanced}, no text, no watermark, no logo`;
    }
  } catch {
    // Gracefully fall back to direct enhanced prompt if rate-limited
  }

  return `${cleanedUserPrompt}, ${styleHint}, ultra-detailed, natural lighting, realistic colors, no text, no watermark, no logo`;
}

function getDimensionsForAspectRatio(aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9'): {
  width: number;
  height: number;
} {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1280, height: 720 };
    case '9:16':
      return { width: 720, height: 1280 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:4':
      return { width: 768, height: 1024 };
    case '1:1':
    default:
      return { width: 1024, height: 1024 };
  }
}

async function fetchPhotorealisticRasterImage(
  prompt: string,
  revisedPrompt: string,
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9'
): Promise<{ dataUrl: string; modelUsed: string } | null> {
  const { width, height } = getDimensionsForAspectRatio(aspectRatio);
  const seed = Math.floor(100000 + Math.random() * 899999);

  // Build a concise, high-signal prompt for the photorealistic diffusion model
  const concisePrompt = revisedPrompt.slice(0, 420).trim();
  const candidateUrls = [
    `https://image.pollinations.ai/prompt/${encodeURIComponent(concisePrompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true&enhance=true&model=flux`,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.trim() + ', photorealistic, high detail, natural lighting, no text, no watermark')}?width=${width}&height=${height}&seed=${seed + 1}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.trim() + ', realistic photo, 8k, natural lighting')}?width=${width}&height=${height}&seed=${seed + 2}&nologo=true`,
  ];

  for (const url of candidateUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 22000);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
          'User-Agent': 'AndamanAI-ImageStudio/2.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) continue;

      const contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      if (!contentType.startsWith('image/')) continue;

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      // Ensure we received a genuine high-resolution raster image (not an empty/tiny error placeholder)
      if (buffer.byteLength < 8000) continue;

      return {
        dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
        modelUsed: 'flux-photorealistic-v1',
      };
    } catch {
      // Try next candidate URL
    }
  }

  return null;
}

export async function executeImageGeneration(
  params: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Please add your Gemini API key in AI Studio Secrets to enable image generation.'
    );
  }

  const { prompt, aspectRatio = '1:1', style, imageToEdit } = params;
  if (!prompt || !prompt.trim()) {
    throw new Error('Image description prompt cannot be empty.');
  }

  // Enhance prompt for maximum photorealistic fidelity while staying faithful to the user's subject
  const revisedPrompt = await enhanceImagePrompt(ai, prompt, style);

  // 1. If editing or using a reference image, try Gemini native multimodal image models first
  if (imageToEdit) {
    const cleanData = imageToEdit.includes(',') ? imageToEdit.split(',')[1] : imageToEdit;
    const editModels = ['gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'];
    for (const modelName of editModels) {
      try {
        const editResponse = await withTimeoutAndRetry(
          () =>
            ai.models.generateContent({
              model: modelName,
              contents: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: cleanData,
                    },
                  },
                  {
                    text: `${revisedPrompt}. Maintain realistic lighting, natural colors, and high visual fidelity without adding any unrequested text or watermarks.`,
                  },
                ],
              },
              config: {
                imageConfig: {
                  aspectRatio: aspectRatio as any,
                },
              },
            }),
          { timeoutMs: 14000, retries: 0 }
        );

        for (const part of editResponse.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.data && part.inlineData.data.length > 1000) {
            const mime = part.inlineData.mimeType || 'image/png';
            return {
              id: `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              url: `data:${mime};base64,${part.inlineData.data}`,
              prompt,
              revisedPrompt,
              aspectRatio,
              style,
              modelUsed: modelName,
            };
          }
        }
      } catch {
        // Proceed to next model
      }
    }
  }

  // 2. Tier 1: Gemini Native Image Generation (gemini-3.1-flash-lite-image & gemini-nano-banana-2.1)
  const geminiImageModels = ['gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'];
  for (const modelName of geminiImageModels) {
    try {
      const geminiImgResponse = await withTimeoutAndRetry(
        () =>
          ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [{ text: revisedPrompt }],
            },
            config: {
              imageConfig: {
                aspectRatio: aspectRatio as any,
              },
            },
          }),
        { timeoutMs: 12000, retries: 0 }
      );

      for (const part of geminiImgResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data && part.inlineData.data.length > 1000) {
          const mime = part.inlineData.mimeType || 'image/png';
          return {
            id: `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            url: `data:${mime};base64,${part.inlineData.data}`,
            prompt,
            revisedPrompt,
            aspectRatio,
            style,
            modelUsed: modelName,
          };
        }
      }
    } catch {
      // Proceed quietly to next model
    }
  }

  // 3. Tier 2: Try Imagen 3 (imagen-3.0-generate-002) via ai.models.generateImages
  try {
    const imagenResponse = await withTimeoutAndRetry(
      () =>
        ai.models.generateImages({
          model: 'imagen-3.0-generate-002',
          prompt: revisedPrompt,
          config: {
            numberOfImages: 1,
            aspectRatio: aspectRatio as any,
            outputMimeType: 'image/jpeg',
          },
        }),
      { timeoutMs: 12000, retries: 0 }
    );

    if (imagenResponse.generatedImages && imagenResponse.generatedImages.length > 0) {
      const base64Bytes = imagenResponse.generatedImages[0].image?.imageBytes;
      if (base64Bytes && base64Bytes.length > 1000) {
        return {
          id: `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          url: `data:image/jpeg;base64,${base64Bytes}`,
          prompt,
          revisedPrompt,
          aspectRatio,
          style,
          modelUsed: 'imagen-3.0-generate-002',
        };
      }
    }
  } catch {
    // Proceed to Photorealistic Raster Engine fallback if Imagen 3 is restricted on Free Tier
  }

  // 4. Tier 3: High-Resolution Photorealistic Raster Engine (Flux)
  const rasterFallback = await fetchPhotorealisticRasterImage(prompt, revisedPrompt, aspectRatio);
  if (rasterFallback) {
    return {
      id: `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      url: rasterFallback.dataUrl,
      prompt,
      revisedPrompt,
      aspectRatio,
      style,
      modelUsed: rasterFallback.modelUsed,
    };
  }

  throw new Error(
    'Unable to generate the image right now due to high server demand. Please click Retry to generate your image again.'
  );
}

// Standalone Image Generation Endpoint
app.post('/api/generate-image', async (req, res) => {
  const userId = resolveRequestUserId(req, res);
  const access = checkUserAccessAndLimits(userId, 'image');
  if (!access.allowed) {
    return res.status(access.statusCode || 403).json({ success: false, error: access.reason });
  }

  const { prompt, aspectRatio = '1:1', style, imageToEdit, languagePreference } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Valid prompt string is required.' });
  }

  const startTime = Date.now();
  try {
    const result = await executeImageGeneration({
      prompt,
      aspectRatio,
      style,
      imageToEdit,
      languagePreference,
    });
    recordImageEvent({
      userId,
      modelUsed: result.modelUsed,
      aspectRatio: result.aspectRatio,
      latencyMs: Date.now() - startTime,
      success: true,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    recordImageEvent({
      userId,
      modelUsed: 'imagen-3.0-generate-002',
      aspectRatio,
      latencyMs: Date.now() - startTime,
      success: false,
      errorMessage: err?.message,
    });
    console.error('Image generation route error:', err?.message);
    res.status(500).json({
      success: false,
      error: err?.message || 'Failed to generate image.',
      isKeyMissing: !process.env.GEMINI_API_KEY,
    });
  }
});

// Format contents for @google/genai generateContentStream
interface ClientMessage {
  role: 'user' | 'assistant' | 'model';
  content: string;
  images?: Array<{
    mimeType: string;
    data: string; // base64 string without data:image/* prefix
  }>;
}

function buildGeminiContents(messages: ClientMessage[]) {
  // Keep recent 16 turns to minimize token prefill latency while maintaining rich conversational memory
  const recentMessages = messages.slice(-16);
  const totalCount = recentMessages.length;

  return recentMessages.map((m, idx) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];

    // Only include heavy base64 inlineData images for the latest 2 messages to avoid re-processing old image payloads
    const isRecentTurn = idx >= totalCount - 2;
    if (isRecentTurn && m.images && Array.isArray(m.images)) {
      for (const img of m.images) {
        if (img.data && img.mimeType) {
          const cleanData = img.data.includes(',') ? img.data.split(',')[1] : img.data;
          parts.push({
            inlineData: {
              mimeType: img.mimeType,
              data: cleanData,
            },
          });
        }
      }
    }

    // Add text prompt
    parts.push({
      text: m.content || '',
    });

    return {
      role,
      parts,
    };
  });
}

// Streaming chat endpoint via SSE with Automatic Multi-Agent Routing
app.post('/api/chat', async (req, res) => {
  const userId = resolveRequestUserId(req, res);
  const access = checkUserAccessAndLimits(userId, 'chat');
  if (!access.allowed) {
    return res.status(access.statusCode || 403).json({ error: access.reason });
  }

  const {
    messages,
    model = 'gemini-3.8-flash',
    systemInstruction,
    languagePreference,
    webSearch,
    clientTime,
  } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0 || messages.length > 200) {
    return res.status(400).json({ error: 'Valid messages array (1–200 items) is required.' });
  }

  const lastInputMsg = messages[messages.length - 1];
  if (
    !lastInputMsg ||
    typeof lastInputMsg.content !== 'string' ||
    lastInputMsg.content.length > 32000
  ) {
    return res.status(400).json({ error: 'Message content must be a string up to 32,000 characters.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'GEMINI_API_KEY is not configured on the server. Please add your Gemini API key in AI Studio Secrets to enable live responses.',
      isKeyMissing: true,
    });
  }

  // Disable Nagle's algorithm so every SSE chunk flushes immediately with zero socket buffering delay
  req.socket?.setNoDelay?.(true);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  if (req.httpVersionMajor < 2) {
    res.setHeader('Connection', 'keep-alive');
  }
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const chatStartTime = Date.now();
  const isNewConversation = messages.filter((m: any) => m.role === 'user').length <= 1;

  try {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const userQuery = lastUserMsg?.content || '';
    const hasImageAttachment = Boolean(lastUserMsg?.images && lastUserMsg.images.length > 0);

    // 1. Automatic Intent Detection & Multi-Agent Routing
    const routing = await routeMessageToAgent(ai, userQuery, {
      explicitWebSearch: webSearch,
      hasImageAttachment,
      useAiClassifier: false, // Fast deterministic routing avoids extra API latency/quota
    });

    const activeAgent = AI_AGENTS[routing.agentId] || AI_AGENTS.AERON;
    const agentInfoPayload = {
      id: activeAgent.id,
      name: activeAgent.name,
      title: activeAgent.title,
      reason: routing.reason,
      coordinatedAgents: routing.coordinatedAgents,
    };

    // Emit routed agent metadata to the client immediately
    res.write(
      `data: ${JSON.stringify({
        type: 'agent_routed',
        agent: agentInfoPayload,
      })}\n\n`
    );
    if (typeof (res as any).flush === 'function') (res as any).flush();

    // 2. If binary image generation is requested (PIXORA with requiresImageGeneration: true), execute image generation
    const isImageRequest = Boolean(routing.requiresImageGeneration);

    if (isImageRequest && userQuery.trim()) {
      res.write(`data: ${JSON.stringify({ type: 'image_generating', prompt: userQuery })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();

      try {
        const imageOptions = extractImageOptionsFromPrompt(userQuery);
        const imageResult = await executeImageGeneration({
          prompt: userQuery,
          aspectRatio: imageOptions.aspectRatio,
          style: imageOptions.style,
          imageToEdit: hasImageAttachment ? lastUserMsg?.images?.[0]?.data : undefined,
          languagePreference,
        });

        recordImageEvent({
          userId,
          modelUsed: imageResult.modelUsed,
          aspectRatio: imageResult.aspectRatio,
          latencyMs: Date.now() - chatStartTime,
          success: true,
        });

        res.write(
          `data: ${JSON.stringify({
            type: 'image_generated',
            image: {
              id: imageResult.id,
              url: imageResult.url,
              prompt: imageResult.prompt,
              revisedPrompt: imageResult.revisedPrompt,
              aspectRatio: imageResult.aspectRatio,
              style: imageResult.style,
            },
          })}\n\n`
        );
        if (typeof (res as any).flush === 'function') (res as any).flush();

        const isBengali = languagePreference === 'bn' || /[\u0980-\u09FF]/.test(userQuery);
        const isHindi = languagePreference === 'hi' || /[\u0900-\u097F]/.test(userQuery);

        let responseText = '';
        if (isBengali) {
          responseText = `আপনার বর্ণনার ওপর ভিত্তি করে ছবিটি তৈরি করা হয়েছে। আপনি চাইলে এটি ডাউনলোড বা শেয়ার করতে পারেন, অথবা নতুন ছবি তৈরি করতে পারেন।`;
        } else if (isHindi) {
          responseText = `आपके विवरण के आधार पर छवि तैयार कर दी गई है। आप इसे डाउनलोड या साझा कर सकते हैं, या कोई नया बदलाव बता सकते हैं।`;
        } else {
          responseText = `Here is the image created from your description. You can download it, share it, regenerate a new variation, or ask for adjustments.`;
        }

        res.write(`data: ${JSON.stringify({ text: responseText })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            done: true,
            agentInfo: agentInfoPayload,
          })}\n\n`
        );
        return res.end();
      } catch (imgErr: any) {
        const errDetail = sanitizeClientError(
          imgErr,
          'Image generation service is currently unavailable.'
        );
        res.write(
          `data: ${JSON.stringify({
            type: 'image_error',
            error: errDetail,
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            text: `I couldn't finish creating the image right now. Please use the **Retry** button on the card above to generate it again.`,
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            done: true,
            agentInfo: agentInfoPayload,
          })}\n\n`
        );
        return res.end();
      }
    }

    // 3. If routed to NOVEX (Web Search Specialist) or explicit webSearch is enabled
    const shouldSearch =
      routing.agentId === 'NOVEX' ||
      Boolean(routing.requiresWebSearch) ||
      detectSearchIntent(userQuery, webSearch);

    let searchResultInfo: SearchResult | null = null;
    let searchFailureMessage: string | null = null;

    if (shouldSearch && userQuery.trim()) {
      res.write(`data: ${JSON.stringify({ type: 'search_start', query: userQuery })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();

      try {
        searchResultInfo = await withTimeoutAndRetry(() => executeWebSearch(userQuery), {
          timeoutMs: 15000,
          retries: 1,
        });
        if (!searchResultInfo.sources || searchResultInfo.sources.length === 0) {
          searchFailureMessage = 'Live web search returned no verified sources for this query.';
        }
        res.write(
          `data: ${JSON.stringify({
            type: 'search_results',
            query: userQuery,
            sources: searchResultInfo.sources,
            provider: searchResultInfo.provider,
          })}\n\n`
        );
        if (typeof (res as any).flush === 'function') (res as any).flush();
      } catch (searchErr: any) {
        console.warn('Live search warning:', searchErr?.message);
        searchFailureMessage = sanitizeClientError(searchErr, 'Internet search failed or is currently unavailable.');
        res.write(
          `data: ${JSON.stringify({
            type: 'search_error',
            error: searchFailureMessage,
            isKeyMissing: !process.env.TAVILY_API_KEY,
          })}\n\n`
        );
        if (typeof (res as any).flush === 'function') (res as any).flush();

        if (webSearch === true && !searchResultInfo) {
          const setupNotice = `I was unable to search the internet because the search request failed: **${searchFailureMessage}**\n\n### How to verify real-time internet search:\n1. Ensure a valid API key is set at **\`TAVILY_API_KEY\`** in your Google AI Studio Secrets (or check your network connection).\n2. Reload the app to retry searching current news, websites, and real-time knowledge.`;
          res.write(`data: ${JSON.stringify({ text: setupNotice })}\n\n`);
          res.write(
            `data: ${JSON.stringify({
              done: true,
              agentInfo: agentInfoPayload,
              searchInfo: {
                query: userQuery,
                sources: [],
                searchError: searchFailureMessage,
                isKeyMissing: !process.env.TAVILY_API_KEY,
              },
            })}\n\n`
          );
          res.end();
          return;
        }
      }
    }

    const contents = buildGeminiContents(messages);

    // 4. Build Specialist System Instruction + Dynamic Turn Guidance for the Routed Assistant
    let finalSystemInstruction = `${DEFAULT_SYSTEM_INSTRUCTION}\n\n# ACTIVE SPECIALIST AGENT DIRECTIVE\n${activeAgent.systemPromptAddition}${buildDynamicResponseGuidance(userQuery)}`;

    // If multiple specialist domains were detected, include coordinated specialist directives
    if (routing.coordinatedAgents && routing.coordinatedAgents.length > 0) {
      const coordPrompts = routing.coordinatedAgents
        .map((id) => AI_AGENTS[id]?.systemPromptAddition)
        .filter(Boolean)
        .join('\n\n');
      if (coordPrompts) {
        finalSystemInstruction += `\n\n# COORDINATED SPECIALIST CAPABILITIES\nThis request spans multiple tasks. Coordinate with the following specialist directives in a single unified response:\n${coordPrompts}`;
      }
    }

    if (languagePreference && languagePreference !== 'auto') {
      if (languagePreference === 'bn') {
        finalSystemInstruction += `\n\nCRITICAL LANGUAGE DIRECTIVE: Please respond primarily in Bengali (বাংলা) script with accurate grammar and natural tone.`;
      } else if (languagePreference === 'hi') {
        finalSystemInstruction += `\n\nCRITICAL LANGUAGE DIRECTIVE: Please respond primarily in Hindi (हिन्दी) Devanagari script with accurate grammar and natural tone.`;
      } else if (languagePreference === 'en') {
        finalSystemInstruction += `\n\nCRITICAL LANGUAGE DIRECTIVE: Please respond in English with clear, articulate phrasing.`;
      }
    }

    if (systemInstruction && systemInstruction.trim()) {
      finalSystemInstruction += `\n\nUser Persona preference: ${systemInstruction.trim()}`;
    }

    // Append dynamic chronometric context (current local time, timezone, IST time)
    finalSystemInstruction += buildChronometricContext(clientTime);

    // Integrate verified web sources into system instructions
    if (searchResultInfo && searchResultInfo.sources.length > 0) {
      const sourcesSummary = searchResultInfo.sources
        .map(
          (s) =>
            `[${s.id}] Title: ${s.title}\nSource: ${s.sourceName || 'Web'}\nURL: ${s.url}${
              s.publishedDate ? `\nDate: ${s.publishedDate}` : ''
            }\nSnippet: ${s.snippet}`
        )
        .join('\n\n');

      finalSystemInstruction += `\n\n# REAL-TIME INTERNET SEARCH KNOWLEDGE (NOVEX VERIFIED SOURCES)
The following verified web sources were retrieved in real-time for: "${userQuery}"

${sourcesSummary}

CITATION & SYNTHESIS DIRECTIVES:
1. Synthesize a direct, accurate, and comprehensive answer strictly grounded in these verified search results.
2. Add inline bracketed citations like [1], [2], etc., immediately after every claim or sentence sourced from a result.
3. Make sure citation [1] refers to source 1, [2] refers to source 2, etc. Never invent citation numbers not present in the list.
4. Never invent fake URLs, false prices, false statistics, or imaginary quotes.
5. If sources disagree or exact retail prices vary by storage variant/region, explicitly state the range and dates shown in the sources.
6. Do NOT manually output a raw bibliography of URLs at the end; the UI automatically displays the verified source cards and clickable links for the user.`;
    } else if (shouldSearch) {
      finalSystemInstruction += `\n\nIMPORTANT SEARCH NOTICE: Live web search failed or returned no verified sources (${searchFailureMessage || 'no results'}). Explicitly inform the user at the start of your response that live internet search could not retrieve verified current sources for this query, and NEVER pretend a web search succeeded or fabricate citations, URLs, or live prices.`;
    }

    const {
      primaryModel: targetModel,
      primaryThinking,
      fallbackModel,
      fallbackThinking,
    } = resolveBackendGeminiModelPair(model);

    let responseStream;
    let usedFallback = false;
    try {
      responseStream = await withTimeoutAndRetry(
        () =>
          ai.models.generateContentStream({
            model: targetModel,
            contents,
            config: {
              systemInstruction: finalSystemInstruction,
              thinkingConfig: {
                thinkingLevel: primaryThinking,
              },
            },
          }),
        { timeoutMs: 25000, retries: 1 }
      );
    } catch (primaryErr: any) {
      usedFallback = true;
      responseStream = await withTimeoutAndRetry(
        () =>
          ai.models.generateContentStream({
            model: fallbackModel,
            contents,
            config: {
              systemInstruction: finalSystemInstruction,
              thinkingConfig: {
                thinkingLevel: fallbackThinking,
              },
            },
          }),
        { timeoutMs: 25000, retries: 0 }
      );
      if (!responseStream) throw primaryErr;
    }

    let hasSentText = false;
    let totalOutputChars = 0;
    try {
      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          hasSentText = true;
          totalOutputChars += text.length;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }
      }
    } catch (streamErr: any) {
      if (!hasSentText) {
        usedFallback = true;
        const fallbackStream = await ai.models.generateContentStream({
          model: fallbackModel,
          contents,
          config: {
            systemInstruction: finalSystemInstruction,
            thinkingConfig: {
              thinkingLevel: fallbackThinking,
            },
          },
        });
        for await (const fallbackChunk of fallbackStream) {
          const text = fallbackChunk.text;
          if (text) {
            totalOutputChars += text.length;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          }
        }
      } else {
        throw streamErr;
      }
    }

    recordChatEvent({
      userId,
      modelId: usedFallback ? fallbackModel : targetModel,
      usedFallback,
      agentId: activeAgent.id,
      isNewConversation,
      latencyMs: Date.now() - chatStartTime,
      inputChars: userQuery.length,
      outputChars: totalOutputChars,
      success: true,
    });

    res.write(
      `data: ${JSON.stringify({
        done: true,
        agentInfo: agentInfoPayload,
        searchInfo: searchResultInfo
          ? {
              query: userQuery,
              sources: searchResultInfo.sources,
              provider: searchResultInfo.provider,
              searchError: searchFailureMessage || undefined,
            }
          : searchFailureMessage
          ? {
              query: userQuery,
              sources: [],
              searchError: searchFailureMessage,
            }
          : undefined,
      })}\n\n`
    );
    res.end();
  } catch (err: any) {
    recordChatEvent({
      userId,
      modelId: model,
      agentId: 'AERON',
      isNewConversation,
      latencyMs: Date.now() - chatStartTime,
      inputChars: lastInputMsg?.content?.length || 0,
      outputChars: 0,
      success: false,
      errorMessage: err?.message,
    });
    console.error('Error generating Gemini response stream:', err);
    const errorMessage = sanitizeClientError(err, 'Failed to generate response from Gemini API.');
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
    res.end();
  }
});

// Non-streaming chat endpoint for test or voice fallback (with Multi-Agent Routing)
app.post('/api/chat/sync', async (req, res) => {
  const userId = resolveRequestUserId(req, res);
  const access = checkUserAccessAndLimits(userId, 'chat');
  if (!access.allowed) {
    return res.status(access.statusCode || 403).json({ error: access.reason });
  }
  const syncStartTime = Date.now();
  const { messages, model = 'gemini-3.8-flash', systemInstruction, languagePreference, webSearch, clientTime } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Valid messages array is required.' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'GEMINI_API_KEY is not configured on the server. Please add your Gemini API key in AI Studio Secrets.',
      isKeyMissing: true,
    });
  }

  try {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const userQuery = lastUserMsg?.content || '';

    const routing = await routeMessageToAgent(ai, userQuery, {
      explicitWebSearch: webSearch,
      useAiClassifier: false,
    });
    const activeAgent = AI_AGENTS[routing.agentId] || AI_AGENTS.AERON;
    const agentInfoPayload = {
      id: activeAgent.id,
      name: activeAgent.name,
      title: activeAgent.title,
      reason: routing.reason,
      coordinatedAgents: routing.coordinatedAgents,
    };

    let finalSystemInstruction =
      `${systemInstruction || DEFAULT_SYSTEM_INSTRUCTION}\n\n# ACTIVE SPECIALIST AGENT DIRECTIVE\n${activeAgent.systemPromptAddition}${buildDynamicResponseGuidance(userQuery)}` +
      buildChronometricContext(clientTime);

    if (languagePreference === 'bn') {
      finalSystemInstruction += `\nRespond naturally in Bengali (বাংলা).`;
    } else if (languagePreference === 'hi') {
      finalSystemInstruction += `\nRespond naturally in Hindi (हिन्दी).`;
    }

    let searchResultInfo: SearchResult | null = null;
    const shouldSearch =
      routing.agentId === 'NOVEX' ||
      Boolean(routing.requiresWebSearch) ||
      detectSearchIntent(userQuery, webSearch);

    if (shouldSearch && userQuery.trim()) {
      try {
        searchResultInfo = await executeWebSearch(userQuery);
        if (searchResultInfo.sources.length > 0) {
          const sourcesSummary = searchResultInfo.sources
            .map(
              (s) =>
                `[${s.id}] Title: ${s.title}\nSource: ${s.sourceName || 'Web'}\nURL: ${s.url}${
                  s.publishedDate ? `\nDate: ${s.publishedDate}` : ''
                }\nSnippet: ${s.snippet}`
            )
            .join('\n\n');
          finalSystemInstruction += `\n\nVerified Web Results:\n${sourcesSummary}\n\nSynthesize strictly from these verified results and cite sources as [1], [2] etc. Never invent prices or fake links.`;
        }
      } catch (e) {
        console.warn('Sync search warning:', e);
      }
    }

    const contents = buildGeminiContents(messages);
    const {
      primaryModel: targetModel,
      primaryThinking,
      fallbackModel,
      fallbackThinking,
    } = resolveBackendGeminiModelPair(model);

    let response;
    try {
      response = await withTimeoutAndRetry(
        () =>
          ai.models.generateContent({
            model: targetModel,
            contents,
            config: {
              systemInstruction: finalSystemInstruction,
              thinkingConfig: {
                thinkingLevel: primaryThinking,
              },
            },
          }),
        { timeoutMs: 25000, retries: 1 }
      );
    } catch (primaryErr: any) {
      response = await withTimeoutAndRetry(
        () =>
          ai.models.generateContent({
            model: fallbackModel,
            contents,
            config: {
              systemInstruction: finalSystemInstruction,
              thinkingConfig: {
                thinkingLevel: fallbackThinking,
              },
            },
          }),
        { timeoutMs: 25000, retries: 0 }
      );
      if (!response) throw primaryErr;
    }

    res.json({
      text: response.text,
      agentInfo: agentInfoPayload,
      searchInfo: searchResultInfo
        ? {
            query: userQuery,
            sources: searchResultInfo.sources,
            provider: searchResultInfo.provider,
          }
        : undefined,
    });
  } catch (err: any) {
    console.error('Error generating sync response:', err);
    res.status(500).json({ error: sanitizeClientError(err, 'Failed to generate response') });
  }
});

// Shared Conversation Data Store & Persistence
export interface SharedChatRecord {
  shareId: string;
  originalId?: string;
  title: string;
  createdAt: number;
  sharedAt: number;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    images?: any[];
    searchInfo?: any;
    rating?: string | null;
  }>;
  model?: string;
  views: number;
}

const DATA_DIR = path.resolve(__dirname, '.data');
const SHARED_CHATS_FILE = path.join(DATA_DIR, 'shared_chats.json');
const sharedChatsMap = new Map<string, SharedChatRecord>();

function initSharedChatsStorage() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SHARED_CHATS_FILE)) {
      const data = fs.readFileSync(SHARED_CHATS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.shareId) {
            sharedChatsMap.set(item.shareId, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Notice: Could not load existing shared chats:', err);
  }
}

function persistSharedChats() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const list = Array.from(sharedChatsMap.values());
    fs.writeFileSync(SHARED_CHATS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Notice: Could not persist shared chats to disk:', err);
  }
}

initSharedChatsStorage();

// POST /api/share - Generate public shareable snapshot for conversation
app.post('/api/share', (req, res) => {
  try {
    const { conversation, customTitle, existingShareId } = req.body;
    if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Conversation must contain at least one message to be shared.',
      });
    }

    // Reuse existing share ID if updating, or generate a fresh 10-char alphanumeric token
    let shareId = existingShareId && sharedChatsMap.has(existingShareId) ? existingShareId : '';
    if (!shareId) {
      shareId = crypto.randomBytes(5).toString('hex');
    }

    const sanitizedMessages = conversation.messages.map((m: any) => ({
      id: String(m.id || `msg-${Date.now()}`),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
      timestamp: Number(m.timestamp || Date.now()),
      images: Array.isArray(m.images) ? m.images : undefined,
      searchInfo: m.searchInfo || undefined,
      rating: m.rating || null,
    }));

    const existingRecord = sharedChatsMap.get(shareId);
    const title = (customTitle || conversation.title || 'Conversation with ANDAMAN AI')
      .trim()
      .slice(0, 120);

    const record: SharedChatRecord = {
      shareId,
      originalId: conversation.id || undefined,
      title,
      createdAt: Number(conversation.createdAt || Date.now()),
      sharedAt: Date.now(),
      messages: sanitizedMessages,
      model: conversation.model || 'gemini-3.8-flash',
      views: existingRecord ? existingRecord.views : 0,
    };

    sharedChatsMap.set(shareId, record);
    persistSharedChats();

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${origin}/?share=${shareId}`;

    res.json({
      success: true,
      shareId,
      shareUrl,
      share: record,
    });
  } catch (err: any) {
    console.error('Error creating shared chat:', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to share conversation' });
  }
});

// GET /api/share/:shareId - Retrieve public shared conversation
app.get('/api/share/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId || !sharedChatsMap.has(shareId)) {
      return res.status(404).json({
        success: false,
        error: 'Shared conversation not found or the link has expired.',
      });
    }

    const record = sharedChatsMap.get(shareId)!;
    record.views = (record.views || 0) + 1;
    setTimeout(() => persistSharedChats(), 50);

    res.json({
      success: true,
      share: record,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to retrieve shared conversation' });
  }
});

// DELETE /api/share/:shareId - Unshare / delete public share link
app.delete('/api/share/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId || !sharedChatsMap.has(shareId)) {
      return res.status(404).json({ success: false, error: 'Share link not found.' });
    }
    sharedChatsMap.delete(shareId);
    persistSharedChats();
    res.json({ success: true, message: 'Share link deleted successfully.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete share link' });
  }
});

// ==========================================
// Dedicated REST API v1 (/api/v1/health, /api/v1/models, /api/v1/chat, /api/v1/images, /api/v1/search)
// ==========================================
getGeminiProviderInstance().setImageExecutor(executeImageGeneration);
app.use(
  '/api/v1',
  createApiV1Router({
    defaultSystemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
    liveVoices: LIVE_VOICES,
    executeWebSearch,
    detectSearchIntent,
    executeImageGeneration,
    extractImageOptionsFromPrompt,
    routeMessageToAgent: (query, options) =>
      routeMessageToAgent(
        options?.useAiClassifier ? getGeminiClient() : null,
        query,
        options
      ),
  })
);

// ==========================================
// User Phone & Password Authentication API
// ==========================================
app.use('/api/auth', createUserAuthRouter());

// ==========================================
// Notification Center & Admin Announcements API
// ==========================================
app.use('/api/notifications', createNotificationRouter());

// ==========================================
// Owner Admin Dashboard API, Payment Webhooks & AI App Builder
// ==========================================
app.use('/api/admin', createAdminRouter({ getGeminiClient, sharedChatsMap }));
app.use('/api/subscription', createSubscriptionRouter());
app.use('/api/builder', createAppBuilderRouter());
app.use('/api/creator', createCreatorStudioRouter());
app.post('/api/webhooks/payment', handlePaymentWebhook);
app.post('/api/webhooks/razorpay', handlePaymentWebhook);

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    // Serve the standalone Owner Admin Dashboard website at /admin and /admin/*
    app.get(['/admin', '/admin/', '/admin.html', '/admin/*'], async (req, res, next) => {
      try {
        const adminHtmlPath = path.resolve(__dirname, 'admin.html');
        if (!fs.existsSync(adminHtmlPath)) {
          return next();
        }
        const rawHtml = fs.readFileSync(adminHtmlPath, 'utf-8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(transformed);
      } catch (err) {
        next(err);
      }
    });

    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get(['/admin', '/admin/', '/admin.html', '/admin/*'], (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'admin.html'));
    });
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const server = http.createServer(app);

  // Setup WebSocket Server for Real-Time Gemini Live Call
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url || '';
    const pathname = rawUrl.split('?')[0];

    if (
      pathname === '/api/live' ||
      pathname === '/api/live/' ||
      pathname === '/api/v1/live' ||
      pathname === '/api/v1/live/'
    ) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs: WebSocket, req) => {
    console.log('Incoming Live Call WebSocket connection...');

    clientWs.on('error', (err) => {
      console.warn('Live client WS error:', err?.message);
    });

    const ai = getGeminiClient();
    if (!ai) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            error: 'GEMINI_API_KEY is not configured on the server. Please add your key in AI Studio Secrets.',
          })
        );
        clientWs.close();
      }
      return;
    }

    // Parse URL query params (voice, lang, tz, time, date)
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const voiceParam = urlObj.searchParams.get('voice') || 'Zephyr';
    const langParam = urlObj.searchParams.get('lang') || 'auto';
    const tzParam = urlObj.searchParams.get('tz') || undefined;
    const timeParam = urlObj.searchParams.get('time') || undefined;
    const dateParam = urlObj.searchParams.get('date') || undefined;

    const validVoice = LIVE_VOICES.includes(voiceParam) ? voiceParam : 'Zephyr';

    const cookies = parseCookies(req.headers.cookie);
    const wsUserId = cookies['andaman_uid'] || `usr_${crypto.randomBytes(5).toString('hex')}`;
    getOrCreateSessionUser(wsUserId);

    const voiceAccess = checkUserAccessAndLimits(wsUserId, 'voice');
    if (!voiceAccess.allowed) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            error: voiceAccess.reason || 'Live voice calling is currently restricted.',
          })
        );
        clientWs.close();
      }
      return;
    }

    recordVoiceSessionEvent({
      userId: wsUserId,
      voiceName: validVoice,
      success: true,
    });

    let liveInstruction = `You are ANDAMAN AI in a real-time, low-latency live telephone call with the user, powered by six specialized assistants:
- AERON (Main Assistant for general conversation & coordination)
- NOVEX (Web Search Specialist for current prices & news)
- VEXOR (Task Assistant for daily planning & reminders — never claim to set device OS alarms without explicit integration)
- ZENIQ (Learning Assistant for simple explanations & Bengali/English translation)
- PIXORA (Creative & Image Assistant)
- CODEX (Coding & Website Assistant)

- Keep your spoken responses concise, conversational, friendly, and natural (1-3 sentences).
- Avoid long speeches or reading raw code symbols; speak conversationally like a human partner on a phone call.
- You have fluent native command of English, Bengali (বাংলা), and Hindi (हिन्दी). If the user speaks in Bengali or Hindi, respond warmly in their language.
- Introduce yourself warmly as ANDAMAN AI if asked. Never claim to be ChatGPT or OpenAI.`;

    if (langParam === 'bn') {
      liveInstruction += '\nSpeak primarily in natural Bengali.';
    } else if (langParam === 'hi') {
      liveInstruction += '\nSpeak primarily in natural Hindi.';
    }

    // Real-time chronometric context for voice calls
    liveInstruction += buildChronometricContext({
      timeZone: tzParam,
      timeString: timeParam,
      dateString: dateParam,
    });

    let activeSession: any = null;
    const pendingInputQueue: any[] = [];

    // Helper to process text input in Live Call with specialist routing (e.g. NOVEX web search)
    const handleLiveTextTurn = async (session: any, rawText: string) => {
      const routing = detectTaskIntent(rawText);
      const agent = AI_AGENTS[routing.agentId] || AI_AGENTS.AERON;
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'agent_routed',
            agent: { id: agent.id, name: agent.name, title: agent.title },
          })
        );
      }

      let enrichedText = rawText;
      if (routing.agentId === 'NOVEX' || routing.requiresWebSearch) {
        try {
          const searchRes = await executeWebSearch(rawText);
          if (searchRes.sources.length > 0) {
            const topSnippets = searchRes.sources
              .slice(0, 3)
              .map((s) => `${s.title} (${s.sourceName}): ${s.snippet}`)
              .join(' | ');
            enrichedText = `${rawText}\n[NOVEX Live Web Context: ${topSnippets}. Answer concisely in 1-2 spoken sentences using these verified facts.]`;
          }
        } catch {}
      }
      session.sendRealtimeInput({ text: enrichedText });
    };

    // Register message handler immediately to avoid dropping early audio packets
    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (activeSession) {
          if (msg.audio) {
            activeSession.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (msg.text) {
            handleLiveTextTurn(activeSession, msg.text);
          }
        } else {
          // Queue message until session is established
          pendingInputQueue.push(msg);
        }
      } catch (err) {
        console.warn('Error processing client live input:', err);
      }
    });

    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'status', status: 'connecting' }));
      }

      // Connect to Gemini 3.8 Live API
      const session = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: validVoice } },
          },
          systemInstruction: liveInstruction,
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'audio', audio }));
              }
            }

            const text = message.serverContent?.modelTurn?.parts?.[0]?.text;
            if (text) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'text', text }));
              }
            }

            if (message.serverContent?.interrupted) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'interrupted', interrupted: true }));
              }
            }

            if (message.serverContent?.turnComplete) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'turnComplete' }));
              }
            }
          },
          onerror: (err: any) => {
            console.warn('Gemini Live session notice:', err?.message);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: 'error',
                  error: err?.message || 'Live call session notice',
                })
              );
            }
          },
          onclose: () => {
            console.log('Gemini Live session closed');
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'closed' }));
            }
          },
        },
      });

      activeSession = session;

      // Flush any queued packets
      while (pendingInputQueue.length > 0) {
        const item = pendingInputQueue.shift();
        if (item.audio) {
          session.sendRealtimeInput({
            audio: { data: item.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (item.text) {
          session.sendRealtimeInput({
            text: item.text,
          });
        }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
      }

      clientWs.on('close', () => {
        console.log('Client closed Live Call WebSocket');
        try {
          session.close();
        } catch (e) {}
      });
    } catch (err: any) {
      console.warn('Failed to establish Gemini Live connection:', err?.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            error: err?.message || 'Failed to start Live Call with Gemini 3.8 Live API.',
          })
        );
        clientWs.close();
      }
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ANDAMAN AI server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
