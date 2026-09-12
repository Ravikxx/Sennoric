const vscode = require('vscode');

function getPort() {
  return vscode.workspace.getConfiguration('sennoric').get('port', 3000);
}

class SennoricViewProvider {
  static viewType = 'sennoric.chat';

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'open_external') {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    });
  }

  postMessage(msg) {
    if (this._view) this._view.webview.postMessage(msg);
  }

  refresh() {
    if (this._view) this._view.webview.html = this._buildHtml(this._view.webview);
  }

  _buildHtml(webview) {
    const port = getPort();
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src 'unsafe-inline';
    script-src 'nonce-${nonce}';
    connect-src ws://localhost:* wss://localhost:*;
    img-src data: https:;
  ">
  <title>Sennoric</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      var(--vscode-sideBar-background, #12131a);
      --surface: var(--vscode-input-background, #1a1b24);
      --border:  var(--vscode-panel-border, #23242f);
      --text:    var(--vscode-foreground, #e8e9f0);
      --muted:   var(--vscode-descriptionForeground, #6b6d80);
      --accent:  #e8602c;
      --accent-d:#c04c1f;
      --green:   #34d399;
      --red:     #f87171;
    }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    /* ── Status bar ── */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #555; flex-shrink: 0;
      transition: background 0.3s;
    }
    .dot.connected  { background: var(--green); box-shadow: 0 0 5px var(--green); }
    .dot.connecting { background: #c9994a; animation: pulse 1.2s ease-in-out infinite; }
    .dot.error      { background: var(--red); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .status-model { margin-left: auto; color: var(--muted); }

    /* ── Messages ── */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 0 8px;
      scroll-behavior: smooth;
    }
    .messages::-webkit-scrollbar { width: 3px; }
    .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .msg {
      padding: 4px 12px;
      line-height: 1.55;
      font-size: 12.5px;
      animation: fadein .15s ease;
    }
    @keyframes fadein { from{opacity:0;transform:translateY(3px)} to{opacity:1;transform:none} }

    .msg-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 3px;
      margin-top: 10px;
    }
    .msg.user .msg-label  { color: var(--accent); }
    .msg.assistant .msg-label { color: var(--green); }
    .msg.info .msg-label  { color: var(--muted); }
    .msg.error .msg-label { color: var(--red); }

    .msg-content {
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.info .msg-content  { color: var(--muted); }
    .msg.error .msg-content { color: var(--red); }

    .msg-content code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .msg-content pre {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 6px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
    .msg-content pre code { background: none; border: none; padding: 0; }

    .thinking-dots {
      display: flex; gap: 3px; align-items: center; padding: 2px 0;
    }
    .thinking-dots span {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--muted);
      animation: blink 1.2s ease-in-out infinite;
    }
    .thinking-dots span:nth-child(2) { animation-delay: .2s; }
    .thinking-dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%,80%,100%{opacity:.3} 40%{opacity:1} }

    /* ── Empty state ── */
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px 16px;
      gap: 8px;
    }
    .empty-logo {
      width: 36px; height: 36px;
      background: var(--accent);
      border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      font-size: 17px;
      margin-bottom: 8px;
    }
    .empty-title { font-size: 14px; font-weight: 700; }
    .empty-sub { font-size: 11.5px; color: var(--muted); line-height: 1.5; max-width: 220px; }
    .empty-tip {
      margin-top: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 11px;
      color: var(--muted);
      text-align: left;
      width: 100%;
      max-width: 240px;
      line-height: 1.6;
    }
    .empty-tip b { color: var(--text); }
    .start-btn {
      margin-top: 4px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 7px 16px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s;
    }
    .start-btn:hover { background: var(--accent-d); }

    /* ── Disconnected banner ── */
    .disconnected-banner {
      display: none;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      font-size: 11.5px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .disconnected-banner.visible { display: block; }
    .disconnected-banner code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--bg);
      padding: 1px 5px;
      border-radius: 3px;
      color: var(--text);
      font-size: 11px;
    }

    /* ── Confirm bar ── */
    .confirm-bar {
      display: none;
      padding: 8px 12px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      font-size: 11.5px;
      flex-shrink: 0;
      gap: 8px;
      align-items: center;
    }
    .confirm-bar.visible { display: flex; }
    .confirm-bar span { flex: 1; color: var(--muted); }
    .confirm-btn {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      cursor: pointer;
      background: none;
      color: var(--text);
      transition: background .12s;
    }
    .confirm-btn.yes { background: var(--accent); border-color: var(--accent); color: #fff; }
    .confirm-btn.yes:hover { background: var(--accent-d); }
    .confirm-btn:hover { background: var(--border); }

    /* ── Input ── */
    .input-area {
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      padding: 8px;
      display: flex;
      gap: 6px;
      align-items: flex-end;
    }
    textarea {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: inherit;
      font-size: 12.5px;
      line-height: 1.5;
      padding: 7px 10px;
      resize: none;
      outline: none;
      min-height: 36px;
      max-height: 160px;
      overflow-y: auto;
      transition: border-color .12s;
    }
    textarea::placeholder { color: var(--muted); }
    textarea:focus { border-color: var(--accent); }
    .send-btn {
      width: 32px; height: 32px;
      background: var(--accent);
      border: none;
      border-radius: 6px;
      color: #fff;
      font-size: 15px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: background .12s, opacity .12s;
    }
    .send-btn:hover { background: var(--accent-d); }
    .send-btn:disabled { opacity: .35; cursor: default; }
  </style>
</head>
<body>

<div class="status-bar">
  <div class="dot connecting" id="dot"></div>
  <span id="status-text">Connecting…</span>
  <span class="status-model" id="status-model"></span>
</div>

<div class="disconnected-banner" id="disconnected-banner">
  Start the server: <code>sennoric --web</code> or <code>sennoric /web</code> in the terminal.
</div>

<div class="messages" id="messages">
  <div class="empty" id="empty">
    <div class="empty-logo">⚛</div>
    <div class="empty-title">Sennoric</div>
    <div class="empty-sub">AI coding agent. Ask anything, edit files, run tools.</div>
    <div class="empty-tip">
      <b>Tips</b><br>
      Right-click selected code → <b>Ask Sennoric about this</b><br>
      <kbd>Ctrl+Shift+A</kbd> to send selection<br>
      Right-click a file → <b>Add file to Sennoric context</b>
    </div>
  </div>
</div>

<div class="confirm-bar" id="confirm-bar">
  <span id="confirm-label"></span>
  <button class="confirm-btn" onclick="sendConfirm(false)">Deny</button>
  <button class="confirm-btn yes" onclick="sendConfirm(true)">Allow</button>
</div>

<div class="input-area">
  <textarea id="input" placeholder="Ask Sennoric…" rows="1"></textarea>
  <button class="send-btn" id="send-btn" onclick="send()" title="Send (Enter)">↑</button>
</div>

<script nonce="${nonce}">
  const PORT = ${port};
  const vscode = acquireVsCodeApi();

  let ws = null;
  let thinking = false;
  let streamEl = null;
  let streamContent = '';
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  // ── WebSocket ──────────────────────────────────────────────────────────────

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    setStatus('connecting', 'Connecting…');
    document.getElementById('disconnected-banner').classList.remove('visible');

    ws = new WebSocket('ws://localhost:' + PORT);

    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'hello', clientType: 'vscode' }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      setStatus('error', 'Not connected');
      document.getElementById('disconnected-banner').classList.add('visible');
      setThinking(false);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
        connect();
      }, reconnectDelay);
    };

    ws.onerror = () => {};
  }

  function handleMessage(msg) {
    if (msg.type === 'welcome') {
      setStatus('connected', 'Connected');
      const model = msg.model || '';
      document.getElementById('status-model').textContent = model;
      document.getElementById('disconnected-banner').classList.remove('visible');
      if (msg.history && msg.history.length > 0) {
        clearMessages();
        msg.history.forEach(m => appendMsg(m));
      }
      return;
    }

    if (msg.type === 'message') {
      finishStream();
      appendMsg(msg.msg);
      if (msg.msg.type !== 'user') setThinking(false);
      return;
    }

    if (msg.type === 'stream_chunk') {
      streamContent += msg.content;
      if (!streamEl) {
        streamEl = createMsgEl('assistant');
      }
      const contentEl = streamEl.querySelector('.msg-content');
      if (contentEl) contentEl.innerHTML = renderContent(streamContent);
      scrollBottom();
      return;
    }

    if (msg.type === 'status') {
      setThinking(msg.thinking);
      if (msg.model) document.getElementById('status-model').textContent = msg.model;
      return;
    }

    if (msg.type === 'confirm_request') {
      const label = msg.tool?.label || msg.tool?.name || 'Allow this action?';
      showConfirm(label);
      return;
    }

    if (msg.type === 'confirm_done') {
      hideConfirm();
      return;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderContent(text) {
    text = text.replace(/```(\\w*)\\n?([\\s\\S]*?)```/g, (_, lang, code) =>
      '<pre><code>' + escHtml(code.trim()) + '</code></pre>'
    );
    text = text.replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + escHtml(c) + '</code>');
    text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    const paras = text.split(/\\n{2,}/);
    return paras.map(p => '<p>' + p.replace(/\\n/g,'<br>') + '</p>').join('');
  }

  function createMsgEl(type) {
    removeEmpty();
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'msg ' + type;

    const labels = { user: 'You', assistant: 'Sennoric', info: 'Info', error: 'Error' };
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = labels[type] || type;

    const content = document.createElement('div');
    content.className = 'msg-content';

    div.appendChild(label);
    div.appendChild(content);
    container.appendChild(div);
    scrollBottom();
    return div;
  }

  function appendMsg(msg) {
    const type = msg.type === 'assistant_stream' ? 'assistant' : (msg.type || 'info');
    const el = createMsgEl(type);
    const contentEl = el.querySelector('.msg-content');
    if (type === 'assistant' || type === 'user') {
      contentEl.innerHTML = renderContent(msg.content || '');
    } else {
      contentEl.textContent = msg.content || '';
    }
  }

  function finishStream() {
    if (streamEl && streamContent) {
      const contentEl = streamEl.querySelector('.msg-content');
      if (contentEl) contentEl.innerHTML = renderContent(streamContent);
    }
    streamEl = null;
    streamContent = '';
  }

  function clearMessages() {
    const m = document.getElementById('messages');
    m.innerHTML = '<div class="empty" id="empty" style="display:none"></div>';
  }

  function removeEmpty() {
    const e = document.getElementById('empty');
    if (e) e.remove();
  }

  function scrollBottom() {
    const m = document.getElementById('messages');
    m.scrollTop = m.scrollHeight;
  }

  // ── Status / thinking ──────────────────────────────────────────────────────

  function setStatus(state, text) {
    const dot = document.getElementById('dot');
    dot.className = 'dot ' + state;
    document.getElementById('status-text').textContent = text;
  }

  function setThinking(on) {
    thinking = on;
    document.getElementById('send-btn').disabled = on;
    if (!on) {
      const t = document.getElementById('thinking-indicator');
      if (t) t.remove();
    }
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  const ta = document.getElementById('input');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function send() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { connect(); return; }
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    ta.style.height = 'auto';
    removeEmpty();
    ws.send(JSON.stringify({ type: 'submit', content: text, tab: 'code' }));
    setThinking(true);
  }

  // ── Confirm ────────────────────────────────────────────────────────────────

  function showConfirm(label) {
    document.getElementById('confirm-label').textContent = label;
    document.getElementById('confirm-bar').classList.add('visible');
  }

  function hideConfirm() {
    document.getElementById('confirm-bar').classList.remove('visible');
  }

  function sendConfirm(answer) {
    hideConfirm();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'confirm', answer }));
    }
  }

  // ── Messages from extension (inject text, new chat) ────────────────────────

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'inject') {
      ta.value += msg.content;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    }
    if (msg.type === 'new_chat') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'submit', content: '/clear', tab: 'code' }));
        clearMessages();
      }
    }
    if (msg.type === 'refresh') {
      clearMessages();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'hello', clientType: 'vscode' }));
      }
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────

  connect();
