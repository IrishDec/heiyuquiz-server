# HeiyuQuiz — Server (API)

Express API for HeiyuQuiz. Creates quizzes, accepts submissions, returns results.
Pairs with the frontend client.

**Frontend repo:** [HeiyuQuiz Client](https://github.com/REPLACE_THIS/heiyuquiz-client)  
**Production base URL:** `https://heiyuquiz-server.onrender.com` (change if different)

---

## Project Structure

server/
├─ server.js # Express routes
└─ package.json # deps: express, cors, node-fetch, openai

yaml
Copy code

> The client lives separately: [HeiyuQuiz Client](https://github.com/REPLACE_THIS/heiyuquiz-client)

---

## Requirements

- Node.js 18+
- An OpenAI API key (only if using the AI endpoint)

---

## Environment Variables

- `PORT` — default `4001`
- `MAX_PARTICIPANTS` — per-quiz cap (default `300`)
- `OPENAI_API_KEY` — required for `/api/createQuiz/ai`

---

## Run Locally

```bash
npm install
# (optional, only for AI route)
export OPENAI_API_KEY=sk-...

node server.js
# -> http://localhost:4001
Point the client to your local server (in the client repo’s app.js):

js
Copy code
window.SERVER_URL = "http://localhost:4001";
Endpoints
Base URL: https://heiyuquiz-server.onrender.com

bash
Copy code
GET    /api/health                    -> { ok: true }

POST   /api/createQuiz                # OpenTrivia (stable)
       Body: { category, amount, durationSec }
       -> { ok, quizId, closesAt }

POST   /api/createQuiz/ai             # GPT (beta, localized; falls back)
       Body: { category, topic, country, amount, durationSec }
       -> { ok, quizId, closesAt, provider: "ai" | "opentdb" }

GET    /api/quiz/:id                  # Public quiz (no answers)
       -> { ok, id, category, closesAt, open, questions:[{ q, options[] }] }

POST   /api/quiz/:id/submit           # Submit picks
       Body: { name, picks:number[] }
       -> { ok, score }

GET    /api/quiz/:id/results          # Leaderboard
       -> { ok, results:[{ name, score, submittedAt }], totalQuestions }

GET    /api/quiz/:id/answers          # For "My answers" panel
       -> { ok, questions:[{ q, options[], correctIndex }] }
Notes

Internally questions are stored as { question, options, correctIdx }.

/answers exposes a sanitized shape with correctIndex for the client.

Quick cURL Tests
bash
Copy code
# Health
curl -s https://heiyuquiz-server.onrender.com/api/health

# Create (OpenTrivia)
curl -s -X POST https://heiyuquiz-server.onrender.com/api/createQuiz \
  -H "Content-Type: application/json" \
  -d '{"category":"General","amount":3,"durationSec":120}'

# Create (AI, beta)
curl -s -X POST https://heiyuquiz-server.onrender.com/api/createQuiz/ai \
  -H "Content-Type: application/json" \
  -d '{"category":"General","topic":"Irish history","country":"IE","amount":5}'
Deploy on Render
Create a Web Service from this repo.

Add env vars:

OPENAI_API_KEY (required for AI)

MAX_PARTICIPANTS (optional)

Deploy. Health check: GET /api/health → { ok: true }.

Behavior & Fallbacks
The AI endpoint normalizes to { question, options, correctIdx }.

If generation fails or is invalid, it falls back to OpenTrivia and returns provider: "opentdb" so you can see which source was used.

bash
Copy code

Replace `https://github.com/REPLACE_THIS/heiyuquiz-client` with your actual client repo URL and you’re set.

