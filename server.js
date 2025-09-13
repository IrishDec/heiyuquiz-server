import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4001;

// ===== In-memory stores (MVP). Move to a DB later. =====
const quizzes = new Map();       // id -> { id, category, createdAt, closesAt, questions:[{question, options, correctIdx}] }
const submissions = new Map();   // id -> Array<{name, score, submittedAt}>
const participants = new Map();  // id -> Set<string> (simple capacity control)
const ipHits = new Map();        // very basic rate limit (per IP per minute)

const MAX_PARTICIPANTS = parseInt(process.env.MAX_PARTICIPANTS || "300", 10); // capacity cap per quiz
const catMap = { General:"", Movies:"11", Science:"17", Sports:"21", History:"23" };

const now = () => Date.now();
const makeId = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// Basic per-IP rate limit
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "ip";
  const key = `${ip}:${Math.floor(now()/60000)}`;
  const count = (ipHits.get(key) || 0) + 1;
  ipHits.set(key, count);
  if (count > 120) return res.status(429).json({ ok:false, error:"Too many requests, slow down." });
  next();
});

// Fetch & normalize questions from Open Trivia DB
async function getQuestions(categoryId, amount=5) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple${categoryId ? `&category=${categoryId}` : ""}`;
  const r = await fetch(url);
  const data = await r.json();
  const decode = (s)=> s
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&').replace(/&eacute;/g,'é')
    .replace(/&rsquo;/g,"’").replace(/&ldquo;/g,'“')
    .replace(/&rdquo;/g,'”');
  const qs = (data.results || []).map(item => {
    const options = [...item.incorrect_answers.map(decode), decode(item.correct_answer)];
    for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [options[i], options[j]] = [options[j], options[i]]; }
    const correctIdx = options.indexOf(decode(item.correct_answer));
    return { question: decode(item.question), options, correctIdx };
  });
  return qs;
}

// Health
app.get("/", (_, res) => res.send("HeiyuQuiz server running"));

// Create a broadcast quiz (host)
app.post("/api/createQuiz", async (req, res) => {
  try {
    const { category="General", amount=5, durationSec=600 } = req.body || {};
    const id = makeId();
    const qs = await getQuestions(catMap[category] ?? "", amount);
    const createdAt = now();
    const closesAt = createdAt + durationSec*1000;
    quizzes.set(id, { id, category, createdAt, closesAt, questions: qs });
    submissions.set(id, []);
    participants.set(id, new Set());
    res.json({ ok:true, quizId:id, closesAt, shareUrlHint:`/play#${id}` });
  } catch (e) {
    res.status(500).json({ ok:false, error:"Failed to create quiz" });
  }
});

// Get quiz for players (no answers leaked)
app.get("/api/quiz/:id", (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });
  const open = now() <= quiz.closesAt;
  const publicQs = quiz.questions.map(q => ({ q: q.question, options: q.options }));
  res.json({ ok:true, id:quiz.id, category:quiz.category, closesAt:quiz.closesAt, open, questions: publicQs });
});

// Submit answers
app.post("/api/quiz/:id/submit", (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });
  const { name="Player", picks=[] } = req.body || {};
  const fp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip") + ":" + String(name).trim().toLowerCase();
  const partSet = participants.get(quiz.id) || new Set();
  if (partSet.size >= MAX_PARTICIPANTS && !partSet.has(fp)) {
    return res.status(503).json({ ok:false, error:"Quiz is at capacity, please try another round." });
  }
  partSet.add(fp);
  participants.set(quiz.id, partSet);

  let score = 0;
  quiz.questions.forEach((q, i) => { if (Number(picks[i]) === q.correctIdx) score++; });
  const row = { name: String(name).slice(0,24), score, submittedAt: now() };
  submissions.get(quiz.id).push(row);
  res.json({ ok:true, score });
});

// Results (Winner → Loser)
app.get("/api/quiz/:id/results", (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });
  const rows = (submissions.get(quiz.id) || []).slice()
    .sort((a,b) => b.score - a.score || a.submittedAt - b.submittedAt);
  res.json({
    ok:true, id:quiz.id, category:quiz.category,
    totalQuestions: quiz.questions.length, results: rows
  });
});
// Health check (client pings this)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, where: 'render', now: Date.now() });
});

// Answers: return sanitized questions with a reliable correctIndex
app.get("/api/quiz/:id/answers", (req, res) => {
  const { id } = req.params;
  const quiz = quizzes.get(id);
  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });

  const questions = (quiz.questions || []).map(q => ({
    q: q.question || q.q || "",
    options: q.options || [],
    correctIndex: (typeof q.correctIdx === "number" ? q.correctIdx : null)
  }));

  res.json({ ok:true, id, questions });
});
// GPT-powered quiz (beta) — does NOT replace /api/createQuiz
app.post("/api/createQuiz/ai", async (req, res) => {
  try {
    const { category="General", topic="", country="", amount=5, durationSec=600 } = req.body || {};

    // testing location Qs
    const qs = await getQuestions(catMap[category] ?? "", amount);

    const id = makeId();
    const createdAt = now();
    const closesAt = createdAt + durationSec * 1000;

    quizzes.set(id, { id, category, createdAt, closesAt, questions: qs });
    submissions.set(id, []);
    participants.set(id, new Set());

    res.json({ ok:true, quizId:id, closesAt, provider:"ai" });
  } catch (e) {
    console.error("createQuiz/ai error", e);
    res.status(500).json({ ok:false, error:"AI quiz failed" });
  }
});

app.listen(PORT, () => console.log("HeiyuQuiz server on", PORT));