</script>

</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function activate(context) {
  const provider = new SennoricViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SennoricViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Open sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('sennoric.open', () => {
      vscode.commands.executeCommand('sennoric.chat.focus');
    })
  );

  // New chat
  context.subscriptions.push(
    vscode.commands.registerCommand('sennoric.newChat', () => {
      provider.postMessage({ type: 'new_chat' });
    })
  );

  // Send selected text to Sennoric
  context.subscriptions.push(
    vscode.commands.registerCommand('sennoric.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showInformationMessage('Sennoric: Select some code first.');
        return;
      }

      const lang = editor.document.languageId;
      const relativePath = vscode.workspace.asRelativePath(editor.document.fileName);
      const inject = `\`\`\`${lang} (${relativePath})\n${selection}\n\`\`\`\n\n`;

      provider.postMessage({ type: 'inject', content: inject });
      vscode.commands.executeCommand('sennoric.chat.focus');
    })
  );

  // Add entire file to Sennoric context
  context.subscriptions.push(
    vscode.commands.registerCommand('sennoric.addFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const relativePath = vscode.workspace.asRelativePath(editor.document.fileName);
      const lang = editor.document.languageId;
      const content = editor.document.getText();
      const inject = `\`\`\`${lang} (${relativePath})\n${content}\n\`\`\`\n\n`;

      provider.postMessage({ type: 'inject', content: inject });
      vscode.commands.executeCommand('sennoric.chat.focus');
    })
  );

  // Re-connect when port setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sennoric.port')) {
        provider.refresh();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
