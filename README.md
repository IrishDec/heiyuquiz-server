# heiyuquiz-server

HeiyuQuiz — Server (API)

Express API for HeiyuQuiz. Creates quizzes, accepts submissions, and serves results. Pairs with the frontend client.

👉 Frontend repo: HeiyuQuiz Client

Endpoints (quick view)

GET /api/health → { ok:true }

POST /api/createQuiz → OpenTrivia quiz
Body: { category, amount, durationSec }

POST /api/createQuiz/ai → AI quiz (beta)
Body: { category, topic, country, amount, durationSec }
Returns provider:"ai" or fallback provider:"opentdb"

GET /api/quiz/:id → public quiz (no answers)

POST /api/quiz/:id/submit → { name, picks[] } → { ok:true, score }

GET /api/quiz/:id/results → leaderboard

GET /api/quiz/:id/answers → sanitized Q&A for “My answers”

Environment

PORT (default 4001)

MAX_PARTICIPANTS (default 300)

OPENAI_API_KEY (required for /api/createQuiz/ai)

Run locally
npm install
# set your key in env (or .env)
export OPENAI_API_KEY=sk-...

node server.js
# -> http://localhost:4001


Point the client to this URL in client/app.js:

window.SERVER_URL = "http://localhost:4001";

Deploy (Render)

Add env var OPENAI_API_KEY

(Optional) set MAX_PARTICIPANTS

Deploy; health check: /api/health

Notes

Data is stored in-memory (MVP). Swap to a DB for persistence.

The AI route normalizes questions to { question, options, correctIdx } and safely falls back to OpenTrivia if generation fails.
