import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { BUSINESS_CONTEXT } from "./business-context.js";

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-5",
  ALLOWED_ORIGINS = "",
  PORT = 3000,
  DAILY_LIMIT = "200",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set it.");
  process.exit(1);
}

// These limits keep each request cheap, so your prepaid credit lasts.
const MAX_MESSAGES = 10;        // history sent to the model per request
const MAX_USER_CHARS = 800;     // per visitor message (longer ones are trimmed)
const MAX_REPLY_CHARS = 3000;   // per earlier bot reply kept in the history
const MAX_OUTPUT_TOKENS = 500;  // cap on each reply
const UPSTREAM_TIMEOUT_MS = 30_000;

// Total chats allowed per day across ALL visitors. Change it by adding a DAILY_LIMIT
// setting on Render (Environment tab), no code change needed.
const dailyLimit = Number(DAILY_LIMIT) || 200;

// The widget tells us which language its window is set to. A short or ambiguous message
// (like "AI") can't reveal the visitor's language, so for a Chinese window we ask for
// Chinese by default. A clear English sentence still gets an English answer.
const LANGUAGE_HINTS = {
  zh:
    "\n\nINTERFACE LANGUAGE: This visitor's chat window is set to Chinese (中文). " +
    "Reply in Simplified Mandarin Chinese by default, including for short or ambiguous messages. " +
    "Only reply in English if their latest message is clearly a full sentence written in English.",
  en: "",
};

// The count lives in memory, so it also resets if the server restarts.
// "Day" is the UTC day, which starts at 8:00 am Singapore time.
let dayKey = "";
let dayCount = 0;
function overDailyLimit() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  dayCount += 1;
  if (dayCount === dailyLimit + 1) console.warn(`Daily limit of ${dailyLimit} chats reached.`);
  return dayCount > dailyLimit;
}

const app = express();
app.set("trust proxy", 1); // needed for correct client IPs behind Render/Railway/etc.
app.use(express.json({ limit: "32kb" }));

const origins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.includes("*") ? true : origins,
    methods: ["POST", "GET"],
  })
);

// 10 requests per minute per IP: enough for real chatting, tight enough to limit abuse.
app.use(
  "/chat",
  rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many messages. Please wait a moment and try again." },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Returns a cleaned messages array, or null if the input is invalid.
function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;

  const cleaned = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" || !m.content.trim()) return null;
    // Trim instead of rejecting, so one long paste can't break the rest of the chat.
    const maxChars = m.role === "user" ? MAX_USER_CHARS : MAX_REPLY_CHARS;
    cleaned.push({ role: m.role, content: m.content.slice(0, maxChars) });
  }

  // The API expects the conversation to start with a user turn
  // (the widget's greeting is an assistant message, so drop leading ones).
  while (cleaned.length && cleaned[0].role !== "user") cleaned.shift();

  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned;
}

app.post("/chat", async (req, res) => {
  const messages = validateMessages(req.body?.messages);
  if (!messages) {
    return res.status(400).json({
      error: `Invalid request. Send up to ${MAX_MESSAGES} messages, ending with a user message.`,
    });
  }

  if (overDailyLimit()) {
    return res.status(429).json({
      error:
        "The guide has reached today's chat limit. Please come back tomorrow. 今日聊天次数已达上限，请明天再来。",
    });
  }

  const uiLang = req.body?.lang === "zh" ? "zh" : "en";
  const systemPrompt = BUSINESS_CONTEXT + LANGUAGE_HINTS[uiLang];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error(`Anthropic API ${upstream.status}:`, detail);
      const status = upstream.status === 429 ? 503 : 502;
      return res.status(status).json({
        error: "The assistant is unavailable right now. Please try again shortly.",
      });
    }

    const data = await upstream.json();
    const reply = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!reply) {
      return res.status(502).json({ error: "Empty response from the assistant." });
    }

    // Log for reviewing bad answers later (swap for a real logger/DB when ready).
    console.log(JSON.stringify({ t: new Date().toISOString(), q: messages.at(-1).content, a: reply }));

    res.json({ reply });
  } catch (err) {
    const timedOut = err.name === "AbortError";
    console.error(timedOut ? "Upstream timeout" : "Chat error:", err);
    res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? "The assistant took too long to respond. Please try again."
        : "Something went wrong. Please try again.",
    });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => console.log(`Chat backend listening on port ${PORT}`));
