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
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set it.");
  process.exit(1);
}

const MAX_MESSAGES = 20;      // history sent to the model per request
const MAX_CHARS = 2000;       // per message
const UPSTREAM_TIMEOUT_MS = 30_000;

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

// 20 requests per minute per IP: enough for real chatting, tight enough to limit abuse.
app.use(
  "/chat",
  rateLimit({
    windowMs: 60_000,
    max: 20,
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
    if (m.content.length > MAX_CHARS) return null;
    cleaned.push({ role: m.role, content: m.content });
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
      error: `Invalid request. Send up to ${MAX_MESSAGES} messages of at most ${MAX_CHARS} characters, ending with a user message.`,
    });
  }

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
        max_tokens: 600,
        system: BUSINESS_CONTEXT,
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
