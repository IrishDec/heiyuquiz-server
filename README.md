HeiyuQuiz — Server (API)

Express API for HeiyuQuiz. Creates quizzes, accepts submissions, and serves results.
👉 Frontend repo:(https://github.com/IrishDec/heiyuquiz-client/blob/main/README.md)

🌐 Prod base URL: https://heiyuquiz-server.onrender.com (replace if different)

📂 Project Structure
server/
├─ server.js                # API routes (Express)
└─ package.json             # deps: express, cors, node-fetch, openai
The client lives in a separate repo:(https://github.com/IrishDec/heiyuquiz-client/blob/main/README.md)

🔌 Endpoints (quick view)

Base URL: https://heiyuquiz-server.onrender.com

GET    /api/health
POST   /api/createQuiz            # OpenTrivia (stable)
POST   /api/createQuiz/ai         # GPT (beta) — returns provider: "ai"|"opentdb"
GET    /api/quiz/:id              # Public quiz (no answers)
POST   /api/quiz/:id/submit       # Body: { name, picks[] } → { ok, score }
GET    /api/quiz/:id/results      # Leaderboard
GET    /api/quiz/:id/answers      # For "My answers" panel (sanitized)

Server stores questions as { question, options, correctIdx }.
/answers maps to { q, options, correctIndex } for the client.

⚙️ Environment

PORT — default 4001
MAX_PARTICIPANTS — per-quiz cap (default 300)
OPENAI_API_KEY — required for /api/createQuiz/ai

🚀 Run locally
npm install
# set your key (for AI route)
export OPENAI_API_KEY=sk-...   # or use a .env with your process manager

node server.js
# -> http://localhost:4001


Point the client to your local server in its app.js:

window.SERVER_URL = "http://localhost:4001";

☁️ Deploy (Render)

Create a Web Service and deploy this repo.

Add environment variables:

OPENAI_API_KEY (required for AI route)

MAX_PARTICIPANTS (optional)

Health check: GET /api/health should return { ok: true }.

📝 Notes

In-memory storage (MVP). Move to a DB for persistence later.

The AI route normalizes output and falls back to OpenTrivia if generation fails, so the endpoint always responds.

Pair with the client: HeiyuQuiz Client
.

