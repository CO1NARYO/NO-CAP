// content.js — runs on Google Forms pages only.
//
// It does three things and nothing else:
//   1. Reports Page Visibility changes (hidden / visible) to the background worker.
//   2. Shows a small status pill and, after an incident, a dismissible warning banner.
//   3. Tells the background worker when the Forms confirmation page is reached.
//
// It never reads questions, answers, form fields or page text, and it never modifies the form.
// The UI lives in a closed shadow root so it cannot disturb Google Forms' own styles or controls.

(() => {
  'use strict';
  if (window.__nocapContent) return;
  window.__nocapContent = true;

  const FORM_RESPONSE = /\/formResponse\/?$/;

  let myTabId = null;
  let session = null;
  let connected = false;
  let ui = null; // { root, pill, status, count, clock, banner, message, meta }
  let timer = null;
  let responseReportedFor = null;

  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this script is orphaned
    }
  };

  const active = (s) => !!s && (s.status === 'in_progress' || s.status === 'violation');
  const isExamTab = () => active(session) && myTabId != null && session.examTabId === myTabId;

  const clock = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .pill {
      position: fixed; top: 10px; right: 12px; display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 999px; background: #1a1f2b; color: #fff;
      font: 600 12px/1 system-ui, "Segoe UI", sans-serif; pointer-events: none; opacity: .94;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #3ddc84; }
    .pill.alert .dot { background: #ff5470; }
    .banner {
      position: fixed; top: 48px; left: 50%; transform: translateX(-50%);
      width: min(560px, calc(100vw - 24px)); display: none; gap: 14px; align-items: center;
      padding: 12px 14px; background: #fff; color: #1a1f2b; border: 2px solid #c81e3a; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(26, 31, 43, .28); font: 14px/1.4 system-ui, "Segoe UI", sans-serif;
    }
    .banner.show { display: flex; }
    .text { flex: 1; min-width: 0; }
    .msg { margin: 0 0 3px; font-weight: 700; color: #c81e3a; }
    .meta { margin: 0; font-size: 12.5px; color: #4a5366; }
    button {
      flex: none; padding: 9px 14px; border: 0; border-radius: 8px; background: #2b3fbf; color: #fff;
      font: 600 13px/1 system-ui, "Segoe UI", sans-serif; cursor: pointer;
    }
    button:focus-visible { outline: 3px solid #1a1f2b; outline-offset: 2px; }
  `;

  function mount() {
    if (ui) return;
    const root = document.createElement('div');
    root.id = 'nocap-root';
    root.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;';
    const shadow = root.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    const pill = mk('div', 'pill');
    pill.append(mk('span', 'dot'));
    const status = mk('span', '', 'NO CAP monitoring on');
    const count = mk('span', '', '0 incidents');
    const clk = mk('span', '', '00:00:00');
    const reporting = mk('span', '', 'Reporting to instructor');
    reporting.hidden = true;
    pill.append(status, reporting, count, clk);

    const banner = mk('div', 'banner');
    banner.setAttribute('role', 'alert');
    const text = mk('div', 'text');
    const message = mk('p', 'msg');
    const meta = mk('p', 'meta');
    text.append(message, meta);
    const button = mk('button', '', 'Resume exam');
    button.type = 'button';
    button.addEventListener('click', () => send({ type: 'ack' }));
    banner.append(text, button);

    shadow.append(style, pill, banner);
    document.documentElement.appendChild(root);
    ui = { root, pill, status, reporting, count, clock: clk, banner, message, meta };
    timer = setInterval(tick, 1000);
  }

  function unmount() {
    if (ui) ui.root.remove();
    ui = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function tick() {
    if (!ui || !session) return;
    ui.clock.textContent = clock(Date.now() - session.startedAt);
  }

  function render() {
    try {
      if (!isExamTab()) {
        unmount();
        return;
      }
      mount();

      const n = session.incidents.length;
      ui.count.textContent = `${n} incident${n === 1 ? '' : 's'}`;
      ui.pill.classList.toggle('alert', session.status === 'violation');
      ui.reporting.hidden = !connected;
      tick();

      const pending = [...session.incidents].reverse().find((i) => !i.ackTs);
      if (session.status === 'violation' && pending) {
        ui.message.textContent = pending.warning;
        ui.meta.textContent = `Incident ${n} was recorded at ${new Date(pending.ts).toLocaleTimeString()}. Return to the authorized exam page and continue.`;
        ui.banner.classList.add('show');
      } else {
        ui.banner.classList.remove('show');
      }

      if (FORM_RESPONSE.test(location.pathname) && responseReportedFor !== session.id) {
        responseReportedFor = session.id;
        send({ type: 'formResponse' });
      }
    } catch {
      /* extension context invalidated; stop quietly */
    }
  }

  document.addEventListener('visibilitychange', () => {
    send({ type: 'visibility', state: document.visibilityState === 'hidden' ? 'hidden' : 'visible', ts: Date.now() });
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.connection) connected = !!changes.connection.newValue;
      if (changes.session) session = changes.session.newValue || null;
      if (changes.session || changes.connection) render();
    });
  } catch {
    /* orphaned */
  }

  (async () => {
    const hello = await send({ type: 'hello' });
    myTabId = hello && hello.tabId != null ? hello.tabId : null;
    try {
      const stored = await chrome.storage.local.get(['session', 'connection']);
      session = stored.session || null;
      connected = !!stored.connection;
    } catch {
      session = null;
    }
    render();
    if (document.visibilityState === 'hidden') send({ type: 'visibility', state: 'hidden', ts: Date.now() });
  })();
})();
