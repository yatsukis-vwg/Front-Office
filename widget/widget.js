/**
 * Front Office — embeddable clinic chat widget.
 *
 * Drop one tag on any page:
 *
 *   <script src="https://YOUR-API-HOST/widget/widget.js"
 *           data-api="https://YOUR-API-HOST"
 *           data-clinic="noor-riyadh"
 *           data-locale="ar"
 *           data-accent="#0f766e"
 *           defer></script>
 *
 * No dependencies, no build step, no cookies. Everything lives inside a shadow
 * root so the clinic's own CSS cannot break it and vice versa.
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();

  var config = {
    api: (script.getAttribute('data-api') || window.location.origin).replace(/\/$/, ''),
    clinic: script.getAttribute('data-clinic') || '',
    locale: script.getAttribute('data-locale') === 'en' ? 'en' : 'ar',
    accent: script.getAttribute('data-accent') || '#0f766e',
    title: script.getAttribute('data-title') || '',
    position: script.getAttribute('data-position') || 'left',
    autoOpen: script.getAttribute('data-auto-open') === 'true',
  };

  var STRINGS = {
    ar: {
      launcher: 'كلمنا',
      placeholder: 'اكتب رسالتك…',
      send: 'إرسال',
      connecting: 'جاري الاتصال…',
      offline: 'ما قدرنا نوصل للخادم. جرّب مرة ثانية.',
      typing: 'يكتب…',
      close: 'إغلاق',
      poweredBy: 'مساعد العيادة الآلي',
    },
    en: {
      launcher: 'Chat with us',
      placeholder: 'Type your message…',
      send: 'Send',
      connecting: 'Connecting…',
      offline: 'Could not reach the server. Please try again.',
      typing: 'typing…',
      close: 'Close',
      poweredBy: 'Clinic assistant',
    },
  };

  var t = STRINGS[config.locale];
  var isRtl = config.locale === 'ar';

  var state = {
    sessionId: null,
    open: false,
    since: new Date(Date.now() - 1000).toISOString(),
    polling: null,
    busy: false,
    started: false,
  };

  // ---------------------------------------------------------------- styles

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Arabic",Tahoma,sans-serif}',
    '.launcher{position:fixed;bottom:20px;' + (isRtl ? 'left' : 'right') + ':20px;z-index:2147483000;',
    'display:flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;cursor:pointer;',
    'background:var(--accent);color:#fff;font-size:15px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.18)}',
    '.launcher:hover{filter:brightness(1.06)}',
    '.panel{position:fixed;bottom:88px;' + (isRtl ? 'left' : 'right') + ':20px;z-index:2147483000;',
    'width:370px;max-width:calc(100vw - 32px);height:min(560px,calc(100vh - 120px));',
    'display:none;flex-direction:column;overflow:hidden;border-radius:16px;background:#fff;',
    'box-shadow:0 20px 60px rgba(0,0,0,.24);direction:' + (isRtl ? 'rtl' : 'ltr') + '}',
    '.panel.open{display:flex}',
    '.header{background:var(--accent);color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.header .title{font-size:15px;font-weight:700;line-height:1.3}',
    '.header .sub{font-size:12px;opacity:.85;margin-top:2px}',
    '.header button{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;opacity:.9}',
    '.log{flex:1;overflow-y:auto;padding:14px;background:#f6f7f8;display:flex;flex-direction:column;gap:10px}',
    '.msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}',
    '.msg.them{background:#fff;color:#111;align-self:flex-start;border-' + (isRtl ? 'right' : 'left') + ':3px solid var(--accent)}',
    '.msg.me{background:var(--accent);color:#fff;align-self:flex-end}',
    '.msg.staff{background:#fffbeb;color:#111;align-self:flex-start;border-' + (isRtl ? 'right' : 'left') + ':3px solid #d97706}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f6f7f8}',
    '.chip{background:#fff;border:1px solid #d8dce0;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;color:#111}',
    '.chip:hover{border-color:var(--accent);color:var(--accent)}',
    '.typing{font-size:12px;color:#666;padding:0 16px 6px;background:#f6f7f8;min-height:18px}',
    '.composer{display:flex;gap:8px;padding:10px;border-top:1px solid #e6e8ea;background:#fff}',
    '.composer input{flex:1;border:1px solid #d8dce0;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;color:#111;background:#fff}',
    '.composer input:focus{border-color:var(--accent)}',
    '.composer button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:0 16px;font-size:14px;font-weight:600;cursor:pointer}',
    '.composer button:disabled{opacity:.5;cursor:default}',
    '.footer{font-size:11px;color:#8a9099;text-align:center;padding:0 0 8px;background:#fff}',
    '@media (max-width:480px){.panel{bottom:0;' + (isRtl ? 'left' : 'right') + ':0;width:100vw;height:100vh;border-radius:0}',
    '.launcher{bottom:14px}}',
  ].join('');

  // ------------------------------------------------------------------ DOM

  var host = document.createElement('div');
  host.setAttribute('data-front-office-widget', '');
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = ':host{--accent:' + config.accent + '}' + CSS;
  root.appendChild(style);

  var launcher = el('button', 'launcher');
  launcher.innerHTML = '<span aria-hidden="true">💬</span><span>' + escapeHtml(t.launcher) + '</span>';
  launcher.setAttribute('aria-label', t.launcher);

  var panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-live', 'polite');

  var header = el('div', 'header');
  var headerText = el('div');
  var headerTitle = el('div', 'title');
  headerTitle.textContent = config.title || t.launcher;
  var headerSub = el('div', 'sub');
  headerSub.textContent = t.connecting;
  headerText.appendChild(headerTitle);
  headerText.appendChild(headerSub);
  var closeBtn = el('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', t.close);
  header.appendChild(headerText);
  header.appendChild(closeBtn);

  var log = el('div', 'log');
  var chips = el('div', 'chips');
  var typing = el('div', 'typing');

  var composer = el('form', 'composer');
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t.placeholder;
  input.setAttribute('aria-label', t.placeholder);
  var sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.textContent = t.send;
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  var footer = el('div', 'footer');
  footer.textContent = t.poweredBy;

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(chips);
  panel.appendChild(typing);
  panel.appendChild(composer);
  panel.appendChild(footer);
  root.appendChild(launcher);
  root.appendChild(panel);

  function mount() {
    document.body.appendChild(host);
    if (config.autoOpen) togglePanel(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // ------------------------------------------------------------- behaviour

  launcher.addEventListener('click', function () {
    togglePanel(!state.open);
  });
  closeBtn.addEventListener('click', function () {
    togglePanel(false);
  });
  composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });

  function togglePanel(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    if (open) {
      if (!state.started) startSession();
      input.focus();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function startSession() {
    state.started = true;
    api('POST', '/api/chat/session', { clinic: config.clinic, locale: config.locale })
      .then(function (data) {
        state.sessionId = data.session_id;
        headerTitle.textContent = config.title || (data.clinic && data.clinic.name) || t.launcher;
        headerSub.textContent = (data.clinic && data.clinic.persona) || '';
        if (data.greeting) addMessage(data.greeting, 'them');
        renderChips(data.quick_replies || []);
      })
      .catch(function () {
        headerSub.textContent = '';
        addMessage(t.offline, 'them');
      });
  }

  function send(text) {
    if (!state.sessionId || state.busy) {
      // The session is still opening; retry shortly rather than dropping input.
      setTimeout(function () { send(text); }, 400);
      return;
    }
    addMessage(text, 'me');
    renderChips([]);
    state.busy = true;
    sendBtn.disabled = true;
    typing.textContent = t.typing;

    api('POST', '/api/chat/message', {
      clinic: config.clinic,
      session_id: state.sessionId,
      text: text,
      message_id: 'w' + Date.now() + Math.random().toString(36).slice(2, 8),
    })
      .then(function (data) {
        (data.messages || []).forEach(function (message) {
          addMessage(message.text, 'them');
          renderChips(message.quick_replies || []);
        });
        state.since = new Date().toISOString();
      })
      .catch(function () {
        addMessage(t.offline, 'them');
      })
      .then(function () {
        state.busy = false;
        sendBtn.disabled = false;
        typing.textContent = '';
      });
  }

  /** Picks up staff replies from the dashboard and scheduled reminders. */
  function startPolling() {
    if (state.polling) return;
    state.polling = setInterval(function () {
      if (!state.sessionId || state.busy) return;
      api('GET', '/api/chat/messages?session_id=' + encodeURIComponent(state.sessionId) +
        '&since=' + encodeURIComponent(state.since) +
        (config.clinic ? '&clinic=' + encodeURIComponent(config.clinic) : ''))
        .then(function (data) {
          (data.messages || []).forEach(function (message) {
            addMessage(message.text, message.from === 'staff' ? 'staff' : 'them');
          });
          if (data.now) state.since = data.now;
        })
        .catch(function () { /* transient network error; the next tick retries */ });
    }, 3000);
  }

  function stopPolling() {
    if (state.polling) clearInterval(state.polling);
    state.polling = null;
  }

  function addMessage(text, who) {
    var node = el('div', 'msg ' + who);
    node.textContent = text;
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
  }

  function renderChips(items) {
    chips.innerHTML = '';
    items.slice(0, 4).forEach(function (label) {
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.textContent = label;
      chip.addEventListener('click', function () {
        renderChips([]);
        send(label);
      });
      chips.appendChild(chip);
    });
  }

  function api(method, path, body) {
    return fetch(config.api + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      if (!response.ok) throw new Error('http ' + response.status);
      return response.json();
    });
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Small programmatic API so a clinic site can open the widget from its own CTA.
  window.FrontOfficeWidget = {
    open: function () { togglePanel(true); },
    close: function () { togglePanel(false); },
    send: send,
  };
})();
