(() => {
  'use strict';
  const API = String(window.EVENTSNAP_API || '').trim();
  const TOKEN = new URLSearchParams(location.search).get('e') || '';
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'eventsnap_v_' + TOKEN;
  const MAX_EDGE = 1920, JPEG_Q = 0.82, THUMB_EDGE = 240, THUMB_Q = 0.6, MAX_BYTES = 2400000;   // keeps base64 under the server's 3.5 MB limit
  const state = { ev: null, vt: null, name: '', used: 0, max: 0, queue: [], facing: 'environment', stream: null, camGen: 0, uploading: false };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const show = (name) => document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + name));
  const toast = (msg, err) => { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); };
  const fail = (title, msg, retry) => { stopCamera(); $('e-title').textContent = title; $('e-msg').textContent = msg; $('e-retry').hidden = !retry; show('error'); };
  $('e-retry').addEventListener('click', () => location.reload());

  // ── Talking to the Apps Script backend ──
  // text/plain keeps this a "simple" cross-origin request (no CORS preflight, which Apps Script cannot answer);
  // redirect:"follow" is required because Apps Script answers through a redirect.
  async function api(action, data) {
    const mk = (msg, code, retry) => Object.assign(new Error(msg), { code, retry });
    let r;
    try { r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, data)), redirect: 'follow', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
    catch (e) { throw mk('Could not reach the server. Please check your connection.', 0, true); }
    let j; try { j = await r.json(); } catch (e) { throw mk('The photo service gave an unexpected answer. Please try again in a moment.', r.status || 502, true); }
    if (!j || j.ok !== true) throw mk((j && j.error) || 'Something went wrong.', (j && j.code) || 500, !!(j && j.retry));
    return j.data;
  }

  // ── Storage that never throws (private mode / blocked storage) ──
  const mem = {};
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } delete mem[k]; } };
  // IndexedDB keeps un-uploaded photos safe across reloads / crashes / lost signal
  const store = {
    db: null,
    open() { return new Promise((res) => { try { const r = indexedDB.open('eventsnap', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' }); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => res(); r.onblocked = () => res(); } catch (e) { res(); } }); },
    run(mode, fn) { return new Promise((res) => { if (!this.db) return res([]); try { const tx = this.db.transaction('photos', mode), req = fn(tx.objectStore('photos')); tx.oncomplete = () => res(req && req.result); tx.onerror = () => res([]); tx.onabort = () => res([]); } catch (e) { res([]); } }); },
    all() { return this.run('readonly', (os) => os.getAll()).then((a) => (a || []).filter((p) => p.token === TOKEN).sort((x, y) => x.ts - y.ts)); },
    put(rec) { return this.run('readwrite', (os) => os.put(rec)); },
    del(id) { return this.run('readwrite', (os) => os.delete(id)); }
  };
  const remaining = () => state.max - state.used - state.queue.length;
  const withUrl = (p) => Object.assign(p, { url: URL.createObjectURL(p.thumb) });

  // ── Start ──
  async function init() {
    if (!API) return fail('Not set up yet', 'The host still has to add the service address to config.js. Please let them know.');
    if (!/^[A-Za-z0-9_-]{32}$/.test(TOKEN)) return fail('Scan the QR code', 'Open this page by scanning the QR code at the event.');
    await store.open();
    try { state.ev = await api('getEvent', { token: TOKEN }); }
    catch (e) { return e.code === 404 ? fail('This QR code isn’t valid', 'Please scan the QR code at the event again, or ask the host for help.') : fail('Connection problem', e.message, true); }
    state.max = state.ev.maxPerVisitor;
    $('w-title').textContent = state.ev.name; $('c-event').textContent = state.ev.name; document.title = state.ev.name + ' · EventSnap';
    $('w-date').textContent = new Date(state.ev.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (state.ev.welcome) $('w-msg').textContent = state.ev.welcome;
    $('w-limit').textContent = `Up to ${plural(state.max, 'photo')}`;
    const saved = ls.get(LS_KEY);
    if (saved) {
      try {
        state.vt = JSON.parse(saved).vt; const me = await api('me', { vt: state.vt });
        state.used = me.used; state.max = me.max; state.name = me.name;
        if (me.finished) return done();
        if (me.status !== 'open') return closedMsg(me.status);
        return enterCamera();
      } catch (e) { if (e.code === 401 || e.code === 404) { ls.del(LS_KEY); state.vt = null; } else return fail('Connection problem', e.message, true); }
    }
    if (state.ev.status !== 'open') return closedMsg(state.ev.status);
    show('welcome');
  }
  function closedMsg(status) {
    if (status === 'scheduled') return fail('Not open yet', 'Photo collection for this event hasn’t started yet. Please try again later.');
    fail('Photo collection has ended', 'This event is no longer accepting photos. Thank you for taking part!');
  }
  $('w-start').addEventListener('click', async () => {
    const btn = $('w-start'); btn.disabled = true;
    try {
      const r = await api('join', { token: TOKEN, name: $('w-name').value });
      state.vt = r.visitorToken; state.name = r.name; state.used = r.used; state.max = r.max; ls.set(LS_KEY, JSON.stringify({ vt: r.visitorToken }));
      enterCamera();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  });
  $('w-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-start').click(); });

  // ── Live camera ──
  async function enterCamera() { state.queue = (await store.all()).map(withUrl); updateCamUi(); show('camera'); startCamera(); }
  function fallbackMode(msg) { $('c-fallback-msg').textContent = msg; $('c-fallback').hidden = false; $('c-flip').style.visibility = 'hidden'; }
  function stopCamera() { state.camGen++; if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; } const v = $('video'); v.srcObject = null; }
  async function startCamera() {
    stopCamera(); const gen = state.camGen; $('c-fallback').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) return fallbackMode('A live camera needs a secure (https) page. Use your phone’s camera instead.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
      if (gen !== state.camGen) { stream.getTracks().forEach((t) => t.stop()); return; }          // a newer start/stop happened meanwhile
      state.stream = stream; const v = $('video'); v.srcObject = stream; await v.play().catch(() => {});
      v.classList.toggle('mirror', state.facing === 'user');
      try { const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); $('c-flip').style.visibility = cams.length > 1 ? 'visible' : 'hidden'; } catch (e) { /* keep visible */ }
    } catch (e) {
      if (gen !== state.camGen) return;
      fallbackMode(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser settings, or use your phone’s camera.' : 'We couldn’t start the live camera. Use your phone’s camera instead.');
    }
  }
  $('c-flip').addEventListener('click', () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; startCamera(); });
  $('c-fallback-btn').addEventListener('click', () => $('file-input').click());
  $('c-native').addEventListener('click', () => { if (remaining() > 0) $('file-input').click(); else toast('You have reached your photo limit.'); });

  const toBlob = (canvas, q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
  async function encode(source, w, h) {
    const draw = (edge, q) => { const s = Math.min(1, edge / Math.max(w, h)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s)); c.getContext('2d').drawImage(source, 0, 0, c.width, c.height); return toBlob(c, q); };
    let q = JPEG_Q, blob = await draw(MAX_EDGE, q);
    while (blob && blob.size > MAX_BYTES && q > 0.5) { q -= 0.1; blob = await draw(MAX_EDGE, q); }
    if (blob && blob.size > MAX_BYTES) blob = await draw(1440, 0.7);
    return { blob, thumb: await draw(THUMB_EDGE, THUMB_Q) };
  }
  async function addPhoto({ blob, thumb }) {
    if (!blob || !thumb) return toast('Could not capture that photo.', true);
    const rec = { id: rand(), token: TOKEN, ts: Date.now(), blob, thumb };
    await store.put(rec); state.queue.push(withUrl(rec)); updateCamUi();
    if (navigator.vibrate) navigator.vibrate(25);
    if (remaining() <= 0) toast(`That’s your last photo (limit ${state.max}).`);
  }
  $('c-shutter').addEventListener('click', async () => {
    if (remaining() <= 0) return;
    const v = $('video');
    if (!state.stream || !v.videoWidth) return $('file-input').click();
    const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    await addPhoto(await encode(v, v.videoWidth, v.videoHeight));
  });
  $('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []).slice(0, Math.max(0, remaining())); e.target.value = '';
    for (const file of files) {
      try {
        let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (err) { bmp = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); }); }
        await addPhoto(await encode(bmp, bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight));
      } catch (err) { toast('That file could not be read as a photo.', true); }
    }
  });
  function updateCamUi() {
    const taken = state.used + state.queue.length, c = $('c-counter');
    c.textContent = `${taken} / ${state.max}`; c.classList.toggle('full', remaining() <= 0);
    $('c-shutter').disabled = remaining() <= 0;
    const last = state.queue[state.queue.length - 1];
    $('c-last').hidden = !last; $('c-nothumb').hidden = !!last; if (last) $('c-last').src = last.url;
    $('c-badge').hidden = !state.queue.length; $('c-badge').textContent = state.queue.length;
    $('c-finish').hidden = !state.queue.length; $('c-finish').textContent = `${remaining() <= 0 ? 'Review & upload' : 'Finish & upload'} (${state.queue.length})`;
  }

  // ── Review & upload ──
  $('c-review').addEventListener('click', openReview); $('c-finish').addEventListener('click', openReview);
  $('r-more').addEventListener('click', () => { show('camera'); startCamera(); });
  function openReview() { stopCamera(); renderReview(); show('review'); }
  function renderReview() {
    const g = $('r-grid'); g.textContent = '';
    state.queue.forEach((p) => {
      const t = document.createElement('div'); t.className = 't'; t.dataset.id = p.id;
      const i = document.createElement('img'); i.src = p.url; i.alt = 'Your photo';
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove photo');
      x.addEventListener('click', async () => { state.queue = state.queue.filter((q) => q.id !== p.id); await store.del(p.id); URL.revokeObjectURL(p.url); renderReview(); updateCamUi(); if (!state.queue.length) { show('camera'); startCamera(); } });
      t.append(i, x); g.appendChild(t);
    });
    $('r-sub').textContent = `${plural(state.queue.length, 'photo')} ready to upload`; $('r-counter').textContent = `${state.used + state.queue.length} / ${state.max}`;
    $('r-more').hidden = remaining() <= 0; $('r-upload').disabled = !state.queue.length;
  }
  const toB64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(blob); });
  async function uploadOne(p) {
    const [photo, thumb] = await Promise.all([toB64(p.blob), toB64(p.thumb)]);
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {                       // same photo id on every retry → server never double-counts
      try { return await api('upload', { vt: state.vt, pid: p.id, thumb, photo }); }
      catch (e) { last = e; if (!e.retry) throw e; await sleep(1000 * (attempt + 1) + Math.random() * 800); }
    }
    throw last;
  }
  $('r-upload').addEventListener('click', async () => {
    if (state.uploading || !state.queue.length) return;
    state.uploading = true; $('r-actions').hidden = true; $('r-progress').hidden = false; $('r-bar').style.width = '0';
    const total = state.queue.length; let ok = 0, problem = null;
    for (const p of [...state.queue]) {
      $('r-status').textContent = `Uploading photo ${ok + 1} of ${total}…`;
      try {
        const res = await uploadOne(p); state.used = res.used; ok++; $('r-bar').style.width = Math.round((ok / total) * 100) + '%';
        const el = $('r-grid').querySelector(`[data-id="${p.id}"]`); if (el) el.classList.add('done');
        await store.del(p.id); state.queue = state.queue.filter((q) => q.id !== p.id);
      } catch (e) { problem = e; break; }
    }
    state.uploading = false;
    if (!problem) { try { await api('finish', { vt: state.vt }); } catch (e) { /* photos are already stored */ } return done(ok); }
    $('r-progress').hidden = true; $('r-actions').hidden = false; renderReview(); updateCamUi(); $('r-upload').textContent = 'Try again';
    toast(problem.code === 0 ? 'No connection. Your photos are saved on this phone, please try again.' : problem.message, true);
  });
  function done(n) {
    stopCamera();
    const count = n != null ? n : state.used;
    $('d-title').textContent = state.name && state.name !== 'Guest' ? `Thank you, ${state.name}!` : 'Thank you!';
    $('d-msg').textContent = `${plural(count, 'photo')} shared with the host of ${state.ev.name}.`;
    show('done');
  }

  window.addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); else if ($('s-camera').classList.contains('active')) startCamera(); });
  init();
})();
