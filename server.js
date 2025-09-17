import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
// --- Supabase client (persistence) ---
import { createClient } from "@supabase/supabase-js"; 

// Only init if BOTH env vars exist; otherwise run in memory-only mode.
const HAS_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
let supabase = null;

if (HAS_SUPABASE) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );
  console.log("[supabase] ON");
} else {
  console.warn("[supabase] OFF — missing SUPABASE_URL and/or SUPABASE_ANON_KEY");
}

// Helpers become no-ops if Supabase is OFF
async function dbSaveQuiz(payload){ if (!supabase) return;
  try {
    const { id, category, topic="", country="", createdAt, closesAt, questions=[] } = payload;
    const { error: e1 } = await supabase.from("quizzes").upsert(
      {
        id, category, topic, country,
        created_at: new Date(createdAt).toISOString(),
        closes_at: new Date(closesAt).toISOString(),
      },
      { onConflict: "id" }
    );
    if (e1) throw e1;

    const rows = questions.map((q,i)=>({
      quiz_id:id, idx:i,
      q:q.question||q.q||"",
      options:q.options||[],
      correct_idx: (typeof q.correctIdx==="number"? q.correctIdx : null)
    }));

    if (rows.length){
      await supabase.from("quiz_questions").delete().eq("quiz_id", id);
      const { error: e2 } = await supabase.from("quiz_questions").insert(rows);
      if (e2) throw e2;
    }
  } catch (err) { console.warn("[supabase] dbSaveQuiz failed:", err?.message||err); }
}

async function dbLoadQuiz(id){ if (!supabase) return null;
  try {
    const { data: qz, error: e1 } = await supabase
      .from("quizzes")
      .select("id, category, topic, country, closes_at")
      .eq("id", id).maybeSingle();
    if (e1 || !qz) return null;

    const { data: qs, error: e2 } = await supabase
      .from("quiz_questions")
      .select("idx, q, options, correct_idx")
      .eq("quiz_id", id).order("idx", { ascending:true });
    if (e2) throw e2;

    return {
      id:qz.id,
      category:qz.category,
      topic:qz.topic||"",
      country:qz.country||"",
      closesAt: qz.closes_at ? new Date(qz.closes_at).getTime() : undefined,
      questions:(qs||[]).map(r=>({
        question:r.q||"",
        options:r.options||[],
        correctIdx:(typeof r.correct_idx==="number"? r.correct_idx:null)
      }))
    };
  } catch (err){ console.warn("[supabase] dbLoadQuiz failed:", err?.message||err); return null; }
}

async function dbSaveSubmission(quizId, { name, score, picks = [], submittedAt }) { if (!supabase) return;
  try {
    const { error } = await supabase.from("quiz_submissions").insert({
      quiz_id: quizId,
      name,
      score,
      picks, // <-- JSON/JSONB column in your table
      submitted_at: new Date(submittedAt).toISOString()
    });
    if (error) throw error;
  } catch (err) {
    console.warn("[supabase] dbSaveSubmission failed:", err?.message || err);
  }
}


async function dbLoadResults(id){ if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("quiz_submissions")
      .select("name, score, submitted_at")
      .eq("quiz_id", id);
    if (error) throw error;
    return (data||[])
      .map(r=>({ name:r.name, score:r.score, submittedAt: r.submitted_at ? new Date(r.submitted_at).getTime():0 }))
      .sort((a,b)=> b.score - a.score || a.submittedAt - b.submittedAt);
  } catch (err){ console.warn("[supabase] dbLoadResults failed:", err?.message||err); return []; }
}
const app = express();

// CORS — allow your site + localhost + github pages (robust function)
const ALLOWED = [
  /^http:\/\/localhost(:\d+)?$/,
  /^https?:\/\/(www\.)?heiyuquiz\.com$/,
  /^https?:\/\/irishdec\.github\.io$/
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl / same-origin
    const ok = ALLOWED.some(rx => rx.test(origin));
    return cb(null, ok);
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight

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
// --- De-dup helpers (normalize + recent fetch) ---
function normalizeQ(s=""){
  return String(s)
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, " ")   // strip html entities
    .replace(/[^a-z0-9]+/g, " ")        // keep alnum
    .replace(/\s+/g, " ")
    .trim();
}

