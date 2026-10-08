(() => {
  'use strict';
  const API = String(window.EVENTSNAP_API || '').trim();
  const TOKEN = new URLSearchParams(location.search).get('e') || '';
  const list = document.getElementById('list');
  const row = (title) => { const li = document.createElement('li'); li.className = 'run'; li.innerHTML = '<span class="dot"></span><div><div class="title"></div><div class="detail">Checking…</div></div>'; li.querySelector('.title').textContent = title; list.appendChild(li); return { set(cls, detail) { li.className = cls; li.querySelector('.dot').textContent = cls === 'ok' ? '✓' : cls === 'bad' ? '!' : cls === 'warn' ? '?' : ''; li.querySelector('.detail').textContent = detail; return cls; } }; };
  async function post(action, data) {
    const t0 = performance.now();
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, data)), redirect: 'follow', cache: 'no-store', credentials: 'omit' });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch (e) { const err = new Error('The address did not return EventSnap data (HTTP ' + r.status + '). It is probably not deployed for "Anyone", or it is the wrong address.'); err.notJson = true; throw err; }
    return { j, ms: Math.round(performance.now() - t0) };
  }
  async function run() {
    list.textContent = ''; document.getElementById('cam-area').textContent = ''; const results = [];
    const secure = row('This page is served over HTTPS'); const cfg = row('config.js contains the backend address'); const be = row('Backend answers (cross-origin request)'); const ev = row('Event link' + (TOKEN ? '' : ' (add ?e=… to test one)')); const cam = row('Live camera is available');
    results.push(secure.set(window.isSecureContext ? 'ok' : 'bad', window.isSecureContext ? location.origin : 'This page is not secure, so phones will not offer the live camera. Host it on an https:// address (GitHub Pages, Netlify, Cloudflare Pages).'));
    if (!API) results.push(cfg.set('bad', 'EVENTSNAP_API is empty. Open config.js, paste the Web app URL between the quotes, and upload the site again.'));
    else if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$|^https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/[A-Za-z0-9_-]+\/exec$/.test(API)) results.push(cfg.set('warn', 'The address does not look like an Apps Script web app URL (it should end in /exec): ' + API));
    else results.push(cfg.set('ok', API.slice(0, 48) + '…'));
    if (API) {
      try { const { j, ms } = await post('ping'); results.push(be.set(j.ok ? 'ok' : 'bad', j.ok ? `EventSnap backend ${j.data.version} reachable in ${ms} ms` : j.error)); }
      catch (e) { results.push(be.set('bad', (e.notJson ? '' : 'Network/CORS error: ') + e.message + (e.notJson ? '' : ' Check that the deployment is "Execute as: Me" and "Who has access: Anyone", and that you copied the /exec address.'))); }
      if (TOKEN) { try { const { j } = await post('getEvent', { token: TOKEN }); results.push(ev.set(j.ok ? (j.data.status === 'open' ? 'ok' : 'warn') : 'bad', j.ok ? `“${j.data.name}” – status: ${j.data.status}, ${j.data.maxPerVisitor} photos per visitor` : j.error)); } catch (e) { results.push(ev.set('bad', e.message)); } }
      else ev.set('warn', 'Skipped. Open this page as check.html?e=<event code> to test a specific event.');
    } else { be.set('warn', 'Skipped (no backend address).'); ev.set('warn', 'Skipped.'); }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) results.push(cam.set('bad', 'This browser has no camera API. Visitors will use the phone camera app instead (still works).'));
    else { cam.set('warn', 'The browser supports it. Tap “Test camera” to confirm permission works.'); const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = 'Test camera'; b.style.marginTop = '.5rem'; document.getElementById('cam-area').appendChild(b);
      b.addEventListener('click', async () => { try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); const v = document.createElement('video'); v.className = 'check-video'; v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = s; document.getElementById('cam-area').appendChild(v); await v.play().catch(() => {}); cam.set('ok', 'Camera works (' + (s.getVideoTracks()[0].label || 'video input') + ').'); b.remove(); setTimeout(() => s.getTracks().forEach((t) => t.stop()), 4000); } catch (e) { cam.set('bad', 'Camera blocked or missing (' + e.name + '). Visitors can still use the phone camera app.'); } }); }
    const bad = results.filter((r) => r === 'bad').length;
    document.getElementById('summary').textContent = bad ? `${bad} problem${bad === 1 ? '' : 's'} found. Fix the red items and run the check again.` : 'Everything essential works. You are ready for your event.';
  }
  document.getElementById('rerun').addEventListener('click', run); run();
})();
