# ANDAMAN AI — Full-Stack Application & Independent REST API Backend (`/api/v1`)

**ANDAMAN AI** is a full-stack multi-agent personal AI platform featuring **6 specialized AI assistants** (`AERON`, `NOVEX`, `VEXOR`, `ZENIQ`, `PIXORA`, and `CODEX`), multilingual support (**English**, **Bengali `বাংলা`**, and **Hindi `हिन्दी`**), real-time internet search, AI image generation, low-latency Live Voice Calls, phone/password authentication, and an independent **REST API v1 Backend (`/api/v1`)** with a pluggable AI provider abstraction layer.

---

## 1. Architecture Overview

| Layer | Key Files | Responsibility |
| :--- | :--- | :--- |
| **REST API v1 Router** | `src/services/apiV1Routes.ts` | Exposes `/api/v1/health`, `/api/v1/models`, `/api/v1/chat`, `/api/v1/images`, `/api/v1/search`, and `/api/v1/agents` with sliding-window rate limiting, input validation, correlation IDs (`X-Request-Id`), and secret sanitization. |
| **AI Provider Abstraction** | `src/services/aiProvider.ts` | Decouples AI model calls from HTTP routes via the `AIProvider` interface. Includes `GeminiAIProvider` (`@google/genai`) as the default provider and `OpenAICompatibleProvider` for swapping to Groq, OpenRouter, Together, Ollama, vLLM, or OpenAI without rebuilding the app. |
| **Multi-Agent Router** | `src/services/agents.ts` | Routes queries across `AERON` (General), `NOVEX` (Web Search), `VEXOR` (Debugging), `ZENIQ` (Learning/Translation), `PIXORA` (Image Studio), and `CODEX` (App Development). |
| **Main Server & Live Bridge** | `server.ts` | Mounts `/api/v1`, `/api/auth`, `/api/notifications`, `/api/admin`, and the `/api/live` (`/api/v1/live`) WebSocket bridge for real-time voice calls. |
| **Frontend API Client** | `src/services/apiClient.ts` | Connects the React frontend (`src/App.tsx`, `src/components/LiveCallModal.tsx`) to either the integrated server or an externally deployed backend URL via `VITE_API_BASE_URL`. |

---

## 2. Cost & Free-Tier Transparency (Keeping Cost Near ₹0)

| Feature | Default Provider / Tool | Cost / Tier Details |
| :--- | :--- | :--- |
| **API Hosting** | Render Free Web Service (`render.yaml`) or Cloud Run Free Tier (`Dockerfile`) | **₹0 / Free Tier** (Render free instances spin down when idle; `/api/v1/health` wakes them automatically). |
| **Chat & 6 AI Agents** | `gemini-3.8-flash` & `gemini-3.1-flash-lite` via `GEMINI_API_KEY` | **Free-Tier Compatible** with a standard Google AI Studio API key (within Google AI Studio's free rate limits). |
| **Real-Time Web Search** | Built-in Open-Web Live Engine (Google News RSS + DuckDuckGo Instant Answer + Wikipedia) | **100% Free (₹0)** with zero API keys required. Optional `TAVILY_API_KEY` adds 1,000 free searches/month. |
| **Image Generation (`PIXORA`)** | Multi-tier pipeline (`imagen-3.0-generate-002` → `gemini-3.1-flash-lite-image` → Free-Tier AI SVG Vector Synthesis) | **Important:** Google's raster image models (`imagen-3.0-generate-002` and `gemini-3.1-flash-lite-image`) require a **paid billing tier** on Google AI Studio. When using a free-tier key, ANDAMAN AI automatically falls back to **Tier 3 Free-Tier AI SVG Illustration Synthesis** at **₹0 cost**. |
| **Authentication & Storage** | Salted `scrypt` phone/password store (`.data/`) | **100% Free (₹0)** open-source Node.js `crypto` implementation; no paid SMS/OTP gateway required. |

---

## 3. Running Locally

### Prerequisites
- **Node.js 20+** (or Node.js 22 LTS)
- A Google AI Studio API Key (`GEMINI_API_KEY`)

### Step-by-Step Local Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and set your `GEMINI_API_KEY`:
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```env
   AI_PROVIDER="gemini"
   GEMINI_API_KEY="your_actual_gemini_api_key_here"
   PORT="3000"
   ```

3. **Start the development server (Frontend + REST API v1 on port 3000):**
   ```bash
   npm run dev
   ```

4. **Run the automated verification & integration test suite:**
   ```bash
   npm test
   ```

---

## 4. REST API v1 Reference & Testing Endpoints

All v1 endpoints return structured JSON with a unique `X-Request-Id` header and rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).

### 4.1 `GET /api/v1/health`
Checks service health, uptime, active AI provider readiness, and supported capabilities.

```bash
curl -s http://localhost:3000/api/v1/health | jq
```

**Example Response:**
```json
{
  "success": true,
  "status": "ok",
  "service": "ANDAMAN AI REST API",
  "version": "1.0.0",
  "uptimeSeconds": 142,
  "provider": {
    "active": "gemini",
    "name": "Google Gemini AI",
    "configured": true,
    "defaultModel": "gemini-3.8-flash",
    "supportsStreaming": true,
    "supportsImageGeneration": true
  },
  "capabilities": {
    "chat": true,
    "streaming": true,
    "images": true,
    "webSearch": true,
    "liveVoiceCall": true,
    "multiAgentRouting": true,
    "languages": ["en", "bn", "hi"]
  }
}
```

