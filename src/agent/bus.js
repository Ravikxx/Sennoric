// Shared message bus for agent-to-agent and agent-to-main communication.
// Singleton — imported by both tools.js and agent.js.
class AgentBus {
  constructor() {
    this._mailboxes = new Map(); // label → Message[]
    this._mainInbox = [];
    this._notices = new Map();   // label → creation/lifecycle notices (separate
                                 // from direct messages so read_messages can
                                 // surface them without draining _mainInbox,
                                 // which the spawn/todo/watcher flows rely on)
  }

  register(label) {
    if (!this._mailboxes.has(label)) this._mailboxes.set(label, []);
  }

  send(from, to, content) {
    const msg = { from, to, content, at: new Date().toLocaleTimeString() };
    if (to === 'main') {
      this._mainInbox.push(msg);
    } else {
      if (!this._mailboxes.has(to)) this._mailboxes.set(to, []);
      this._mailboxes.get(to).push(msg);
    }
  }

  // One-way lifecycle notice (e.g. "session X was created"). Read alongside
  // direct messages by read_messages / wait_for_message.
  notifyCreation(from, to, content) {
    if (!this._notices.has(to)) this._notices.set(to, []);
    this._notices.get(to).push({ from, to, content, at: new Date().toLocaleTimeString() });
  }

  readNotices(label) {
    const msgs = [...(this._notices.get(label) || [])];
    this._notices.set(label, []);
    return msgs;
  }

  read(label) {
    const msgs = [...(this._mailboxes.get(label) || [])];
    this._mailboxes.set(label, []);
    return msgs;
  }

  readMain() {
    const msgs = [...this._mainInbox];
    this._mainInbox = [];
    return msgs;
  }

  agents() {
    return [...this._mailboxes.keys()];
  }
}

// ── File Watcher Event Types ──────────────────────────────────────────────────
// Agents can subscribe via BUS.read('watcher') for any file change event.
// Message shape: { type, file, event, at }
export const FileWatcherEvents = {
  CREATED: 'FileWatcher:Created',
  CHANGED: 'FileWatcher:Changed',
  DELETED: 'FileWatcher:Deleted',
  ERROR:   'FileWatcher:Error',
};

export const BUS = new AgentBus();
