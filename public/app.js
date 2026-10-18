const $ = (id) => document.getElementById(id);

let status = {};
let messages = [];
let picked = null; // { to, toName }
let editingId = null;
let tab = 'upcoming';
let suggestions = [];
let activeSuggestion = -1;
let started = false;

class AuthError extends Error {}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showSignin();
    throw new AuthError(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- sign in ----------

function showSignin() {
  $('signin').hidden = false;
  $('app').hidden = true;
  $('conn').hidden = true;
  $('password').focus();
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('signin-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    boot();
  } catch (ex) {
    $('signin-error').textContent = ex.message;
    $('signin-error').hidden = false;
  }
});

$('signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showSignin();
});

// ---------- connection status ----------

async function refreshStatus() {
  try {
    status = await api('/api/status');
  } catch (ex) {
    if (ex instanceof AuthError) return;
    status = { status: 'offline' };
  }
  renderStatus();
}

function renderStatus() {
  const s = status.status;
  const desktop = status.mode === 'desktop';
  const labels = {
    starting: 'Starting…',
    qr: 'Not linked yet',
    disconnected: 'Reconnecting…',
    logged_out: 'Unlinked',
    error: 'Problem connecting',
    offline: 'Scheduler is not running',
    ready: desktop ? 'Using WhatsApp Desktop' : 'Connected',
  };
  $('conn').hidden = false;
  $('conn-text').textContent = labels[s] || s;
  $('conn').className = 'conn' + (s === 'ready' ? ' ready' : ['error', 'offline', 'logged_out'].includes(s) ? ' bad' : '');

  const needsLink = !desktop && ['qr', 'logged_out'].includes(s);
  $('link').hidden = s === 'ready' || s === 'disconnected' || (desktop && s !== 'error');
  $('qr').hidden = !(needsLink && status.qr);
  if (status.qr) $('qr').src = status.qr;
  $('link-text').hidden = !needsLink;
  $('pair').hidden = !needsLink;
  $('link-status').hidden = needsLink && !status.error;
  $('link-status').textContent = status.error || labels[s] || '';
  if (status.pairingCode) {
    const c = status.pairingCode;
    $('pair-code').textContent = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  }
  $('pair-result').hidden = !status.pairingCode;

  if (desktop) {
    $('to').placeholder = 'Phone number with country code, e.g. +966 50 123 4567';
    $('me').textContent = 'Sending through WhatsApp Desktop on this PC. Keep it signed in and Windows unlocked.';
  } else {
    $('me').textContent = status.me ? `Sending as ${status.me.name} (+${status.me.number})` : '';
  }
  $('unlink').hidden = desktop || s !== 'ready';

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('tz-note').hidden = !status.timezone || status.timezone === browserTz;
  $('tz-note').textContent = `Repeats follow the server time zone (${status.timezone}); your browser is in ${browserTz}.`;
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').hidden = true;
  $('pair-submit').disabled = true;
  try {
    await api('/api/whatsapp/pair', { method: 'POST', body: { phone: $('pair-phone').value } });
    await refreshStatus();
  } catch (ex) {
    $('pair-error').textContent = ex.message;
    $('pair-error').hidden = false;
  } finally {
    $('pair-submit').disabled = false;
  }
});

$('unlink').addEventListener('click', async () => {
  if (!confirm('Unlink WhatsApp? Scheduled messages stay queued until you link again.')) return;
  await api('/api/whatsapp/logout', { method: 'POST' }).catch((ex) => alert(ex.message));
  refreshStatus();
});

// ---------- recipient picker ----------

const looksLikePhone = (q) => /^\+?[\d\s().-]{7,}$/.test(q.trim());
const phoneSuggestion = (q) => {
  const digits = q.replace(/\D/g, '').replace(/^00/, '');
  return { to: digits, toName: `+${digits}`, kind: 'Phone number' };
};

let searchSeq = 0;
async function updateSuggestions() {
  const q = $('to').value;
  const seq = ++searchSeq;
  const list = looksLikePhone(q) ? [phoneSuggestion(q)] : [];
  if (q.trim() && status.mode !== 'desktop' && !looksLikePhone(q)) {
    try {
      const found = await api(`/api/contacts?q=${encodeURIComponent(q.trim())}`);
      if (seq !== searchSeq) return; // a newer keystroke won
      for (const c of found) list.push({ to: c.jid, toName: c.name, kind: c.isGroup ? 'Group' : 'Contact' });
    } catch {
      // keep phone suggestion only
    }
  }
  suggestions = list;
  activeSuggestion = list.length ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  const ul = $('suggestions');
  ul.innerHTML = '';
  suggestions.forEach((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = i === activeSuggestion ? 'active' : '';
    const name = document.createElement('span');
    name.textContent = s.toName;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind;
    li.append(name, kind);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(s);
    });
    ul.appendChild(li);
  });
  ul.hidden = suggestions.length === 0 || document.activeElement !== $('to');
}

