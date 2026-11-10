/* Mock interview engine: one card per question, a countdown per question, auto-advance, answers recorded. */
(() => {
'use strict';
const M = window.MOCK;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HAS_HL = !!(window.hljs && window.hljs.highlight);
function hl(code, lang) {
  if (HAS_HL) { try { return hljs.highlight(code, { language: lang === 'sql' ? 'sql' : 'cpp', ignoreIllegals: true }).value; } catch (e) {} }
  return esc(code);
}
const plain = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };
const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const KEY = 'm3mock:' + M.id + ':';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(KEY + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {} }
};
const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);
const prefs = Object.assign({ voice: true, stt: false }, store.get('prefs') || {});
const CARDS = M.cards;
const TYPE_NAME = { talk: 'spoken', code: 'live coding', fix: 'fix the code', predict: 'typed answer', sql: 'typed SQL' };

/* ---------- editor (same one as the practice page) ---------- */
function makeEditor(initial, lang, onRun, onChange) {
  const wrap = el('div', 'editor');
  const pre = el('pre', 'ed-hl'); pre.setAttribute('aria-hidden', 'true');
  const code = el('code', 'hljs'); pre.appendChild(code);
  const ta = el('textarea', 'ed-ta');
  ta.spellcheck = false;
  ['autocapitalize', 'autocomplete', 'autocorrect'].forEach(a => ta.setAttribute(a, 'off'));
  ta.setAttribute('aria-label', (lang === 'sql' ? 'SQL' : 'C++') + ' code editor.' + (onRun ? ' Ctrl+Enter runs.' : '') + ' Press Escape then Tab to leave the editor.');
  const inner = el('div', 'ed-in'); inner.append(pre, ta); wrap.appendChild(inner);
  ta.value = initial;
  const paint = () => { code.innerHTML = hl(ta.value, lang) + ' '; };
  const insert = text => {
    ta.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) {}
    if (!ok) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
  };
  let escArmed = false;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { escArmed = true; return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (onRun) onRun(); return; }
    if (e.key === 'Tab' && !escArmed && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); insert('    '); return; }
    escArmed = false;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
      const v = ta.value, pos = ta.selectionStart;
      const line = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos);
      let indent = (line.match(/^[ \t]*/) || [''])[0];
      if (/[{(]\s*$/.test(line)) indent += '    ';
      e.preventDefault(); insert('\n' + indent); return;
    }
    if (e.key === '}' && ta.selectionStart === ta.selectionEnd) {
      const v = ta.value, pos = ta.selectionStart;
      const before = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos);
      if (/^ {4,}$/.test(before)) { e.preventDefault(); ta.setSelectionRange(pos - 4, pos); insert('}'); }
    }
  });
  ta.addEventListener('input', () => { paint(); if (onChange) onChange(ta.value); });
  paint();
  return { wrap, ta, get: () => ta.value, set: v => { ta.value = v; paint(); if (onChange) onChange(v); } };
}

