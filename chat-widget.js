// AI Reading Guide chat widget — plain JS, no build step.
// Drop this file, chat-widget.css, and a `<div id="ew-chat-widget"></div>`
// into any page, then include both files. See index.html for a working example.

(function () {
  // Where your backend lives. Change this to your deployed URL once you host it
  // (e.g. "https://your-app.onrender.com/chat").
  const API_URL = "https://chatbot-backend-rzka.onrender.com/chat";

  // Text in both languages. The bot's actual replies switch language automatically
  // based on what the visitor types (that's handled server-side) — this just
  // controls the widget's own chrome (header, placeholder, greeting).
  const STRINGS = {
    en: {
      title: "AI Reading Guide",
      subtitle: "Usually replies in a few seconds",
      placeholder: "Ask me about AI...",
      greeting:
        "Hi! I'm your AI reading guide — tell me what you're curious about and I'll point you to good, trustworthy material on AI.",
      openLabel: "Open chat",
      closeLabel: "Close chat",
      sendLabel: "Send message",
      toggleTo: "中文",
      errorFallback: "Couldn't reach the guide right now. Please try again in a moment.",
    },
    zh: {
      title: "AI 阅读指南",
      subtitle: "通常几秒内回复",
      placeholder: "问我任何关于AI的问题...",
      greeting: "你好！我是你的AI阅读指南——告诉我你对什么感兴趣，我会为你推荐可靠的AI学习资料。",
      openLabel: "打开聊天",
      closeLabel: "关闭聊天",
      sendLabel: "发送消息",
      toggleTo: "EN",
      errorFallback: "暂时无法连接，请稍后再试。",
    },
  };

  let lang = "en";
  // Conversation lives in memory only; refreshing the page resets it.
  let messages = [{ role: "assistant", text: STRINGS.en.greeting }];
  let loading = false;
  let open = false;

  const mount = document.getElementById("ew-chat-widget");
  if (!mount) {
    console.error('chat-widget.js: no element with id="ew-chat-widget" found on the page.');
    return;
  }

  // --- Build the DOM once ---------------------------------------------------

  mount.innerHTML = `
    <div class="ew-root">
      <div class="ew-panel" id="ew-panel" hidden>
        <div class="ew-panel-header">
          <div class="ew-panel-header-icon">${bookIcon()}</div>
          <div class="ew-panel-header-text">
            <p class="ew-panel-header-title" id="ew-title"></p>
            <p class="ew-panel-header-sub" id="ew-subtitle"></p>
          </div>
          <button class="ew-lang-btn" id="ew-lang-btn" type="button"></button>
          <button class="ew-close-btn" id="ew-close-btn" aria-label="Close chat">${xIcon()}</button>
        </div>

        <div class="ew-msg-scroll" id="ew-msg-scroll"></div>

        <div class="ew-input-row">
          <textarea id="ew-input" rows="1" aria-label="Message"></textarea>
          <button class="ew-send-btn" id="ew-send-btn">${sendIcon()}</button>
        </div>
      </div>

      <button class="ew-launcher" id="ew-launcher" aria-label="Open chat">${messageIcon()}</button>
    </div>
  `;

  const panel = document.getElementById("ew-panel");
  const launcher = document.getElementById("ew-launcher");
  const closeBtn = document.getElementById("ew-close-btn");
  const langBtn = document.getElementById("ew-lang-btn");
  const titleEl = document.getElementById("ew-title");
  const subtitleEl = document.getElementById("ew-subtitle");
  const scrollEl = document.getElementById("ew-msg-scroll");
  const input = document.getElementById("ew-input");
  const sendBtn = document.getElementById("ew-send-btn");

  // --- Language ------------------------------------------------------------

  function applyLanguage() {
    const t = STRINGS[lang];
    titleEl.textContent = t.title;
    subtitleEl.textContent = t.subtitle;
    input.placeholder = t.placeholder;
    input.setAttribute("aria-label", t.placeholder);
    sendBtn.setAttribute("aria-label", t.sendLabel);
    langBtn.textContent = t.toggleTo;
    langBtn.setAttribute("aria-label", lang === "en" ? "Switch to Chinese" : "Switch to English");
    launcher.setAttribute("aria-label", open ? t.closeLabel : t.openLabel);

    // Only swap the greeting text if the conversation hasn't started yet —
    // never rewrite messages that were already sent/received.
    if (messages.length === 1 && messages[0].role === "assistant") {
      messages[0] = { role: "assistant", text: t.greeting };
      renderMessages();
    }
  }

  function toggleLanguage() {
    lang = lang === "en" ? "zh" : "en";
    applyLanguage();
  }

  // --- Rendering ---------------------------------------------------------

  function renderMessages() {
    scrollEl.innerHTML = "";

    for (const m of messages) {
      const row = document.createElement("div");
      row.className = `ew-msg-row ${m.role === "user" ? "user" : "agent"}`;
      const bubble = document.createElement("div");
      bubble.className = `ew-bubble ${m.role === "user" ? "ew-bubble-user" : "ew-bubble-agent"}`;
      bubble.textContent = m.text;
      row.appendChild(bubble);
      scrollEl.appendChild(row);
    }

    if (loading) {
      const row = document.createElement("div");
      row.className = "ew-msg-row agent";
      row.innerHTML = `
        <div class="ew-bubble ew-bubble-agent ew-typing">
          <span class="ew-steam-dot"></span><span class="ew-steam-dot"></span><span class="ew-steam-dot"></span>
        </div>`;
      scrollEl.appendChild(row);
    }

    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function setLoading(v) {
    loading = v;
    sendBtn.disabled = loading || !input.value.trim();
    renderMessages();
  }

  // --- Actions -------------------------------------------------------------

  function togglePanel() {
    open = !open;
    panel.hidden = !open;
    launcher.innerHTML = open ? xIcon() : messageIcon();
    launcher.setAttribute("aria-label", open ? STRINGS[lang].closeLabel : STRINGS[lang].openLabel);
    if (open) input.focus();
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || loading) return;

    messages.push({ role: "user", text });
    input.value = "";
    setLoading(true);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages.map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.text,
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data && data.error ? data.error : "Request failed");

      messages.push({ role: "assistant", text: data.reply });
    } catch (err) {
      const friendly =
        err.message && err.message !== "Failed to fetch" ? err.message : STRINGS[lang].errorFallback;
      messages.push({ role: "assistant", text: friendly });
    } finally {
      setLoading(false);
    }
  }

  // --- Wiring ----------------------------------------------------------

  launcher.addEventListener("click", togglePanel);
  closeBtn.addEventListener("click", togglePanel);
  langBtn.addEventListener("click", toggleLanguage);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("input", () => {
    sendBtn.disabled = loading || !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // --- Icons (inline SVG, no icon library needed) -------------------------

  function messageIcon() {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#182333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
  }
  function xIcon() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }
  function sendIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  }
  function bookIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#182333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  }

  // Initial paint.
  applyLanguage();
  renderMessages();
})();