function pick(s) {
  picked = s ? { to: s.to, toName: s.toName } : null;
  $('to').value = '';
  $('to').hidden = !!picked;
  suggestions = [];
  $('suggestions').hidden = true;
  const el = $('picked');
  el.hidden = !picked;
  el.replaceChildren();
  if (picked) {
    const name = document.createElement('span');
    name.textContent = picked.toName;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.title = 'Change recipient';
    clear.textContent = '×';
    clear.addEventListener('click', () => {
      pick(null);
      $('to').focus();
    });
    el.append(name, clear);
  }
  saveDraft();
}

let debounce;
$('to').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(updateSuggestions, 150);
});
$('to').addEventListener('blur', () => ($('suggestions').hidden = true));
$('to').addEventListener('focus', renderSuggestions);
$('to').addEventListener('keydown', (e) => {
  if (!suggestions.length) return;
  if (e.key === 'ArrowDown') activeSuggestion = Math.min(activeSuggestion + 1, suggestions.length - 1);
  else if (e.key === 'ArrowUp') activeSuggestion = Math.max(activeSuggestion - 1, 0);
  else if (e.key === 'Enter') {
    e.preventDefault();
    pick(suggestions[Math.max(activeSuggestion, 0)]);
    $('body').focus();
    return;
  } else return;
  e.preventDefault();
  renderSuggestions();
});

// ---------- form ----------

function toLocalInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setEditMode(id) {
  editingId = id;
  $('form-title').textContent = id ? 'Edit scheduled message' : 'Schedule a message';
  $('submit').textContent = id ? 'Save changes' : 'Schedule';
  $('cancel-edit').hidden = !id;
}

function resetForm() {
  setEditMode(null);
  pick(null);
  $('body').value = '';
  $('repeat').value = 'none';
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  soon.setMinutes(0, 0, 0);
  $('sendAt').value = toLocalInput(soon);
  $('form-error').hidden = true;
  $('draft-note').hidden = true;
  clearDraft();
}

function startEdit(m) {
  setEditMode(m.id);
  pick({ to: m.to, toName: m.toName });
  $('body').value = m.body;
  $('sendAt').value = toLocalInput(m.sendAt);
  $('repeat').value = m.repeat || 'none';
  $('form-error').hidden = true;
  $('draft-note').hidden = true;
  saveDraft();
  $('form').scrollIntoView({ behavior: 'smooth' });
}

$('cancel-edit').addEventListener('click', resetForm);

// ---------- draft cache: the form survives a refresh (stored in this browser only) ----------

const DRAFT_KEY = 'wa-scheduler:draft';
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function saveDraft() {
  const draft = {
    editingId,
    picked,
    toText: $('to').value,
    body: $('body').value,
    sendAt: $('sendAt').value,
    repeat: $('repeat').value,
    savedAt: Date.now(),
  };
  const empty = !editingId && !picked && !draft.toText.trim() && !draft.body.trim();
  try {
    if (empty) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage blocked (private window etc.); drafts just won't persist
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && Date.now() - d.savedAt < DRAFT_MAX_AGE_MS) return d;
  } catch {
    // corrupt or unavailable
  }
  return null;
}

async function restoreDraft(d) {
  if (!d) return;
  // Resume an edit only if that message is still waiting to be sent; otherwise keep it as a new draft.
  let editId = null;
  if (d.editingId) {
    const upcoming = await api('/api/messages?view=upcoming').catch(() => []);
    if (upcoming.some((m) => m.id === d.editingId && m.status === 'pending')) editId = d.editingId;
  }
  setEditMode(editId);
  pick(d.picked);
  if (!d.picked) $('to').value = d.toText || '';
  $('body').value = d.body || '';
  if (d.sendAt) $('sendAt').value = d.sendAt;
  $('repeat').value = d.repeat || 'none';
  $('draft-note').hidden = false;
  saveDraft();
}

for (const id of ['to', 'body', 'sendAt', 'repeat']) {
  $(id).addEventListener('input', saveDraft);
  $(id).addEventListener('change', saveDraft);
}
$('discard-draft').addEventListener('click', resetForm);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!picked && looksLikePhone($('to').value)) pick(phoneSuggestion($('to').value));

  const err = $('form-error');
  err.hidden = true;
  const payload = {
    to: picked?.to,
    toName: picked?.toName,
    body: $('body').value,
    sendAt: $('sendAt').value ? new Date($('sendAt').value).toISOString() : '',
    repeat: $('repeat').value,
  };
  $('submit').disabled = true;
  try {
    if (editingId) await api(`/api/messages/${editingId}`, { method: 'PUT', body: payload });
    else await api('/api/messages', { method: 'POST', body: payload });
    resetForm();
    setTab('upcoming');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('submit').disabled = false;
  }
});

