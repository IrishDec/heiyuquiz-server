import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

// Save quiz + its questions
async function dbSaveQuiz({ id, category, topic = "", country = "", createdAt, closesAt, questions = [] }) {
  try {
    const { error: e1 } = await supabase
      .from("quizzes")
      .upsert(
        {
          id,
          category,
          topic,
          country,
          created_at: new Date(createdAt).toISOString(),
          closes_at: new Date(closesAt).toISOString(),
        },
        { onConflict: "id" }
      );
    if (e1) throw e1;

    const rows = questions.map((q, i) => ({
      quiz_id: id,
      idx: i,
      q: q.question || q.q || "",
      options: q.options || [],
      correct_idx: typeof q.correctIdx === "number" ? q.correctIdx : null,
    }));

    if (rows.length) {
      await supabase.from("quiz_questions").delete().eq("quiz_id", id);
      const { error: e2 } = await supabase.from("quiz_questions").insert(rows);
      if (e2) throw e2;
    }
  } catch (err) {
    console.warn("[supabase] dbSaveQuiz failed:", err?.message || err);
  }
}

// Load a quiz (with questions)
async function dbLoadQuiz(id) {
  try {
    const { data: qz, error: e1 } = await supabase
      .from("quizzes")
      .select("id, category, topic, country, closes_at")
      .eq("id", id)
      .maybeSingle();
    if (e1 || !qz) return null;

    const { data: qs, error: e2 } = await supabase
      .from("quiz_questions")
      .select("idx, q, options, correct_idx")
      .eq("quiz_id", id)
      .order("idx", { ascending: true });
    if (e2) throw e2;

    return {
      id: qz.id,
      category: qz.category,
      topic: qz.topic || "",
      country: qz.country || "",
      closesAt: qz.closes_at ? new Date(qz.closes_at).getTime() : undefined,
      questions: (qs || []).map((r) => ({
        question: r.q || "",
        options: r.options || [],
        correctIdx: typeof r.correct_idx === "number" ? r.correct_idx : null,
      })),
    };
  } catch (err) {
    console.warn("[supabase] dbLoadQuiz failed:", err?.message || err);
    return null;
  }
}

// Save a submission
async function dbSaveSubmission(quizId, { name, score, submittedAt }) {
  try {
    const { error } = await supabase
      .from("quiz_submissions")
      .insert({
        quiz_id: quizId,
        name,
        score,
        submitted_at: new Date(submittedAt).toISOString(),
      });
    if (error) throw error;
  } catch (err) {
    console.warn("[supabase] dbSaveSubmission failed:", err?.message || err);
  }
}

// Load submissions (results)
async function dbLoadResults(id) {
  try {
    const { data, error } = await supabase
      .from("quiz_submissions")
      .select("name, score, submitted_at")
      .eq("quiz_id", id);
    if (error) throw error;

    return (data || [])
      .map((r) => ({
        name: r.name,
        score: r.score,
        submittedAt: r.submitted_at ? new Date(r.submitted_at).getTime() : 0,
      }))
      .sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
  } catch (err) {
    console.warn("[supabase] dbLoadResults failed:", err?.message || err);
    return [];
  }
}


const app = express();

app.use(cors({
  origin: [
    'https://www.heiyuquiz.com',
    'https://irishdec.github.io'
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

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
// Minimal HTML entity decode for AI output
function decodeHTML(s=""){
  return String(s)
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&').replace(/&eacute;/g,'é')
    .replace(/&rsquo;/g,"’").replace(/&ldquo;/g,'“')
    .replace(/&rdquo;/g,'”');
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

// GPT-powered quiz (live, uses topic + country)
app.post("/api/createQuiz/ai", async (req, res) => {
  try {
    const { category="General", topic="", country="", amount=5, durationSec=600 } = req.body || {};

    // sanitize topic; fallback to category if empty
    const { topic: safeTopic } = sanitizeTopic(topic || category);

    // Generate questions via GPT
    const qs = await generateAIQuestions({
      topic: safeTopic,
      country: (country || "").trim(),
      amount: Math.max(3, Math.min(10, Number(amount) || 5)),
    });

    if (!qs.length) return res.status(500).json({ ok:false, error:"AI returned no questions" });

    // Store quiz (same shape as OpenTDB path)
    const id = makeId();
    const createdAt = Date.now();
    const closesAt  = createdAt + (durationSec * 1000);

    quizzes.set(id, { id, category, createdAt, closesAt, questions: qs });
    submissions.set(id, []);
    participants.set(id, new Set());

    res.json({ ok:true, quizId:id, closesAt, provider:"ai" });
  } catch (e) {
    console.error("createQuiz/ai error", e);
    res.status(500).json({ ok:false, error:"AI quiz failed" });
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

// Submit answers (one per player fingerprint)
app.post("/api/quiz/:id/submit", (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });

  const { name = "Player", picks = [] } = req.body || {};
  const cleanName = String(name).slice(0, 24).trim();

  // Build a simple fingerprint: IP + name (lowercased)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "ip";
  const fp = `${ip}:${cleanName.toLowerCase()}`;

  // Capacity control (existing behavior)
  const partSet = participants.get(quiz.id) || new Set();
  if (partSet.size >= MAX_PARTICIPANTS && !partSet.has(fp)) {
    return res.status(503).json({ ok:false, error:"Quiz is at capacity, please try another round." });
  }

  // ⛔ NEW: block duplicate submissions from the same fingerprint
  const rows = submissions.get(quiz.id) || [];
  if (rows.some(r => r.fp === fp)) {
    return res.status(409).json({ ok:false, error:"You already submitted this quiz." });
  }

  // Score answers
  let score = 0;
  quiz.questions.forEach((q, i) => { if (Number(picks[i]) === q.correctIdx) score++; });

  // Store result with fp (fp is not exposed to clients elsewhere)
  const row = { name: cleanName, score, submittedAt: Date.now(), fp };
  partSet.add(fp);
  participants.set(quiz.id, partSet);
  submissions.set(quiz.id, [...rows, row]);

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
// --- minimal debug logs for create endpoints
function logCreate(kind, { category, topic, country, amount }) {
  console.log(`[create:${kind}] cat="${category}" topic="${(topic||'').slice(0,60)}" country="${country}" amount=${amount}`);
}


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


app.listen(PORT, () => console.log("HeiyuQuiz server on", PORT));
