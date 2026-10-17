// The coordinator agent: an avatar in the header that opens a panel with the
// live event feed (pushed by the server as {t:'agent', kind:'event', ...}) and
// a conversation with the agent (POST /api/agent, role 'coordinator').

const MAX_FEED = 200;
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (at) => {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// A person with a headset, as a 9×9 dot matrix (`#` lit).
const GLYPH = [
  '...###...',
  '..#####..',
  '.#.###.#.',
  '#..###..#',
  '##.....##',
  '##.###.##',
  '#.#####.#',
  '..#####.#',
  '......##.',
];

export function agentGlyph(size = 22) {
  const step = size / GLYPH.length;
  const r = step * 0.36;
  const dots = GLYPH.flatMap((row, y) =>
    [...row].map((c, x) => `<circle cx="${(x + 0.5) * step}" cy="${(y + 0.5) * step}" r="${r}" fill="${c === '#' ? 'currentColor' : 'rgba(255,255,255,0.1)'}"/>`),
  );
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${dots.join('')}</svg>`;
}

const CANNED = [
  'Situation (mock):',
  '3 of 4 responders online, 3 rooms mapped.',
  'iPhone 17 Pro: in Living, moving.',
  'Tom: in Kitchen (fixed camera).',
  'iPad mini: not placed — no video.',
  'Check on: iPad mini.',
].join('\n');

export class AgentPanel {
  /** @param {{ button: HTMLButtonElement, panel: HTMLElement, mock?: boolean }} opts */
  constructor({ button, panel, mock = false }) {
    this.button = button;
    this.panel = panel;
    this.mock = mock;
    this.open = false;
    this.unread = 0;
    this.busy = false;
    this.feed = panel.querySelector('.agent-feed');
    this.form = panel.querySelector('form');
    this.input = panel.querySelector('input');
    this.send = panel.querySelector('button[type="submit"]');
    button.querySelector('.agent-glyph').innerHTML = agentGlyph(22);
    panel.querySelector('.agent-title-glyph').innerHTML = agentGlyph(18);

    button.addEventListener('click', () => (this.open ? this.close() : this.show()));
    panel.querySelector('.agent-close').addEventListener('click', () => this.close());
    panel.querySelector('.agent-backdrop').addEventListener('click', () => this.close());
    panel.querySelector('.agent-report').addEventListener('click', () => this.ask(''));
    for (const chip of panel.querySelectorAll('[data-q]')) chip.addEventListener('click', () => this.ask(chip.dataset.q));
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (!q) return;
      this.input.value = '';
      this.ask(q);
    });
    panel.addEventListener('keydown', (e) => this.onKey(e));
    this.renderBadge();
  }

  // --- open / close, focus --------------------------------------------------

  show() {
    this.open = true;
    this.lastFocus = document.activeElement;
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.unread = 0;
    this.renderBadge();
    this.scrollToEnd();
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    (this.lastFocus instanceof HTMLElement ? this.lastFocus : this.button).focus();
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the panel while it's open.
    const focusable = [...this.panel.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  renderBadge() {
    const n = this.unread;
    this.button.classList.toggle('unread', n > 0);
    this.button.setAttribute('aria-label', n ? `Coordinator agent, ${n} new event${n === 1 ? '' : 's'}` : 'Coordinator agent');
  }

  // --- feed -----------------------------------------------------------------

  /** A server event: {t:'agent', kind:'event', at, text, level}. */
  onEvent(msg) {
    if (msg?.kind !== 'event' || typeof msg.text !== 'string') return;
    const li = this.item('event' + (msg.level === 'warn' ? ' warn' : ''));
    const time = document.createElement('time');
    time.textContent = clock(msg.at ?? Date.now());
    const text = document.createElement('span');
    text.textContent = msg.text;
    li.append(time, text);
    this.append(li);
    if (!this.open) {
      this.unread++;
      this.renderBadge();
    }
  }

  item(kind) {
    const li = document.createElement('li');
    li.className = `agent-item ${kind}`;
    return li;
  }

  append(li) {
    const stick = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 40;
    this.feed.append(li);
    while (this.feed.children.length > MAX_FEED) this.feed.firstElementChild.remove();
    if (stick || li.classList.contains('you')) this.scrollToEnd();
  }

  scrollToEnd() {
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  // --- asking -----------------------------------------------------------------

  setBusy(on) {
    this.busy = on;
    this.panel.classList.toggle('busy', on);
    for (const el of this.panel.querySelectorAll('.agent-report, [data-q], button[type="submit"]')) el.disabled = on;
  }

  async ask(question) {
    if (this.busy) return; // one request at a time
    const you = this.item('you');
    you.textContent = question || 'Situation report';
    this.append(you);
    const pending = this.item('agent pending');
    pending.innerHTML = '<span class="agent-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Thinking…</span>';
    pending.setAttribute('aria-live', 'polite');
    this.append(pending);
    this.setBusy(true);
    try {
      const reply = this.mock ? await this.mockAsk(question) : await this.post(question);
      pending.remove();
      const li = this.item('agent');
      const tag = document.createElement('span');
      tag.className = 'agent-source';
      tag.textContent = reply.source === 'claude' ? 'CLAUDE' : 'RULES';
      const text = document.createElement('p');
      text.textContent = reply.text;
      li.append(tag, text);
      li.setAttribute('aria-live', 'polite');
      this.append(li);
      this.scrollToEnd();
    } catch (err) {
      pending.remove();
      const li = this.item('agent error');
      li.textContent = `Couldn't reach the agent: ${err.message}. Check the connection and try again.`;
      this.append(li);
      this.scrollToEnd();
    } finally {
      this.setBusy(false);
      if (this.open) this.input.focus();
    }
  }

  async post(question) {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'coordinator', question }),
    });
    if (!res.ok) throw new Error(`server replied ${res.status}`);
    const body = await res.json();
    if (typeof body?.text !== 'string') throw new Error('unexpected reply');
    return body;
  }

  mockAsk(question) {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ text: question ? `${CANNED}\n\n(Asked: “${question}”)` : CANNED, source: 'rules' }), 700),
    );
  }
}

/** Mock mode: a few plausible events over time, delivered like server pushes. */
export function startMockEvents(handle) {
  const script = [
    ['iPhone 17 Pro connected', 'info'],
    ['iPhone 17 Pro placed on the map', 'info'],
    ['Tom connected', 'info'],
    ['Tom placed on the map', 'info'],
    ['iPad mini connected', 'info'],
    ['iPhone 17 Pro moved to Kitchen', 'info'],
    ['iPad mini lost their place', 'warn'],
    ["Pixel Web hasn't moved for 90 s", 'warn'],
  ];
  let i = 0;
  const next = () => {
    if (i >= script.length) return;
    const [text, level] = script[i++];
    handle({ t: 'agent', kind: 'event', at: Date.now(), text, level });
    setTimeout(next, i < 4 ? 400 : 5000);
  };
  setTimeout(next, 300);
}