// ---------- list ----------

const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const repeatLabel = { daily: 'Repeats daily', weekly: 'Repeats weekly', monthly: 'Repeats monthly' };
const ackLabel = { 1: '✓ Sending', 2: '✓ Sent', 3: '✓✓ Delivered', 4: '✓✓ Read', 5: '✓✓ Read' };

function relative(date) {
  const mins = Math.round((Date.parse(date) - Date.now()) / 60000);
  if (Math.abs(mins) < 1) return 'now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

async function loadMessages() {
  try {
    messages = await api(`/api/messages?view=${tab}`);
    renderList();
  } catch {
    // signed out or server down; the status bar says which
  }
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  loadMessages();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

function renderList() {
  if (tab === 'upcoming') $('count-upcoming').textContent = messages.length ? `(${messages.length})` : '';
  $('empty').hidden = messages.length > 0;
  $('empty').textContent = tab === 'upcoming' ? 'Nothing scheduled yet.' : 'No sent, failed or cancelled messages yet.';

  const ul = $('list');
  ul.replaceChildren();
  for (const m of messages) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-head"><span class="item-to"></span><span class="item-when"></span></div>
      <div class="item-body"></div>
      <div class="item-foot"><span class="meta"></span><span class="item-actions"></span></div>`;
    li.querySelector('.item-to').textContent = m.toName || m.to;
    li.querySelector('.item-when').textContent =
      m.status === 'sent' ? `Sent ${fmt.format(new Date(m.sentAt))}` : `${fmt.format(new Date(m.sendAt))} · ${relative(m.sendAt)}`;
    li.querySelector('.item-body').textContent = m.body;

    const meta = li.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = `badge ${m.status}`;
    badge.textContent = m.status === 'pending' && m.retryAt ? `retrying ${relative(m.retryAt)}` : m.status;
    meta.appendChild(badge);
    if (m.status === 'sent' && ackLabel[m.ack]) {
      const ack = document.createElement('span');
      ack.className = 'ack' + (m.ack >= 4 ? ' read' : '');
      ack.textContent = ` ${ackLabel[m.ack]}`;
      meta.appendChild(ack);
    }
    if (repeatLabel[m.repeat]) meta.append(` ${repeatLabel[m.repeat]}`);
    if (m.error) {
      const e = document.createElement('div');
      e.className = 'item-error';
      e.textContent = m.error;
      li.appendChild(e);
    }

    const actions = li.querySelector('.item-actions');
    const add = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (ex) {
          if (!(ex instanceof AuthError)) alert(ex.message);
        }
        loadMessages();
      });
      actions.appendChild(b);
    };
    const sendNow = () => confirm(`Send this to ${m.toName} now?`) && api(`/api/messages/${m.id}/send-now`, { method: 'POST' });
    const cancelMsg = m.repeat !== 'none' ? 'Cancel this message and its future repeats?' : 'Cancel this scheduled message?';
    if (m.status === 'pending') {
      add('Send now', sendNow);
      add('Edit', async () => startEdit(m));
      add('Cancel', () => confirm(cancelMsg) && api(`/api/messages/${m.id}`, { method: 'DELETE' }), 'danger');
    } else if (m.status === 'failed' || m.status === 'missed') {
      add('Send now', sendNow);
      add('Remove', () => api(`/api/messages/${m.id}`, { method: 'DELETE' }), 'danger');
    } else if (m.status !== 'sending') {
      add('Remove', () => api(`/api/messages/${m.id}`, { method: 'DELETE' }), 'danger');
    }
    ul.appendChild(li);
  }
}

// ---------- boot ----------

async function boot() {
  const session = await fetch('/api/session').then((r) => r.json()).catch(() => null);
  if (!session) {
    status = { status: 'offline' };
    renderStatus();
    setTimeout(boot, 3000);
    return;
  }
  if (!session.authenticated) return showSignin();

  $('signin').hidden = true;
  $('app').hidden = false;
  $('signout').hidden = !session.authRequired;
  const draft = loadDraft(); // read before resetForm() clears it
  resetForm();
  await restoreDraft(draft);
  await refreshStatus();
  loadMessages();
  if (!started) {
    started = true;
    setInterval(refreshStatus, 3000);
    setInterval(loadMessages, 5000);
  }
}

boot();