async function getRecentQuestionSet({ topic = "", country = "", days = 14 }) {
  if (!supabase) return new Set();
  try {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    // recent quiz ids for same topic/country
    let q1 = supabase
      .from("quizzes")
      .select("id")
      .gte("created_at", since);

    if (topic)   q1 = q1.eq("topic", topic);
    if (country) q1 = q1.eq("country", country);

    const { data: quizRows, error: e1 } = await q1;
    if (e1 || !quizRows?.length) return new Set();

    const ids = quizRows.map(r => r.id);

    // their questions
    const { data: qRows, error: e2 } = await supabase
      .from("quiz_questions")
      .select("q, quiz_id")
      .in("quiz_id", ids.slice(0, 100)); // safety cap
    if (e2 || !qRows?.length) return new Set();

    const norms = qRows
      .map(r => normalizeQ(r.q || ""))
      .filter(Boolean);

    return new Set(norms);
  } catch (err) {
    console.warn("[supabase] getRecentQuestionSet failed:", err?.message || err);
    return new Set();
  }
}


// Generate multiple-choice questions with GPT (family-friendly, country + difficulty aware)
async function generateAIQuestions({ topic = "general knowledge", country = "", amount = 5, difficulty = "medium" }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  // normalize difficulty
  const diff = String(difficulty || "medium").toLowerCase();
  const DIFF = (diff === "easy" || diff === "hard") ? diff : "medium";

  // normalize country code
  const COUNTRY = String(country || "").trim().toUpperCase();
  const HAS_COUNTRY = !!COUNTRY;

  const sys = [
    "You generate family-friendly multiple-choice trivia.",
    "Return JSON ONLY with the exact shape:",
    "{ \"questions\": [ { \"q\": string, \"options\": [string,string,string,string], \"correctIndex\": number } ] }",
    "Rules:",
    "- safe for ages 10+, no adult content, hate, self-harm or instructions for harm.",
    "- 1 concise sentence per question.",
    "- Exactly 4 options with 1 correct.",
    "- correctIndex is the index (0-3) in options.",
    "- Difficulty setting must be reflected in background knowledge required, specificity, and distractor plausibility.",
    "- Prefer varied subtopics and avoid overused trivia items."
  ].join(" ");

  const difficultyGuide = DIFF === "easy" ? [
      "- Easy: everyday knowledge, high get-rate, no niche facts.",
      "- Use simple wording and common topics."
    ] : DIFF === "hard" ? [
      "- Hard: advanced/specific knowledge, lower get-rate.",
      "- Include nuanced details, dates, lesser-known facts.",
      "- Use plausible distractors that are close to the truth."
    ] : [
      "- Medium: balanced difficulty, moderate specificity."
    ];

  const countryGuide = !HAS_COUNTRY ? [] : [
    `- Country focus: ISO 3166-1 alpha-2 code is "${COUNTRY}". Interpret it (e.g., IE=Ireland, GB=United Kingdom, US=United States).`,
    `- ${amount >= 5 ? "All or at least 4 of the" : "All"} questions must explicitly relate to that country (people, places, events, culture, sport, history, geography, etc.).`,
    "- Do NOT include questions primarily about other countries.",
    "- Include a healthy spread of subtopics within that country."
  ];

  // If topic is just “General”, make it country-specific
  const effectiveTopic = HAS_COUNTRY && /^general\b/i.test(String(topic))
    ? `General knowledge about the country "${COUNTRY}" (interpret the code to full country name).`
    : topic;

  const user = [
    `Create ${amount} questions.`,
    `Topic: ${effectiveTopic}.`,
    HAS_COUNTRY ? `Country code: ${COUNTRY}.` : "",
    `Difficulty: ${DIFF}.`,
    ...difficultyGuide,
    ...countryGuide
  ].filter(Boolean).join("\n");

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
    const options = Array.isArray(it.options) ? it.options.slice(0, 4).map(decodeHTML) : [];
    let correctIdx = Number.isInteger(it.correctIndex) ? it.correctIndex : null;
    if (!(correctIdx >= 0 && correctIdx < 4)) correctIdx = 0;
    return { question: q, options, correctIdx };
  });
}

// Health
app.get("/", (_, res) => res.send("HeiyuQuiz server running"));

