// Sennoric PWA — vanilla JS, no framework, no external deps.
// Streaming via fetch + ReadableStream reader (not EventSource — that's GET-only).

const modelPick = document.getElementById('model-pick');
const msgList   = document.getElementById('messages');
const input     = document.getElementById('input');
const sendBtn   = document.getElementById('send-btn');

let history   = [];   // [{role, content}] — full conversation kept client-side
let streaming = false;

// ── Model picker ──────────────────────────────────────────────────────────────

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function initModels() {
  const models = await loadModels();
  if (!models.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No models available';
    opt.disabled = true;
    modelPick.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelPick.appendChild(opt);
  }
  const saved = localStorage.getItem('sennoric-model');
  if (saved && models.includes(saved)) modelPick.value = saved;
  modelPick.addEventListener('change', () => localStorage.setItem('sennoric-model', modelPick.value));
}

// ── Message rendering ─────────────────────────────────────────────────────────

function clearWelcome() {
  const w = document.getElementById('welcome');
  if (w) w.remove();
}

function addMessage(role, text = '') {
  clearWelcome();
  const wrap   = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  msgList.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() {
  msgList.scrollTop = msgList.scrollHeight;
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ── Send ──────────────────────────────────────────────────────────────────────

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

async function send() {
  if (streaming) return;
  const text = input.value.trim();
  if (!text) return;

  const model = modelPick.value;
  if (!model) { addMessage('error', 'Pick a model first.'); return; }

  input.value = '';
  input.style.height = 'auto';

  history.push({ role: 'user', content: text });
  addMessage('user', text);

  const bubble = addMessage('assistant', '');
  bubble.classList.add('streaming');
  streaming = true;
  sendBtn.disabled = true;

  let assistantText = '';
  let errored = false;

  try {
    const res = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages: history }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(msg);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // last element may be incomplete
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break outer;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (typeof parsed === 'string') {
          assistantText += parsed;
          bubble.textContent = assistantText;
          scrollToBottom();
        } else if (parsed?.error) {
          throw new Error(parsed.error);
        }
      }
    }
  } catch (err) {
    errored = true;
    bubble.textContent = `Error: ${err.message || String(err)}`;
    bubble.closest('.msg').className = 'msg msg-error';
    history.pop(); // remove the user message that failed
  } finally {
    bubble.classList.remove('streaming');
    streaming = false;
    sendBtn.disabled = false;
    if (!errored && assistantText) {
      history.push({ role: 'assistant', content: assistantText });
    }
  }
}

// ── Service worker registration ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failure is non-fatal — app still works online.
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

initModels();