### 4.2 `GET /api/v1/models`
Lists available AI models, active provider info, registered providers, live voice personas, and the 6 specialist AI agents.

```bash
curl -s http://localhost:3000/api/v1/models | jq
```

### 4.3 `POST /api/v1/chat` (Structured JSON Mode — Default)
Accepts either a `messages` array (`[{ "role": "user", "content": "..." }]`) or a shorthand `"message"` / `"prompt"` string. Automatically routes to the appropriate specialist agent (`AERON`, `NOVEX`, `VEXOR`, `ZENIQ`, `PIXORA`, `CODEX`) and supports English (`en`), Bengali (`bn`), Hindi (`hi`), or `auto`.

```bash
curl -s -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain how REST APIs work in 3 simple steps.",
    "languagePreference": "en",
    "webSearch": false
  }' | jq
```

**Example Response:**
```json
{
  "success": true,
  "requestId": "req_8f92a1c4b210",
  "provider": "gemini",
  "model": "gemini-3.8-flash",
  "usedFallback": false,
  "reply": "## How REST APIs Work in 3 Simple Steps\n...",
  "text": "## How REST APIs Work in 3 Simple Steps\n...",
  "agent": {
    "id": "ZENIQ",
    "name": "ZENIQ",
    "title": "Learning & Explanation Specialist",
    "reason": "Educational concept explanation detected"
  },
  "usage": {
    "inputChars": 44,
    "outputChars": 512,
    "latencyMs": 920
  },
  "timestamp": "2026-10-28T09:00:00.000Z"
}
```

### 4.4 `POST /api/v1/chat` (Real-Time SSE Streaming Mode)
Set `"stream": true` to receive real-time Server-Sent Events (`agent_routed`, `search_start`, `search_results`, `{ "text": "..." }`, `{ "done": true }`).

```bash
curl -N -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "messages": [
      { "role": "user", "content": "হ্যালো, কেমন আছো?" }
    ],
    "languagePreference": "bn"
  }'
```

### 4.5 `POST /api/v1/images`
Generates an AI illustration or image using the configured provider (`PIXORA`).

```bash
curl -s -X POST http://localhost:3000/api/v1/images \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A serene sunset over Radhanagar Beach in the Andaman Islands",
    "aspectRatio": "16:9",
    "style": "cinematic"
  }' | jq
```

### 4.6 `POST /api/v1/search`
Executes real-time web search via Tavily (if `TAVILY_API_KEY` is set) or the free-tier Open-Web engine.

```bash
curl -s -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{ "query": "latest ISRO space mission news" }' | jq
```

---

## 5. Replacing or Adding AI Providers Later

Because AI model execution is isolated inside `src/services/aiProvider.ts`, you can switch from Google Gemini to any **OpenAI-compatible provider** (Groq, OpenRouter, Together AI, Ollama, vLLM, or OpenAI) purely via environment variables—without editing route handlers or frontend code:

```env
AI_PROVIDER="openai-compatible"
CUSTOM_AI_PROVIDER_NAME="Groq Cloud"
CUSTOM_AI_BASE_URL="https://api.groq.com/openai/v1"
CUSTOM_AI_API_KEY="gsk_your_secret_key"
CUSTOM_AI_MODEL="llama-3.3-70b-versatile"
```

To register a brand-new custom SDK provider in code, implement the `AIProvider` interface in `src/services/aiProvider.ts` and call `registerAIProvider(new MyCustomProvider())`.

---

## 6. Deploying Your Own Backend (Render / Cloud Run) & Connecting the App

> **Important:** The repository includes `render.yaml` and `Dockerfile` so you can deploy your own API instance under your own account. Deployment is performed manually in your hosting dashboard using the steps below.

### Option A: Deploy to Render (Free Tier)
1. Push this project to your private GitHub repository.
2. In your [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint** (to use `render.yaml`) or **Web Service**.
3. Verify the settings:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start`
   - **Health Check Path:** `/api/v1/health`
4. In Render **Environment Variables**, add:
   - `GEMINI_API_KEY`: Your Google AI Studio API key
   - `CORS_ALLOWED_ORIGINS`: `*` (or your frontend domain)
   - `ANDAMAN_API_KEY`: *(Optional)* Secret token if you want to require `X-API-Key` for external requests
5. Click **Deploy**. Once live, verify your endpoint:
   ```bash
   curl https://your-service-name.onrender.com/api/v1/health
   ```

### Option B: Connect a Separately Hosted Frontend to Your Deployed API URL
- **Same-Server Deployment (Recommended for ₹0 cost):** Running `npm run build && npm run start` serves both the ANDAMAN AI frontend and `/api/v1/*` from the same URL automatically (`VITE_API_BASE_URL=""`).
- **Separate Frontend Hosting:** Set `VITE_API_BASE_URL="https://your-service-name.onrender.com"` in your frontend build environment. `src/services/apiClient.ts` will automatically route all `/api/v1/chat`, `/api/v1/models`, and `/api/live` calls to your deployed backend URL.