// GPT-powered quiz (AI) — persists to Supabase (best-effort) with difficulty + novelty filtering
app.post("/api/createQuiz/ai", async (req, res) => {
  try {
    const {
      category = "General",
      topic = "",
      country = "",
      amount = 5,
      durationSec = 600,
      difficulty = "medium"
    } = req.body || {};

    try { logCreate?.("ai", { category, topic, country, amount, difficulty }); } catch {}

    const safeAmount   = Math.max(3, Math.min(10, Number(amount) || 5));
    const safeDuration = Math.max(60, Math.min(3600, Number(durationSec) || 600));
    const diff = String(difficulty || "medium").toLowerCase();
    const safeDifficulty = (diff === "easy" || diff === "hard") ? diff : "medium";

    const { topic: safeTopic } = sanitizeTopic(topic || category);
    const trimmedCountry = String(country || "").trim();

    // Load recent questions (same topic/country) to avoid repeats
    const recentSet = await getRecentQuestionSet({
      topic: safeTopic,
      country: trimmedCountry,
      days: 14
    });

    // Ask model for extras so we can filter
    const requestAmount = Math.min(15, safeAmount + 5);
    const rawQs = await generateAIQuestions({
      topic: safeTopic,
      country: trimmedCountry,
      amount: requestAmount,
      difficulty: safeDifficulty
    });
    if (!rawQs.length) return res.status(500).json({ ok: false, error: "AI returned no questions" });

    // Filter duplicates (recent + intra-quiz)
    const picked = [];
    const seen = new Set();
    for (const q of rawQs) {
      const norm = normalizeQ(q.question || q.q || "");
      if (!norm) continue;
      if (recentSet.has(norm)) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      picked.push(q);
      if (picked.length >= safeAmount) break;
    }
    // Top up if still short (still avoid intra-quiz dupes)
    if (picked.length < safeAmount) {
      for (const q of rawQs) {
        if (picked.length >= safeAmount) break;
        const norm = normalizeQ(q.question || q.q || "");
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        picked.push(q);
      }
    }

    const qs = picked.slice(0, safeAmount);
    if (!qs.length) return res.status(500).json({ ok: false, error: "Not enough unique questions" });

    // Store + persist
    const id = makeId();
    const createdAt = now();
    const closesAt  = createdAt + safeDuration * 1000;

    quizzes.set(id, { id, category, createdAt, closesAt, questions: qs, topic: safeTopic, country: trimmedCountry });
    submissions.set(id, []);
    participants.set(id, new Set());

    await dbSaveQuiz({ id, category, topic: safeTopic, country: trimmedCountry, createdAt, closesAt, questions: qs });

    res.json({ ok: true, quizId: id, closesAt, provider: "ai", totalQuestions: qs.length });
  } catch (e) {
    console.error("createQuiz/ai error", e);
    res.status(500).json({ ok: false, error: "AI quiz failed" });
  }
});

// --- Debug: check if a quiz exists in memory and in DB
app.get("/api/debug/quiz/:id", async (req, res) => {
  const id = req.params.id;
  const inMemory = quizzes.has(id);
  let dbQuiz = null;
  try { dbQuiz = await dbLoadQuiz(id); } catch {}

  res.json({
    ok: true,
    id,
    inMemory,
    db: !!dbQuiz,
    qCountMem: inMemory ? (quizzes.get(id)?.questions?.length || 0) : 0,
    qCountDb: dbQuiz?.questions?.length || 0
  });
});



// Get quiz for players (no answers leaked). Falls back to Supabase if memory miss.
app.get("/api/quiz/:id", async (req, res) => {
  let quiz = quizzes.get(req.params.id);

  // If not in memory (because server restarted/slept), try Supabase
  if (!quiz) {
    const fromDb = await dbLoadQuiz(req.params.id);
    if (fromDb && (fromDb.questions || []).length) {
      quiz = {
        id: fromDb.id,
        category: fromDb.category || "General",
        createdAt: now(),                          // unknown; not needed by clients
        closesAt: fromDb.closesAt ?? (now() + 86400*1000),
        questions: fromDb.questions,
        topic: fromDb.topic || "",
        country: fromDb.country || ""
      };
      quizzes.set(quiz.id, quiz);                  // cache for this process
      submissions.set(quiz.id, submissions.get(quiz.id) || []); // keep shape
      participants.set(quiz.id, participants.get(quiz.id) || new Set());
    }
  }

  if (!quiz) return res.status(404).json({ ok:false, error:"Quiz not found" });

  const open = now() <= quiz.closesAt;
  const publicQs = quiz.questions.map(q => ({ q: q.question, options: q.options }));
  res.json({
    ok:true,
    id:quiz.id,
    category:quiz.category,
    topic: quiz.topic || "",
    country: quiz.country || "",
    closesAt:quiz.closesAt,
    open,
    questions: publicQs
  });
});
    