/* ---------- compiler ---------- */
const stripAnsi = s => (s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const joinLines = a => (a || []).map(x => x.text).join('\n');
async function timedFetch(url, opts, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: c.signal })); } finally { clearTimeout(t); }
}
async function viaGodbolt(source) {
  const body = { source, options: { userArguments: '-O0 -std=c++17', executeParameters: { args: [], stdin: '' }, compilerOptions: { executorRequest: true }, filters: { execute: true }, tools: [], libraries: [] }, lang: 'c++', allowStoreCodeDebug: true };
  const r = await timedFetch('https://godbolt.org/api/compiler/g132/compile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) }, 25000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const b = j.buildResult || {};
  if (b.code && b.code !== 0) return { ok: false, errors: stripAnsi(joinLines(b.stderr) || joinLines(b.stdout)) };
  return { ok: true, stdout: joinLines(j.stdout), stderr: stripAnsi(joinLines(j.stderr)), exit: j.code };
}
async function viaWandbox(source) {
  const r = await timedFetch('https://wandbox.org/api/compile.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ compiler: 'gcc-13.2.0', code: source, 'compiler-option-raw': '-std=c++17' }) }, 25000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.compiler_error && /error/.test(j.compiler_error) && j.program_output == null && j.program_error == null) return { ok: false, errors: stripAnsi(j.compiler_error) };
  return { ok: true, stdout: (j.program_output || '').replace(/\n$/, ''), stderr: (j.program_error || '') + (j.signal ? '\nSignal: ' + j.signal : ''), exit: Number(j.status || 0) };
}
async function compileRun(source) {
  let last;
  for (const fn of [viaGodbolt, viaWandbox]) { try { return await fn(source); } catch (e) { last = e; } }
  throw last || new Error('unreachable');
}
const tidy = text => text.replace(/(?:<source>|prog\.cc): /g, '').replace(/(?:<source>|prog\.cc):(\d+)(?::(\d+))?:/g, (m, ln, col) => 'line ' + ln + (col ? ':' + col : '') + ':');

/* ---------- interviewer voice (optional) ---------- */
function speak(text) {
  if (!prefs.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const vs = speechSynthesis.getVoices();
    const v = vs.find(x => /en[-_]GB/i.test(x.lang) && /natural|online/i.test(x.name)) || vs.find(x => /en[-_]GB/i.test(x.lang)) || vs.find(x => /^en/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'en-GB'; u.rate = 1.03;
    speechSynthesis.speak(u);
  } catch (e) {}
}
const hush = () => { try { speechSynthesis.cancel(); } catch (e) {} };
try { if ('speechSynthesis' in window) speechSynthesis.getVoices(); } catch (e) {}

/* ---------- optional auto-transcript of spoken answers ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const stt = { on: false, rec: null, words: 0, dead: false };
function sttStart() {
  if (!SR || !stt.on || stt.dead || stt.rec) return;
  const target = cur;                       // words heard by this session belong to this question
  if (!target) return;
  let r;
  try { r = new SR(); } catch (e) { stt.dead = true; micUI(); return; }
  r.continuous = true; r.interimResults = false; r.lang = 'en-GB';
  r.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const t = e.results[i][0].transcript.trim();
      if (!t) continue;
      target.transcript = (target.transcript ? target.transcript + ' ' : '') + t;
      stt.words += t.split(/\s+/).length;
    }
    micUI(); saveSoon();
  };
  r.onerror = e => { if (/not-allowed|service-not-allowed|audio-capture/.test(e.error)) { stt.dead = true; micUI(); } };
  r.onend = () => { if (stt.rec === r) stt.rec = null; if (state.running && !state.paused) setTimeout(sttStart, 150); };
  try { r.start(); stt.rec = r; } catch (e) {}
  micUI();
}
function sttCut() { if (stt.rec) { try { stt.rec.stop(); } catch (e) {} } }   // onend restarts it for the next question
function micUI() {
  const m = $('#mic'); if (!m) return;
  m.hidden = !stt.on;
  m.classList.toggle('off', stt.dead || !stt.rec);
  m.textContent = stt.dead ? 'Mic blocked' : 'Transcript ' + stt.words + 'w';
}

/* ---------- state ---------- */
const state = { running: false, paused: false, locked: false, i: -1, total: 0, q: 0, pauses: 0, answers: [], startedAt: '' };
let cur = null;        // record for the question on screen
let collect = null;    // reads the final typed/coded answer off the card
let wake = null;
let saveT;
function snapshot(finished) {
  const answers = state.answers.slice();
  if (!finished && cur) answers.push(Object.assign({}, cur, { used: state.q, ended: 'unfinished' }));
  return { mock: M.id, title: M.title, startedAt: state.startedAt, total: state.total, pauses: state.pauses, finished: !!finished, voice: prefs.voice, stt: stt.on, answers };
}
function save(finished) { store.set('session', snapshot(finished)); }
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(() => { if (state.running) save(false); }, 500); }

/* ---------- export ---------- */
function exportText(s) {
  const L = [];
  L.push('=== ' + s.title.toUpperCase() + ' : MY ANSWERS ===');
  L.push('Started: ' + s.startedAt + ' | Interview time: ' + fmt(s.total) + ' | Pauses: ' + s.pauses + ' | ' + (s.finished ? 'Finished' : 'NOT finished (stopped at Q' + s.answers.length + ')'));
  L.push(s.stt ? 'Auto-transcript was ON (rough, expect mistakes). My own recording transcript goes underneath.' : 'Spoken answers are not in this file. My voice transcript goes underneath.');
  s.answers.forEach(a => {
    L.push('');
    L.push('[Q' + a.n + '] ' + a.sec.toUpperCase() + ' | ' + (TYPE_NAME[a.type] || a.type) + ' | used ' + fmt(a.used) + ' of ' + fmt(a.limit) + (a.aim ? ' (aim ' + a.aim[0] + '-' + a.aim[1] + 's)' : '') + ' | ' + (a.ended === 'timeout' ? 'TIME RAN OUT' : a.ended === 'next' ? 'pressed next' : a.ended));
    L.push('Q: ' + a.q);
    if (a.snippet) { L.push('Code shown:'); L.push(a.snippet); }
    if (a.typed != null) L.push('Typed answer: ' + (a.typed.trim() || '(nothing typed)'));
    if (a.code != null) {
      if (a.runs) L.push('Runs: ' + a.runs.length + (a.runs.length ? ' (' + a.runs.map(r => fmt(r.at) + ' ' + r.kind).join(', ') + ')' : '') + (a.changed ? '' : ' | code NOT changed from the starter'));
      L.push('--- final code ---');
      L.push(a.code.replace(/\s+$/, '') || '(empty)');
      if (a.runs && a.runs.length) { L.push('--- output of last run ---'); L.push(a.runs[a.runs.length - 1].out || '(no output)'); }
      L.push('--- end ---');
    }
    if (a.transcript) L.push('Auto-transcript: ' + a.transcript);
  });
  L.push('');
  L.push('=== MY VOICE TRANSCRIPT ===');
  L.push('(paste it here)');
  return L.join('\n');
}
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
  if (!ok) { const t = el('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0;top:0'; document.body.appendChild(t); t.select(); try { ok = document.execCommand('copy'); } catch (e) {} t.remove(); }
  const old = btn.textContent; btn.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(() => { btn.textContent = old; }, 1600);
}
function download(text, name) {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- page frame ---------- */
const TOTAL_LIMIT = CARDS.reduce((t, c) => t + c.limit, 0);
const app = $('#app');
app.innerHTML =
  '<header class="top">' +
    '<div class="who">' + esc(M.short) + '<span id="pos">Ready</span></div>' +
    '<div class="qt" id="qt"><small>This question</small><span id="qtv">-:--</span></div>' +
    '<div class="it" id="it"><span class="mic off" id="mic" hidden></span><div><small>Interview</small><span class="v"><span id="itv">0:00</span><i> / ' + M.minutes + ':00</i></span></div>' +
    '<button class="pbtn" id="pause" type="button" aria-label="Pause the interview" title="Pause (use only if you really must)" hidden>❚❚</button></div>' +
  '</header>' +
  '<div class="qbar" aria-hidden="true"><i class="zone" id="zone" hidden></i><i class="fill" id="fill"></i></div>' +
  '<main class="stage" id="stage"></main>' +
  '<div class="veil" id="veil" hidden><div><h2>Paused</h2><p>The clocks are stopped and the question is hidden.</p><button class="btn primary big" id="resume" type="button">Resume</button></div></div>' +
  '<div class="toast" id="toast" hidden>Time. Next question</div>';
const stage = $('#stage');

function card(cls, tagHtml, nText) {
  const c = el('section', 'card in ' + cls);
  const h = el('div', 'card-h', tagHtml + (nText ? '<span class="n">' + esc(nText) + '</span>' : ''));
  const b = el('div', 'card-b');
  const f = el('div', 'card-f');
  c.append(h, b, f);
  return { c, h, b, f };
}
function mount(c) { stage.replaceChildren(c.c); }
function tableHtml(t) {
  return '<div class="tbl-x"><table class="mini"><caption>Table: ' + esc(t.name) + '</caption><tr>' + t.cols.map(x => '<th>' + esc(x) + '</th>').join('') + '</tr>' +
    t.rows.map(r => '<tr>' + r.map(x => '<td>' + esc(x) + '</td>').join('') + '</tr>').join('') + '</table></div>';
}
function codeBlock(src, lang) { const p = el('pre', 'code'); p.innerHTML = '<code class="hljs">' + hl(src, lang || 'cpp') + '</code>'; return p; }

/* ---------- start ---------- */
function showStart() {
  const prev = store.get('session');
  const c = card('plain start', '<span class="tag">Mock interview</span><span class="tag alt">' + esc(M.flavour) + '</span>');
  const inner = el('div', 'inner');
  inner.innerHTML =
    '<div class="s-main">' +
      '<h1>' + esc(M.title) + '</h1>' +
      '<p class="sub">' + esc(M.sub) + '</p>' +
      '<div class="facts"><span class="chip"><b>' + CARDS.length + '</b> questions</span><span class="chip">about <b>' + M.minutes + '</b> min</span><span class="chip">hard stop <b>' + Math.ceil(TOTAL_LIMIT / 60) + '</b> min</span></div>' +
      '<div class="opts">' +
        '<label><input type="checkbox" id="o-voice"' + (prefs.voice ? ' checked' : '') + '><span><b>Read each question out loud</b>, like an interviewer would.</span></label>' +
        (SR ? '<label><input type="checkbox" id="o-stt"' + (prefs.stt ? ' checked' : '') + '><span><b>Also try an automatic transcript</b> (mic needed, rough). Keep your own recording as the real copy.</span></label>' : '') +
      '</div>' +
    '</div>' +
    '<ol class="rules">' +
      '<li><b>Start your own voice recorder now</b> and leave it running. Say the question number before each answer ("question five").</li>' +
      '<li><b>One question per screen.</b> The big clock is that question. At zero the next one appears by itself. Done early? Press <b>Next</b>. No going back.</li>' +
      '<li><b>Spoken questions:</b> just talk. The green band on the bar is the answer length to aim for.</li>' +
      '<li><b>Code questions:</b> type in the editor, press <b>Run</b> as often as you like, and talk while you type. Your code saves itself.</li>' +
      '<li><b>No marks are shown.</b> At the end you copy your answers and send them, with your transcript, to Claude for the review.</li>' +
    '</ol>';
  c.b.appendChild(inner);
  c.f.classList.add('go');
  c.f.innerHTML = '<span class="links">Best on a laptop. <a href="' + esc(M.other.href) + '">' + esc(M.other.label) + '</a> · <a href="./">Notes</a></span>' +
    '<span class="go-b">' + (prev && prev.answers && prev.answers.length ? '<button class="btn" id="prev" type="button">Copy answers from my last attempt</button>' : '') +
    '<button class="btn primary big" id="start" type="button">Start the interview →</button></span>';
  mount(c);
  $('#start').addEventListener('click', begin);
  const pb = $('#prev'); if (pb) pb.addEventListener('click', () => copyText(exportText(prev), pb));
}

function begin() {
  prefs.voice = $('#o-voice').checked;
  const s = $('#o-stt'); prefs.stt = !!(s && s.checked);
  store.set('prefs', prefs);
  stt.on = prefs.stt;
  const old = store.get('session'); if (old && old.answers && old.answers.length) store.set('previous', old);
  const d = new Date();
  state.startedAt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  state.running = true; state.total = 0; state.answers = [];
  $('#pause').hidden = false;
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {}); } catch (e) {}
  show(0);
}

/* ---------- question cards ---------- */
function aimChip(c) {
  if (c.type === 'talk') return '<span class="chip">🎤 Answer out loud</span><span class="chip aim">Aim for <b>' + c.aim[0] + '–' + c.aim[1] + '</b> seconds</span>';
  return '<span class="chip">Limit <b>' + fmt(c.limit) + '</b></span>' + (c.aimText ? '<span class="chip">' + esc(c.aimText) + '</span>' : '');
}
function show(i) {
  const c = CARDS[i];
  state.i = i; state.q = 0; state.locked = false;
  cur = { id: c.id, n: i + 1, sec: c.sec, type: c.type, q: plain(c.q), aim: c.aim || null, limit: c.limit, used: 0, ended: '' };
  collect = null;
  const tag = '<span class="tag">' + esc(c.sec) + '</span>' + (c.follow ? '<span class="tag alt">Follow-up</span>' : '');
  const nText = 'Question ' + (i + 1) + ' of ' + CARDS.length;
  let k, focusEl = null;

  if (c.type === 'talk') {
    let shown = c.code || '';
    if (c.showCodeOf) {
      const a = state.answers.find(x => x.id === c.showCodeOf);
      shown = a && a.code != null ? a.code.replace(/\s+$/, '') : '';
    }
    k = card('talk' + (shown ? ' has-code' : ''), tag, nText);
    const inner = el('div', 'inner');
    const left = el('div');
    left.innerHTML = '<div class="who-says">Interviewer</div><p class="q">' + c.q + '</p><div class="how">' + aimChip(c) + '</div>' + (c.fine ? '<p class="fine">' + c.fine + '</p>' : '');
    inner.appendChild(left);
    if (shown) { inner.appendChild(codeBlock(shown, c.lang)); if (c.code) cur.snippet = c.code; }
    k.b.appendChild(inner);
  } else {
    k = card('work', tag, nText);
    const left = el('div', 'left');
    left.innerHTML = '<div class="who-says">Interviewer</div><p class="q">' + c.q + '</p>' + (c.detail ? '<div class="detail">' + c.detail + '</div>' : '') + (c.table ? tableHtml(c.table) : '') + '<div class="how">' + aimChip(c) + '</div>' + (c.fine ? '<p class="fine">' + c.fine + '</p>' : '');
    if (c.table) cur.snippet = 'Table ' + c.table.name + '(' + c.table.cols.join(', ') + ')';
    const right = el('div', 'right');
    if (c.type === 'predict') {
      cur.snippet = c.code; cur.typed = '';
      right.appendChild(codeBlock(c.code, 'cpp'));
      const lab = el('label', 'ans-l', 'Type exactly what it prints'); lab.htmlFor = 'ans';
      const inp = el('input', 'ans'); inp.id = 'ans'; inp.type = 'text'; inp.spellcheck = false;
      ['autocapitalize', 'autocomplete', 'autocorrect'].forEach(a => inp.setAttribute(a, 'off'));
      inp.addEventListener('input', () => { cur.typed = inp.value; saveSoon(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') e.stopPropagation(); });
      right.append(lab, inp);
      collect = () => { cur.typed = inp.value; };
      focusEl = inp;
    } else {
      const starter = c.starter || '';
      const runnable = c.type !== 'sql';
      cur.code = starter; cur.changed = false;
      if (runnable) cur.runs = [];
      const savedNote = el('span', 'saved', 'Saved automatically');
      const ed = makeEditor(starter, c.type === 'sql' ? 'sql' : 'cpp', runnable ? () => run() : null, v => { cur.code = v; cur.changed = v !== starter; saveSoon(); });
      if (c.type === 'sql') { ed.wrap.classList.add('short'); ed.ta.placeholder = '-- type your query here'; }
      right.appendChild(ed.wrap);
      const bar = el('div', 'toolbar');
      let runBtn = null;
      const out = el('div', 'out'); out.setAttribute('aria-live', 'polite');
      if (runnable) {
        runBtn = el('button', 'btn primary', '▶ Run'); runBtn.type = 'button';
        runBtn.addEventListener('click', () => run());
        bar.append(runBtn, el('span', 'fine', 'Ctrl+Enter also runs'));
        bar.lastChild.style.margin = '0';
        out.innerHTML = '<div class="out-head"><span>Output</span></div><pre class="dim">Press Run to compile and run your code.</pre>';
      }
      bar.appendChild(savedNote);
      right.appendChild(bar);
      if (runnable) right.appendChild(out);
      collect = () => { cur.code = ed.get(); cur.changed = cur.code !== starter; };
      focusEl = ed.ta;
      let busy = false;
      const mine = cur;
      async function run() {
        if (busy || state.paused) return; busy = true;
        runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span>Running';
        const at = state.q; const source = ed.get();
        out.innerHTML = '<div class="out-head"><span>Compiling…</span></div><pre class="dim">Sending your code to the compiler…</pre>';
        let kind, text;
        try {
          const res = await compileRun(source);
          if (!res.ok) { kind = 'compile error'; text = tidy(res.errors); }
          else {
            const crashed = res.exit !== 0 && res.exit != null;
            kind = crashed ? 'crashed' : 'ran';
            text = (res.stdout || '') + ((res.stderr || '').trim() ? '\n' + res.stderr.trim() : '') + (crashed ? '\nExit code ' + res.exit : '');
          }
        } catch (e) { kind = 'no compiler'; text = ''; }
        mine.runs.push({ at, kind, out: text.length > 1500 ? text.slice(0, 1500) + '\n…(cut)' : text });
        saveSoon();
        if (mine === cur) {
          if (kind === 'no compiler') out.innerHTML = '<div class="out-head warn"><span>Couldn\'t reach the compiler</span></div><pre>Check your internet and press Run again. Your code is still saved.</pre>';
          else out.innerHTML = '<div class="out-head' + (kind === 'ran' ? '' : ' err') + '"><span>' + (kind === 'ran' ? 'Output' : kind === 'crashed' ? 'Program stopped with an error' : 'Compile error') + '</span><span>gcc 13.2</span></div><pre>' + (text ? esc(text) : '<span class="dim">(no output)</span>') + '</pre>';
          runBtn.disabled = false; runBtn.innerHTML = '▶ Run';
        }
        busy = false;
      }
    }
    k.b.append(left, right);
  }

  const hint = el('span', 'hint', c.type === 'talk' ? 'No going back. Enter or → also moves on.' : 'No going back. The clock moves you on at zero.');
  const next = el('button', 'btn primary', i === CARDS.length - 1 ? 'Finish the interview' : c.type === 'talk' ? 'Done · next question →' : 'Submit · next question →');
  next.type = 'button'; next.id = 'next';
  next.addEventListener('click', () => advance('next'));
  k.f.append(hint, next);

  $('#pos').textContent = 'Q ' + (i + 1) + ' / ' + CARDS.length;
  const zone = $('#zone');
  if (c.aim) { zone.hidden = false; zone.style.left = (c.aim[0] / c.limit * 100) + '%'; zone.style.width = ((c.aim[1] - c.aim[0]) / c.limit * 100) + '%'; }
  else zone.hidden = true;
  mount(k);
  paint();
  if (focusEl && matchMedia('(min-width:861px)').matches) { try { focusEl.focus({ preventScroll: true }); } catch (e) {} }
  else { try { next.blur(); document.activeElement && document.activeElement.blur(); } catch (e) {} }
  speak(c.say || plain(c.q));
  if (stt.on) { if (stt.rec) sttCut(); else sttStart(); }
  save(false);
}

function advance(reason) {
  if (!state.running || state.locked) return;
  if (reason === 'next' && state.q < 1.2) return;            // guards against a double press
  const c = CARDS[state.i];
  if (collect) collect();
  cur.used = Math.min(state.q, c.limit); cur.ended = reason;
  state.answers.push(cur);
  hush();
  const go = () => {
    $('#toast').hidden = true;
    if (state.i + 1 < CARDS.length) show(state.i + 1); else finish();
  };
  if (reason === 'timeout') { state.locked = true; $('#toast').hidden = false; setTimeout(go, 1100); }
  else go();
}

/* ---------- finish ---------- */
function finish() {
  state.running = false; cur = null; collect = null;
  sttCut(); hush();
  save(true);
  try { if (wake) wake.release(); } catch (e) {}
  $('#pause').hidden = true;
  $('#pos').textContent = 'Finished';
  $('#qtv').textContent = '-:--'; $('#qt').classList.remove('low');
  $('#zone').hidden = true; $('#fill').style.width = '0';
  const s = snapshot(true);
  const text = exportText(s);
  const c = card('plain fin', '<span class="tag">End of interview</span><span class="tag alt">' + esc(M.short) + '</span>');
  const inner = el('div', 'inner');
  inner.innerHTML =
    '<h1>That\'s the interview</h1>' +
    '<p class="sub">You were in the room for ' + fmt(state.total) + '. Nothing is marked here; the review comes when you send your answers in.</p>' +
    '<ol class="rules">' +
      '<li><b>Stop your voice recorder</b> and turn the recording into text.</li>' +
      '<li><b>Copy your answers</b> with the button below. That has your code, your typed answers, every Run, and how long you took on each question.</li>' +
      '<li><b>Paste both to Claude</b>: the copied answers first, then the transcript under it.</li>' +
    '</ol>' +
    '<div class="acts"><button class="btn primary big" id="copy" type="button">Copy my answers</button><button class="btn" id="dl" type="button">Download as a file</button>' +
    '<span class="links"><a href="' + esc(M.other.href) + '">' + esc(M.other.label) + '</a> · <a href="' + location.pathname.split('/').pop() + '">Do this one again</a> · <a href="./">Notes</a></span></div>';
  const pv = codeBlock(text, 'txt'); pv.classList.add('preview'); pv.firstChild.textContent = text;
  inner.appendChild(pv);
  c.b.appendChild(inner); c.f.remove();
  mount(c);
  $('#copy').addEventListener('click', e => copyText(text, e.currentTarget));
  $('#dl').addEventListener('click', () => download(text, M.id + '-answers.txt'));
}

/* ---------- clocks ---------- */
function paint() {
  const c = CARDS[state.i]; if (!c) return;
  const left = Math.max(0, c.limit - state.q);
  $('#qtv').textContent = fmt(Math.ceil(left));
  $('#qt').classList.toggle('low', left <= (c.type === 'talk' ? 10 : 30));
  $('#fill').style.width = Math.min(100, state.q / c.limit * 100) + '%';
  if (c.aim) $('#zone').classList.toggle('in', state.q >= c.aim[0] && state.q <= c.aim[1]);
  $('#itv').textContent = fmt(Math.floor(state.total));
  $('#it').classList.toggle('over', state.total > M.minutes * 60);
}
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now(); const dt = (now - lastTick) / 1000 * SPEED; lastTick = now;
  if (!state.running || state.paused || state.locked) return;
  state.q += dt; state.total += dt;
  paint();
  if (state.q >= CARDS[state.i].limit) advance('timeout');
}, 200);

function setPaused(p) {
  if (!state.running || state.paused === p) return;
  state.paused = p;
  if (p) { state.pauses++; hush(); sttCut(); }
  else if (stt.on) sttStart();
  $('#veil').hidden = !p;
  stage.style.visibility = p ? 'hidden' : '';
  if (p) $('#resume').focus();
}
$('#pause').addEventListener('click', () => setPaused(true));
$('#resume').addEventListener('click', () => setPaused(false));

document.addEventListener('keydown', e => {
  if (!state.running || state.paused || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'A')) return;
  if (CARDS[state.i].type !== 'talk') return;
  if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); advance('next'); }
});
addEventListener('beforeunload', e => { if (state.running) { save(false); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && navigator.wakeLock) { try { navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {}); } catch (e) {} }
});

showStart();
})();
