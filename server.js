import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


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
// Toggle: use AI route or legacy route
const USE_AI = false;


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
// Simple regional question pool (1 picked per quiz if available)
function pickRegionalQuestion(category = "General", country = "") {
  const c = String(country || "").toUpperCase();
  const byCat = {
    Sports: [
      { regions:["IE","UK","EU"], q:"How many All-Ireland Senior Football titles has Kerry won the most of?", opts:["38","25","15","9"], correct:0 },
      { regions:["IE","UK","EU"], q:"Which sport is governed by the GAA?", opts:["Rugby","Gaelic games","Soccer","Cricket"], correct:1 },
      { regions:["US"], q:"Which team won Super Bowl I?", opts:["Packers","Cowboys","Jets","Chiefs"], correct:0 },
    ],
    History: [
      { regions:["IE","EU"], q:"In what year did Ireland become a republic (left the Commonwealth)?", opts:["1937","1949","1966","1973"], correct:1 },
    ],
    Geography: [
      { regions:["IE","EU"], q:"What is the capital of Ireland?", opts:["Cork","Galway","Dublin","Limerick"], correct:2 },
      { regions:["US"], q:"Which U.S. state is nicknamed the \"Sunshine State\"?", opts:["California","Florida","Arizona","Nevada"], correct:1 },
    ],
    Movies: [
      { regions:["IE","UK","EU"], q:"Which Irish actor stars in 'In Bruges'?", opts:["Colin Farrell","Cillian Murphy","Brendan Gleeson","Liam Neeson"], correct:0 },
    ],
    General: [
      { regions:["GLOBAL"], q:"How many minutes are in two hours?", opts:["60","90","100","120"], correct:3 },
    ],
    Science: [
      { regions:["GLOBAL"], q:"Which planet is known as the Red Planet?", opts:["Venus","Mars","Jupiter","Mercury"], correct:1 },
    ],
  };

  const pool = byCat[category] || byCat.General || [];
  const prefs = (c === "IE") ? ["IE","UK","EU","GLOBAL"]
              : (c === "GB" || c === "UK") ? ["UK","IE","EU","GLOBAL"]
              : (c === "US" || c === "CA") ? ["US","GLOBAL","EU"]
              : ["GLOBAL","EU","US"];

  for (const tier of prefs) {
    const list = pool.filter(x => x.regions.includes(tier));
    if (list.length) {
      const it = list[Math.floor(Math.random() * list.length)];
      return { question: it.q, options: it.opts, correctIdx: it.correct };
    }
  }
  return null;
}
// Family-friendly topic sanitizer
function sanitizeTopic(raw = "") {
  const BAD = [
    "porn","nsfw","sex","xxx","explicit",
    "rape","incest","bestiality",
    "self harm","suicide",
    "hate","slur","terrorism"
  ];
  const topic = String(raw).trim().slice(0, 80);
  const lowered = topic.toLowerCase();
  const allowed = !BAD.some(b => lowered.includes(b));
  return { topic: allowed ? topic || "general knowledge" : "general knowledge", allowed };
}


// Generate multiple-choice questions with GPT (family-friendly)
async function generateAIQuestions({ topic = "general knowledge", country = "", amount = 5 }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const sys = [
    "You generate family-friendly multiple-choice trivia.",
    "Return JSON ONLY with the exact shape:",
    "{ \"questions\": [ { \"q\": string, \"options\": [string,string,string,string], \"correctIndex\": number } ] }",
    "Rules:",
    "- safe for ages 10+, no adult content, hate, self-harm or instructions for harm.",
    "- 1 concise sentence per question.",
    "- Exactly 4 options with 1 correct.",
    "- correctIndex is the index (0-3) in options.",
  ].join(" ");

  const user = `Create ${amount} questions.
Topic: ${topic}.
${country ? `Bias facts/examples to ${country}.` : ""}`;

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  let data;
  try { data = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); }
  catch { data = { questions: [] }; }

  const arr = Array.isArray(data.questions) ? data.questions : [];

  // Normalize to your server shape
  return arr.slice(0, amount).map((it) => {
    const q = decodeHTML(it.q || it.question || "");
    const options = Array.isArray(it.options) ? it.options.slice(0,4).map(decodeHTML) : [];
    let correctIdx = Number.isInteger(it.correctIndex) ? it.correctIndex : null;

    // Safety: if model didn't give a valid correctIndex, just pick index 0
    if (!(correctIdx >= 0 && correctIdx < 4)) correctIdx = 0;

    return { question: q, options, correctIdx };
  });
}


// Health
app.get("/", (_, res) => res.send("HeiyuQuiz server running"));

// Create a broadcast quiz (host) — AI if a custom topic is given, else OpenTDB + regional bias
app.post("/api/createQuiz", async (req, res) => {
  try {
    const { category="General", topic="", country="", amount=5, durationSec=600 } = req.body || {};
    const id = makeId();

    let qs = [];
    const wantsAI = !!(topic && topic.trim().length >= 3 && process.env.OPENAI_API_KEY);

    // 1) If a custom topic is provided, try GPT first
    if (wantsAI) {
      try {
        // sanitize topic (fallback to safe general knowledge if blocked)
        const { topic: safeTopic } = sanitizeTopic(topic || category);

        // Ask GPT for questions using sanitized topic + country
        qs = await generateAIQuestions({
          topic: safeTopic,
          country: (country || "").trim(),
          amount: Math.max(3, Math.min(10, Number(amount) || 5)),
        });
      } catch (e) {
        console.warn("AI generation failed, falling back to OpenTDB:", e?.message || e);
        qs = [];
      }
    }

    // 2) Fallback: OpenTDB + 1 regional question at the front (if available)
    if (!qs.length) {
      const base = await getQuestions(catMap[category] ?? "", amount);
      const regional = pickRegionalQuestion(category, country);
      qs = regional ? [regional, ...base].slice(0, amount) : base;
    }

    // 3) Store quiz (same shape as before)
    const createdAt = now();
    const closesAt  = createdAt + durationSec * 1000;

    quizzes.set(id, { id, category, createdAt, closesAt, questions: qs });
    submissions.set(id, []);
    participants.set(id, new Set());

    res.json({ ok:true, quizId:id, closesAt, provider: wantsAI ? "ai" : "opentdb" });
  } catch (e) {
    console.error("createQuiz error", e);
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