// Submit answers (one per player fingerprint) + persist to Supabase (with DB fallback)
app.post("/api/quiz/:id/submit", async (req, res) => {
  const id = req.params.id;
  let quiz = quizzes.get(id);

  // Cold start: load from DB
  if (!quiz) {
    const fromDb = await dbLoadQuiz(id);
    if (fromDb && (fromDb.questions || []).length) {
      quiz = {
        id: fromDb.id,
        category: fromDb.category || "General",
        createdAt: now(),
        closesAt: fromDb.closesAt ?? (now() + 24 * 3600 * 1000),
        questions: fromDb.questions || [],
        topic: fromDb.topic || "",
        country: fromDb.country || ""
      };
      quizzes.set(id, quiz);
      submissions.set(id, submissions.get(id) || []);
      participants.set(id, participants.get(id) || new Set());
    }
  }

  if (!quiz) return res.status(404).json({ ok: false, error: "Quiz not found" });

  const { name = "Player", picks = [] } = req.body || {};
  const cleanName = String(name).slice(0, 24).trim() || "Player";

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
          || req.socket.remoteAddress || "ip";
  const fp = `${ip}:${cleanName.toLowerCase()}`;

  const partSet = participants.get(id) || new Set();
  if (partSet.size >= MAX_PARTICIPANTS && !partSet.has(fp)) {
    return res.status(503).json({ ok: false, error: "Quiz is at capacity, please try another round." });
  }

  const rows = submissions.get(id) || [];
  if (rows.some(r => r.fp === fp)) {
    return res.status(409).json({ ok: false, error: "You already submitted this quiz." });
  }

  let score = 0;
  const answers = Array.isArray(picks) ? picks : [];
  (quiz.questions || []).forEach((q, i) => {
    const pick = Number(answers[i]);
    if (Number.isInteger(pick) && pick === q.correctIdx) score++;
  });

  const row = { name: cleanName, score, submittedAt: now(), fp };

  // update memory + persist
  partSet.add(fp);
  participants.set(id, partSet);
  submissions.set(id, [...rows, row]);

  await dbSaveSubmission(id, { name: cleanName, score, submittedAt: row.submittedAt });

  res.json({ ok: true, score });
});


// Results (Winner → Loser). Falls back to Supabase if memory miss.
app.get("/api/quiz/:id/results", async (req, res) => {
  let quiz = quizzes.get(req.params.id) || null;
  let rows  = (submissions.get(req.params.id) || []).slice();

  // If nothing in memory, pull from DB
  if (!quiz) {
    const fromDb = await dbLoadQuiz(req.params.id);
    if (fromDb) {
      quiz = {
        id: fromDb.id,
        category: fromDb.category || "General",
        createdAt: now(),
        closesAt: fromDb.closesAt ?? (now() + 86400*1000),
        questions: fromDb.questions || [],
        topic: fromDb.topic || "",
        country: fromDb.country || ""
      };
      quizzes.set(quiz.id, quiz);
    }
  }
  if (!rows.length) {
    rows = await dbLoadResults(req.params.id);
  }

  // Shape + sort (keep existing behavior)
  const sorted = rows
    .map(r => ({ name: r.name, score: r.score, submittedAt: r.submittedAt }))
    .sort((a,b) => b.score - a.score || a.submittedAt - b.submittedAt);

  res.json({
    ok:true,
    id: req.params.id,
    category: quiz?.category || "General",
    totalQuestions: quiz?.questions?.length ?? 0,
    results: sorted
  });
});
// Health check (client pings this) — includes Supabase status
app.get("/api/health", async (req, res) => {
  let supabaseStatus = "off";
  if (supabase) {
    try {
      const { error } = await supabase
        .from("quizzes")
        .select("id", { head: true, count: "exact" })
        .limit(1);
      supabaseStatus = error ? "connected-but-error" : "up";
    } catch {
      supabaseStatus = "connected-but-error";
    }
  }
  res.json({ ok: true, where: "render", now: Date.now(), supabase: supabaseStatus });
});

// --- minimal debug logs for create endpoints
function logCreate(kind, { category, topic, country, amount }) {
  console.log(`[create:${kind}] cat="${category}" topic="${(topic||'').slice(0,60)}" country="${country}" amount=${amount}`);
}
// Answers: return sanitized questions with a reliable correctIndex (falls back to Supabase)
app.get("/api/quiz/:id/answers", async (req, res) => {
  const { id } = req.params;

  let quiz = quizzes.get(id);

  // If not in memory, try Supabase
  if (!quiz) {
    const fromDb = await dbLoadQuiz(id);
    if (fromDb && (fromDb.questions || []).length) {
      quiz = {
        id: fromDb.id,
        category: fromDb.category || "General",
        createdAt: now(),
        closesAt: fromDb.closesAt ?? (now() + 86400 * 1000),
        questions: fromDb.questions || [],
        topic: fromDb.topic || "",
        country: fromDb.country || ""
      };
      quizzes.set(id, quiz);
      submissions.set(id, submissions.get(id) || []);
      participants.set(id, participants.get(id) || new Set());
    }
  }

  if (!quiz) return res.status(404).json({ ok: false, error: "Quiz not found" });

  const questions = (quiz.questions || []).map(q => ({
    q: q.question || q.q || "",
    options: q.options || [],
    correctIndex: (typeof q.correctIdx === "number" ? q.correctIdx : null)
  }));

  res.json({ ok: true, id, questions });
});
// ---- Global error handler (prevents 502s, preserves CORS)
app.use((err, req, res, next) => {
  console.error("[express:error]", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "server_error" });
});


app.listen(PORT, () => console.log("HeiyuQuiz server on", PORT));
