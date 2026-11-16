(function () {
  'use strict';
  var E = window.Engine, MIN = E.MIN, DAY = E.DAY, HOUR = E.HOUR, fmtP = E.fmtP, fmtN = E.fmtN, hhmm = E.hhmm;
  function $(id) { return document.getElementById(id); }
  var INST = { NQ: 20, MNQ: 2 }, SERVER = 'traderos', CFG_KEY = 'tutor-entradas-cfg-v1';
  var st = { ticker: 'NQ', D: null, source: 'demo', all: [], day: null, an: null, cfg: Object.assign({}, E.DEF),
             timer: null, tick: null, mode: 'c', rate: 3, visN: 90, pan: 0, sel: null, practice: false, ans: {}, pend: null, ind: { vwap: true, vol: true, rsi: true, macd: true, wr: true, vp: true, marks: true }, I: null,
             hover: null, hits: [], hist: [], h5: [], mt: [], mIdx: -1, ldrag: null, path: null, pk: 0, pj: -1, tickChecked: -1, cache: {}, loadSeq: 0, csv: null };

  try { var saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); if (saved) { Object.assign(st.cfg, saved.cfg || {}); st.practice = !!saved.practice; if (INST[saved.ticker]) st.ticker = saved.ticker; if (saved.ind) Object.assign(st.ind, saved.ind); } } catch (e) {}
  function save() { try { localStorage.setItem(CFG_KEY, JSON.stringify({ cfg: st.cfg, practice: st.practice, ticker: st.ticker, ind: st.ind })); } catch (e) {} }

  /* ---------- tiempo: todo se maneja en hora de Nueva York ---------- */
  var nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var offCache = {};
  function nyWall(ms) {
    var k = Math.floor(ms / (6 * HOUR));
    if (offCache[k] == null) {
      var o = {}; nyFmt.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = +p.value; });
      offCache[k] = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute) - Math.floor(ms / MIN) * MIN;
    }
    return ms + offCache[k];
  }
  function iso(D) { return new Date(D).toISOString().slice(0, 10); }
  function fecha(D) { return new Date(D).toLocaleDateString('es', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }); }
  function prevWeekday(D) { var d = D - DAY; while ([0, 6].indexOf(new Date(d).getUTCDay()) >= 0) d -= DAY; return d; }
  function lastSession() {
    var w = nyWall(Date.now()), d = Math.floor(w / DAY) * DAY, wd = new Date(d).getUTCDay();
    return (wd === 0 || wd === 6 || (w - d) / MIN < 960) ? prevWeekday(d) : d;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- carga de datos ---------- */
  function setStatus(kind, text, retry) {
    var el = $('status'); el.className = 'status' + (kind ? ' on ' + kind : '');
    $('statusText').textContent = text || ''; $('retry').hidden = !retry;
  }
  function setChip() {
    var c = $('srcChip');
    if (st.source === 'traderos') { c.className = 'chip real'; c.textContent = st.ticker + ' · TraderOS · 1 min'; }
    else if (st.source === 'site') { c.className = 'chip real'; c.textContent = st.ticker + ' · Yahoo · 1 min'; c.title = st.siteUpd ? 'Datos de Yahoo Finance. Última actualización: ' + new Date(st.siteUpd).toLocaleString('es') : ''; }
    else if (st.source === 'csv') { c.className = 'chip real'; c.textContent = 'CSV importado · 1 min'; }
    else { c.className = 'chip demo'; c.textContent = 'Ejemplo simulado'; }
  }
  function toBars(rows) {
    var out = [], seen = {};
    rows.forEach(function (r) {
      var ms = Date.parse(r.timestamp || r.time || r.t); if (isNaN(ms)) return;
      var t = nyWall(ms); if (seen[t]) return; seen[t] = 1;
      out.push({ t: t, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 });
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }
  function getMcp() {
    if (!window.claude || typeof window.claude.use !== 'function') return Promise.resolve(null);
    return window.claude.use('mcp').catch(function () { return null; });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function fetchRows(mcp, ticker, a, b, fresh, tfName) {
    var rows = [], cursor = 0, retried = false;
    var opt = { cache: fresh ? { staleTime: 120000, gcTime: 600000 } : { staleTime: 6048e5, gcTime: 6048e5 } };
    for (var page = 0; page < 40; page++) {
      var res;
      try { res = await mcp.callTool(SERVER, 'get_ohlcv', { ticker: ticker, market: 'futures', timeframe: tfName || '1m', start_date: a, end_date: b, cursor: cursor }, opt); }
      catch (err) {
        if (err && err.retryable && !retried) { retried = true; await sleep(Math.min(err.retryAfterMs || 1500, 8000) + Math.random() * 600); page--; continue; }
        throw err;
      }
      var p = res && res.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { throw { code: 'tool_error', message: p.slice(0, 200) }; } }
      if (p && p.result && !p.rows) p = p.result;
      var r = (p && (p.rows || p.data)) || [];
      rows = rows.concat(r);
      if (!p || p.next_cursor == null || !r.length) break;
      cursor = p.next_cursor;
    }
    return rows;
  }
  function errText(err) {
    var code = err && err.code, tail = ' Mientras tanto se muestra el ejemplo simulado.';
    if (st.source !== 'demo') tail = '';
    switch (code) {
      case 'no_mcp': return 'Esta vista no puede usar tus conectores. Abre la página dentro de claude.ai o importa un CSV en Reglas y datos.' + tail;
      case 'needs_reauth': return 'TraderOS necesita reconectarse: en claude.ai ve a Ajustes → Conectores y vuelve a conectar TraderOS.' + tail;
      case 'server_not_connected': case 'server_not_found': case 'selection_required':
        return 'No encuentro un conector llamado "' + SERVER + '" en tu cuenta. Revisa en claude.ai, Ajustes → Conectores, que TraderOS esté conectado.' + tail;
      case 'not_in_manifest': case 'consent_required': case 'approval_required': case 'not_granted':
        return 'Esta página no tiene permiso para leer de TraderOS. Pulsa el botón y acepta el permiso cuando aparezca.' + tail;
      case 'blocked_by_policy': return 'La política de tu organización bloquea TraderOS en esta página.' + tail;
      case 'server_unavailable': case 'rate_limited': return 'TraderOS no respondió. Inténtalo de nuevo en un momento.' + tail;
      case 'tool_error': return 'TraderOS devolvió un error: ' + String(err.message || '').slice(0, 220) + tail;
      case 'capability_disabled': case 'capability_removed': return 'Los conectores no están disponibles en esta vista. Importa un CSV en Reglas y datos.' + tail;
      default: return 'No se pudieron cargar los datos de TraderOS (' + (code || 'error desconocido') + ').' + tail;
    }
  }
  async function loadReal(keepIdx) {
    var seq = ++st.loadSeq, D = st.D, tk = st.ticker, key = tk + '|' + iso(D) + '|' + st.cfg.pdMode;
    stop();
    var idx = await siteIndex(); if (seq !== st.loadSeq) return;
    if (idx && idx.symbols) { loadSite(seq, idx, keepIdx); return; }      /* sitio propio con datos de Yahoo */
    setStatus('load', 'Cargando ' + tk + ' del ' + fecha(D) + ' desde TraderOS, velas de 1 minuto…');
    try {
      var P = prevWeekday(D), a = st.cfg.pdMode === 'full' ? P - DAY : P;
      var bars = st.cache[key];
      if (!bars) {
        var mcp = await getMcp(); if (!mcp) throw { code: 'no_mcp' };
        bars = toBars(await fetchRows(mcp, tk, iso(a), iso(D), D >= lastSession()));
        if (bars.length && !E.prepareDay(bars, D, st.cfg).prior) {
          var more = toBars(await fetchRows(mcp, tk, iso(a - 4 * DAY), iso(a - DAY), false));
          bars = more.concat(bars);
        }
        st.cache[key] = bars;
      }
      if (seq !== st.loadSeq) return;
      if (E.prepareDay(bars, D, st.cfg).bars.length < 60) {
        setStatus('warn', 'TraderOS no tiene velas de ' + tk + ' para el ' + fecha(D) + '. Puede ser fin de semana o feriado: elige otra fecha.', false); return;
      }
      st.all = bars; st.h5 = st.cache[tk + '|' + iso(D) + '|' + iso(a) + '|h5'] || []; st.source = 'traderos'; st.ans = {}; setStatus(null); setChip(); openDay(925, keepIdx);
      loadHist(seq, D, tk, a);
    } catch (err) {
      if (seq !== st.loadSeq) return;
      setStatus('err', errText(err), true);
    }
  }
  /* Datos propios del sitio: data/index.json y data/<SÍMBOLO>/<fecha>.csv, que una tarea programada llena desde Yahoo Finance. */
  var site = null;
  async function siteIndex() {
    if (site !== null) return site;
    try { var r = await fetch('data/index.json', { cache: 'no-store' }); site = r.ok ? await r.json() : false; } catch (e) { site = false; }
    return site;
  }
  async function loadSite(seq, idx, keepIdx) {
    var tk = st.ticker, info = idx.symbols[tk] || {}, sessions = (info.sessions || []).slice().sort(), files = (info.files || []).slice().sort();
    if (!sessions.length) { setStatus('warn', 'Este sitio todavía no tiene sesiones de ' + tk + '. La tarea de actualización las agrega desde Yahoo Finance.', true); return; }
    var want = iso(st.D), pick = sessions[0], i;
    for (i = sessions.length - 1; i >= 0; i--) if (sessions[i] <= want) { pick = sessions[i]; break; }
    var use = files.filter(function (d) { return d <= pick; }).slice(-9), key = tk + '|site|' + pick;
    setStatus('load', 'Cargando ' + tk + ' del ' + pick + '…');
    try {
      var bars = st.cache[key];
      if (!bars) {
        var parts = await Promise.all(use.map(function (d) {
          return fetch('data/' + tk + '/' + d + '.csv', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw { code: 'archivo ' + d + ' ' + r.status }; return r.text(); });
        }));
        bars = []; var seen = {};
        parts.forEach(function (txt) {
          txt.split(/\r?\n/).forEach(function (ln) {
            var f = ln.split(','), ms = +f[0] * 1000; if (!ms || f.length < 5) return;
            var t = nyWall(ms); if (seen[t]) return; seen[t] = 1;
            bars.push({ t: t, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] || 0 });
          });
        });
        bars.sort(function (a, b) { return a.t - b.t; }); st.cache[key] = bars;
      }
      if (seq !== st.loadSeq) return;
      var p = pick.split('-'); st.D = Date.UTC(+p[0], +p[1] - 1, +p[2]);
      $('date').min = sessions[0]; $('date').max = sessions[sessions.length - 1]; $('date').value = pick;
      if (E.prepareDay(bars, st.D, st.cfg).bars.length < 60) { setStatus('warn', 'No hay velas suficientes de ' + tk + ' para el ' + fecha(st.D) + '. Elige otra fecha.', false); return; }
      st.all = bars; st.h5 = []; st.source = 'site'; st.siteUpd = idx.updated; st.ans = {};
      setStatus(pick !== want && keepIdx == null && st.asked ? 'warn' : null, pick !== want && st.asked ? 'No hay sesión guardada para esa fecha; se abrió la más cercana anterior, ' + fecha(st.D) + '.' : '', false);
      setChip(); openDay(925, keepIdx);
    } catch (err) {
      if (seq !== st.loadSeq) return;
      setStatus('err', 'No se pudieron leer los datos del sitio (' + ((err && err.code) || 'error de red') + ').', true);
    }
  }
  /* Días previos para el gráfico: velas de 5 minutos, que alcanzan para 5, 15, 60 y 240 minutos. */
  async function loadHist(seq, D, tk, a) {
    var key = tk + '|' + iso(D) + '|' + iso(a) + '|h5';
    try {
      var h = st.cache[key];
      if (!h) {
        var mcp = await getMcp(); if (!mcp) return;
        h = toBars(await fetchRows(mcp, tk, iso(D - 9 * DAY), iso(a - DAY), false, '5m')); st.cache[key] = h;
      }
      if (seq !== st.loadSeq || st.source !== 'traderos') return;
      st.h5 = h; st.hist = buildHist(); st.I = null; render();
    } catch (err) {
      if (seq === st.loadSeq) setStatus('warn', 'La sesión cargó, pero no el historial de los días previos (' + ((err && err.code) || 'error') + '). El gráfico muestra solo la sesión y el día anterior.', false);
    }
  }
  function sessOf(t) { return Math.floor((t + 6 * HOUR) / DAY) * DAY - 6 * HOUR; }
  function buildHist() {
    var tf = st.cfg.tf, tfMs = tf * MIN, s0 = st.day.sessStart, src = [], i, b;
    var first1m = st.all.length ? st.all[0].t : s0;
    if (tf >= 5) for (i = 0; i < st.h5.length; i++) { b = st.h5[i]; if (b.t < first1m) src.push(b); }
    for (i = 0; i < st.all.length; i++) { b = st.all[i]; if (b.t >= s0) break; src.push(b); }
    var out = [], cur = null;
    for (i = 0; i < src.length; i++) {
      b = src[i]; var s = sessOf(b.t), key = s + Math.floor((b.t - s) / tfMs) * tfMs;
      if (!cur || cur.t !== key) { cur = { bk: -1, t: key, rel: Math.round((key - s) / MIN), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; out.push(cur); }
      else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.v += b.v || 0; }
    }
    return out.length > 3000 ? out.slice(out.length - 3000) : out;
  }
  function loadDemo() { st.all = E.synth(st.D, 20261113); st.h5 = []; st.source = 'demo'; setChip(); openDay(950); }

  function parseCsv(text, tz) {
    var out = [], lines = text.split(/\r?\n/);
    function fromLocal(w) { return tz === 'ny' ? w : nyWall(tz === 'pa' ? w + 5 * HOUR : w); }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim(); if (!ln) continue;
      var m = ln.match(/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2});/), f, t;
      if (m) { f = ln.split(';'); t = fromLocal(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - MIN); }   /* NinjaTrader marca el cierre de la vela */
      else {
        f = ln.split(/[,;\t]/); var s = f[0].replace(/"/g, '').trim();
        var g = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/); if (!g) continue;
        if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) { var ms = Date.parse(s.replace(' ', 'T')); if (isNaN(ms)) continue; t = nyWall(ms); }
        else t = fromLocal(Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5]));
      }
      var o = +f[1], h = +f[2], l = +f[3], c = +f[4];
      if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
      out.push({ t: t, o: o, h: h, l: l, c: c, v: +f[5] || 0 });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  function importCsv(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var bars = parseCsv(String(rd.result), $('csvTz').value);
      var ones = 0; for (var i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t === MIN) ones++;
      if (bars.length < 300 || ones < bars.length * 0.6) { setStatus('err', 'No pude leer velas de 1 minuto en ese archivo. Revisa que tenga fecha y hora, apertura, máximo, mínimo y cierre, una vela por minuto.', false); return; }
      var D = null;
      for (i = bars.length - 1; i >= 0; i--) { var d = Math.floor(bars[i].t / DAY) * DAY, mm = (bars[i].t - d) / MIN; if (mm >= 570 && mm < 960) { D = d; break; } }
      if (D == null) { setStatus('err', 'El archivo no tiene velas entre las 09:30 y las 16:00 de Nueva York. Revisa la hora del archivo.', false); return; }
      ++st.loadSeq; st.all = bars; st.h5 = []; st.csv = bars; st.source = 'csv'; st.D = D; $('date').value = iso(D); st.ans = {};
      setStatus(null); setChip(); openDay(925);
    };
    rd.readAsText(file);
  }

  /* ---------- reproducción ---------- */
  function openDay(startRel, keepIdx) {
    st.day = E.prepareDay(st.all, st.D, st.cfg);
    if (!st.day.bars.length) { setStatus('warn', 'No hay velas para el ' + fecha(st.D) + ' en estos datos. Elige otra fecha.', false); return; }
    st.hist = buildHist();
    if (!keepIdx) { st.mt = []; msg(''); }
    var n = keepIdx || 0;
    if (!n) { n = st.day.bars.length; for (var i = 0; i < st.day.bars.length; i++) if ((st.day.bars[i].t - st.day.sessStart) / MIN >= startRel) { n = i + 1; break; } }
    $('scrub').max = st.day.bars.length; st.pan = 0; st.sel = null;
    rebuild(Math.min(n, st.day.bars.length));
  }
  function rebuild(n) {
    st.an = E.create(st.day, st.cfg);
    for (var i = 0; i < n; i++) st.an.step();
    st.pend = null; st.I = null; st.tickChecked = -1; render();
  }
  function inWin(e) { var rel = (e.t - st.day.sessStart) / MIN, w = st.an.win; return rel >= w[0] && rel < w[1] && !(rel >= 930 && rel < 930 + st.an.cfg.orbMin); }
  function quizzable(e) { return e.setup != null || (e.type === 'BRK' && inWin(e)); }
  function correct(e) { return e.setup != null ? (st.an.S.setups[e.setup].dir > 0 ? 'buy' : 'sell') : 'wait'; }
  function stepFwd(silent) {
    if (st.pend != null) { st.ans[st.pend] = 'none'; st.pend = null; }
    var S = st.an.S, n0 = S.events.length;
    if (!st.an.step()) { stop(); return false; }
    st.I = null;
    if (st.practice) for (var j = n0; j < S.events.length; j++) if (quizzable(S.events[j]) && st.ans[S.events[j].id] == null) { st.pend = S.events[j].id; st.sel = null; stop(); break; }
    if (S.events.length > n0) st.sel = null;
    if (!silent) render();
    return true;
  }
  function stepBack() { stop(); var n = st.an.S.i; if (n >= 1) rebuild(n); }
  function nextEvent() {
    stop(); var S = st.an.S, n0 = S.events.length, guard = 0;
    while (S.events.length === n0 && guard++ < 2000) if (!stepFwd(true)) break;
    render();
  }
  function prevEvent() {
    stop(); var S = st.an.S, t = -1;
    for (var j = S.events.length - 1; j >= 0; j--) if (S.events[j].i < S.i) { t = S.events[j].i; break; }
    if (t >= 0) rebuild(t + 1);
  }
  /* Ticks simulados: recorrido apertura → extremo → extremo → cierre dentro de la vela de 1 minuto.
     El orden real de los ticks no se conoce; en vela alcista se asume primero el mínimo, en bajista primero el máximo. */
  function tickPath(b, N) {
    var up = b.c >= b.o, pts = up ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    var d = [Math.abs(pts[1] - pts[0]), Math.abs(pts[2] - pts[1]), Math.abs(pts[3] - pts[2])], tot = d[0] + d[1] + d[2];
    var out = [], hi = b.o, lo = b.o, prev = b.o, sPrev = 0;
    for (var k = 1; k <= N; k++) {
      var s = tot * k / N, p;
      if (!tot) p = b.c;
      else if (s <= d[0]) p = pts[0] + (pts[1] - pts[0]) * s / d[0];
      else if (s <= d[0] + d[1]) p = pts[1] + (pts[2] - pts[1]) * (s - d[0]) / d[1];
      else p = pts[2] + (pts[3] - pts[2]) * (d[2] ? (s - d[0] - d[1]) / d[2] : 1);
      p = k === N ? b.c : Math.round(p * 4) / 4;
      var sl = Math.min(prev, p), sh = Math.max(prev, p);          /* tramo recorrido en este tick, con los extremos que cruzó */
      if (tot && sPrev < d[0] && s >= d[0]) { sl = Math.min(sl, pts[1]); sh = Math.max(sh, pts[1]); }
      if (tot && sPrev < d[0] + d[1] && s >= d[0] + d[1]) { sl = Math.min(sl, pts[2]); sh = Math.max(sh, pts[2]); }
      hi = Math.max(hi, sh); lo = Math.min(lo, sl);
      out.push({ t: b.t, o: b.o, h: hi, l: lo, c: p, v: (b.v || 0) * k / N, sl: sl, sh: sh });
      prev = p; sPrev = s;
    }
    return out;
  }

  /* ---------- mis operaciones (manuales) ---------- */
  var REASON = { stop: 'stop', objetivo: 'objetivo', manual: 'cierre manual' };
  function openPos() { for (var i = 0; i < st.mt.length; i++) if (st.mt[i].status === 'open') return st.mt[i]; return null; }
  function curPrice() { return st.tick ? st.tick.c : st.an.S.bar.c; }
  function sgn(v) { return (v < 0 ? '−' : '+') + fmtN(Math.abs(v)); }
  function money(v) { return (v < 0 ? '−' : '+') + '$' + fmtN(Math.abs(v)); }
  function msg(t) { $('m_msg').textContent = t || ''; }
  function tutorNote(dir) {
    var S = st.an.S, lim = S.i - 3 * st.an.cfg.tf, best = null;
    for (var j = S.events.length - 1; j >= 0; j--) {
      var e = S.events[j]; if (e.i < lim) break;
      if (e.id !== st.pend && e.dir && /^(FALSO|RECH|RET|FVGT|IFVGR)$/.test(e.type)) { best = e; break; }
    }
    if (!best) return 'Sin señal del tutor en las últimas 3 velas: entrada por tu propio criterio.';
    return (best.dir === dir ? 'A favor de' : 'En contra de') + ' la última señal del tutor: ' + best.title + ' (' + hhmm(best.t) + ', ' + (best.dir > 0 ? 'compra' : 'venta') + ').';
  }
  function openManual(dir) {
    if (!st.an || st.an.S.i < 0) return;
    if (openPos()) { msg('Ya tienes una operación abierta. Ciérrala antes de abrir otra.'); return; }
    var S = st.an.S, px = curPrice(), qty = Math.max(1, Math.min(50, Math.round(+$('m_qty').value || 1)));
    var sl = Math.max(0, +$('m_sl').value || 0), tp = Math.max(0, +$('m_tp').value || 0), id = 1;
    st.mt.forEach(function (t) { if (t.id >= id) id = t.id + 1; });
    st.mt.push({ id: id, dir: dir, qty: qty, entry: px, i: st.tick ? S.i + 1 : S.i, t: simNow(), stop: sl ? px - dir * sl : null, target: tp ? px + dir * tp : null,
                 risk: sl || null, status: 'open', note: tutorNote(dir) });
    msg(''); render();
  }
  function closeManual(tr, price, reason, iExit, tExit) {
    tr.status = 'closed'; tr.exit = price; tr.reason = reason; tr.iExit = iExit; tr.tExit = tExit; tr.pts = (price - tr.entry) * tr.dir;
  }
  function hitCheck(tr, lo, hi, j, t) {
    if (tr.dir > 0) { if (tr.stop != null && lo <= tr.stop) closeManual(tr, tr.stop, 'stop', j, t); else if (tr.target != null && hi >= tr.target) closeManual(tr, tr.target, 'objetivo', j, t); }
    else { if (tr.stop != null && hi >= tr.stop) closeManual(tr, tr.stop, 'stop', j, t); else if (tr.target != null && lo <= tr.target) closeManual(tr, tr.target, 'objetivo', j, t); }
  }
  function manualSeg(tk, j) { st.mt.forEach(function (tr) { if (tr.status === 'open' && tr.i <= j) hitCheck(tr, tk.sl, tk.sh, j, tk.t); }); }
  function evalBar(j) { var b = st.day.bars[j]; st.mt.forEach(function (tr) { if (tr.status === 'open' && tr.i < j) hitCheck(tr, b.l, b.h, j, b.t); }); }
  /* Mantiene mis operaciones alineadas con el punto de la sesión: al retroceder se deshacen, al avanzar se evalúan vela por vela. */
  function syncManual() {
    var target = st.an.S.i, j;
    if (target < st.mIdx) {
      st.mt = st.mt.filter(function (tr) { return tr.i <= target; });
      st.mt.forEach(function (tr) { if (tr.status === 'closed' && tr.iExit > target) { tr.status = 'open'; tr.exit = tr.reason = tr.iExit = tr.tExit = tr.pts = null; } });
    } else for (j = st.mIdx + 1; j <= target; j++) if (j !== st.tickChecked) evalBar(j);
    st.mIdx = target;
  }
  /* Cálculo de contratos según la pérdida máxima y la ganancia buscada. */
  function sizing() {
    var pt = INST[st.ticker] || 20, sl = Math.max(0, +$('m_sl').value || 0), tp = Math.max(0, +$('m_tp').value || 0);
    var loss = Math.max(0, +$('m_loss').value || 0), gain = Math.max(0, +$('m_gain').value || 0);
    return { pt: pt, sl: sl, tp: tp, loss: loss, gain: gain,
             byLoss: loss && sl ? Math.floor(loss / (sl * pt)) : null, byGain: gain && tp ? Math.ceil(gain / (tp * pt)) : null };
  }
  function applySizing() {
    var z = sizing(), q = z.byLoss != null ? z.byLoss : z.byGain;
    if (q != null && q >= 1) $('m_qty').value = Math.min(50, q);
    renderCalc();
  }
  function renderCalc() {
    var pos = st.an && st.an.S.i >= 0 ? openPos() : null, pt = INST[st.ticker] || 20, tk = st.ticker, h = [];
    function cs(n) { return n + (n === 1 ? ' contrato' : ' contratos'); }
    if (pos) {
      h.push(pos.stop != null ? 'Si toca el stop: ' + money((pos.stop - pos.entry) * pos.dir * pt * pos.qty) + '.' : 'Sin stop: la pérdida no está limitada.');
      if (pos.target != null) h.push('Si llega al objetivo: ' + money((pos.target - pos.entry) * pos.dir * pt * pos.qty) + '.');
      h.push('Arrastra las líneas SL y TP en el gráfico para moverlas' + (pos.stop == null || pos.target == null ? '; si falta alguna, arrastra desde la línea de entrada para crearla.' : '.'));
    } else {
      var z = sizing(), q = Math.max(1, Math.min(50, Math.round(+$('m_qty').value || 1)));
      h.push('Con ' + cs(q) + ' de ' + tk + ': ' + (z.sl ? 'pierdes $' + fmtN(z.sl * pt * q) + ' en el stop' : 'sin stop, la pérdida no está limitada') +
        (z.tp ? ' y ganas $' + fmtN(z.tp * pt * q) + ' en el objetivo' : '') + (z.sl && z.tp ? ' (relación 1:' + fmtN(z.tp / z.sl) + ')' : '') + '.');
      if (z.byLoss != null) {
        if (z.byLoss >= 1) h.push('Para no perder más de $' + fmtN(z.loss) + ' caben ' + cs(z.byLoss) + (z.byLoss > 50 ? ' (el simulador admite hasta 50)' : '') + '.');
        else h.push('Con pérdida máxima de $' + fmtN(z.loss) + ' no cabe ni un contrato de ' + tk + ': uno solo arriesga $' + fmtN(z.sl * pt) + ' con este stop.' +
          (tk === 'NQ' && Math.floor(z.loss / (z.sl * 2)) >= 1 ? ' En MNQ cabrían ' + Math.floor(z.loss / (z.sl * 2)) + '.' : '') + ' Acerca el stop o sube el límite.');
      }
      if (z.byGain != null) h.push('Para ganar $' + fmtN(z.gain) + ' en el objetivo hacen falta ' + cs(z.byGain) + (z.sl ? ', que arriesgan $' + fmtN(z.byGain * z.sl * pt) + ' en el stop' : '') + '.' +
        (z.byLoss != null && z.byGain > z.byLoss ? ' Eso supera tu pérdida máxima, así que manda el límite de pérdida.' : ''));
    }
    $('m_calc').textContent = h.join(' ');
  }
  function renderTrade() {
    if (!st.an || st.an.S.i < 0) return;
    var pt = INST[st.ticker] || 20, pos = openPos(), px = curPrice();
    $('m_new').hidden = !!pos; $('m_open').hidden = !pos;
    if (pos) {
      var fl = (px - pos.entry) * pos.dir;
      $('m_sum').innerHTML = '<b>' + (pos.dir > 0 ? 'Compra' : 'Venta') + ' ' + pos.qty + ' ' + esc(st.ticker) + '</b> en ' + fmtP(pos.entry) +
        ' · <span class="' + (fl >= 0 ? 'pos' : 'neg') + '">' + sgn(fl) + ' pts · ' + money(fl * pt * pos.qty) + '</span>';
      if (document.activeElement !== $('m_slp')) $('m_slp').value = pos.stop != null ? pos.stop : '';
      if (document.activeElement !== $('m_tpp')) $('m_tpp').value = pos.target != null ? pos.target : '';
    }
    var h = '', n = 0, w = 0, l = 0, pts = 0, usd = 0;
    for (var i = st.mt.length - 1; i >= 0; i--) {
      var tr = st.mt[i], open = tr.status === 'open', p = open ? (px - tr.entry) * tr.dir : tr.pts;
      if (!open) { n++; if (p > 0) w++; else if (p < 0) l++; pts += p; usd += p * pt * tr.qty; }
      h += '<li><div class="l1"><b>' + (tr.dir > 0 ? 'Compra' : 'Venta') + ' ' + tr.qty + '</b><span class="mono">' + hhmm(tr.t) + (open ? ' · abierta' : ' → ' + hhmm(tr.tExit)) + '</span>' +
        '<span class="mono ' + (p >= 0 ? 'pos' : 'neg') + '">' + sgn(p) + ' pts · ' + money(p * pt * tr.qty) + '</span></div>' +
        '<div class="l2 mono">' + fmtP(tr.entry) + (open ? '' : ' → ' + fmtP(tr.exit) + ' · salida por ' + REASON[tr.reason] + (tr.risk ? ' · ' + sgn(p / tr.risk) + 'R' : '')) + '</div>' +
        '<div class="l3">' + esc(tr.note) + '</div></li>';
    }
    $('m_list').innerHTML = h || '<li class="empty">Todavía no has operado. Usa Comprar o Vender debajo del gráfico: la orden entra al precio actual.</li>';
    renderCalc();
    $('m_tot').innerHTML = '<div><b>' + n + '</b><span>cerradas</span></div><div><b>' + w + ' / ' + l + '</b><span>ganadas / perdidas</span></div>' +
      '<div><b class="' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '') + '">' + (n ? sgn(pts) : '0') + '</b><span>puntos</span></div>' +
      '<div><b class="' + (usd > 0 ? 'pos' : usd < 0 ? 'neg' : '') + '">' + (n ? money(usd) : '$0') + '</b><span>resultado</span></div>';
  }

  /* Reloj de la simulación en hora de Nueva York (ET) y tiempo que le queda a la vela de análisis. */
  function simNow() {
    var S = st.an.S;
    if (st.timer && st.mode === 't' && st.barT0 != null) {
      var nb = st.day.bars[S.i + 1];
      if (nb) return nb.t + Math.min(1, (performance.now() - st.barT0) / (st.rate * 1000)) * MIN;
    }
    return S.bar.t + MIN;
  }
  function barLeft() {
    var now = simNow(), tf = st.an.cfg.tf * MIN, s0 = st.day.sessStart, end = s0 + (Math.floor((now - s0) / tf) + 1) * tf;
    var sec = Math.max(0, Math.round((end - now) / 1000));
    var mm = ('0' + Math.floor(sec % 3600 / 60)).slice(-2) + ':' + ('0' + sec % 60).slice(-2);
    return sec >= 3600 ? Math.floor(sec / 3600) + ':' + mm : mm;
  }
  function updateClock() {
    if (!st.an || st.an.S.i < 0) return;
    var d = new Date(Math.floor(simNow() / 1000) * 1000);
    $('clock').textContent = hhmm(d.getTime()) + ':' + ('0' + d.getUTCSeconds()).slice(-2) + ' ET';
    $('barleft').textContent = 'Vela de ' + (st.an.cfg.tf >= 60 ? (st.an.cfg.tf / 60) + ' h' : st.an.cfg.tf + ' min') + ' cierra en ' + barLeft();
  }
  function tickDraw() {
    draw(); renderTrade();
    var el = document.querySelector('#now .px'); if (el) el.textContent = fmtP(st.tick.c);
  }
  /* Avanza hasta que cierra la vela de la temporalidad elegida y la dibuja completa. */
  function stepCandle() {
    var n0 = st.an.S.candles.length, guard = 0;
    while (st.an.S.candles.length === n0 && guard++ < 300) { if (!stepFwd(true) || st.pend != null) break; }
    render();
  }
  function finishTicks() {
    if (!st.path) return;
    for (var k = st.pk; k < st.path.length; k++) manualSeg(st.path[k], st.pj);
    st.path = null;
  }
  function play() {
    if (st.timer) return; $('play').textContent = 'Pausar';
    if (st.mode === 'f') { st.timer = setInterval(function () { stepFwd(); }, Math.max(20, 1000 / st.rate)); return; }
    if (st.mode === 'c') { st.timer = setInterval(stepCandle, st.rate * 1000); stepCandle(); return; }   /* dibuja una vela completa y espera */
    var N = 12;   /* modo con ticks simulados: st.rate segundos por cada vela de 1 minuto */
    st.barT0 = performance.now(); st.clockTimer = setInterval(updateClock, 50);
    st.timer = setInterval(function () {
      if (!st.path) {
        var nb = st.day.bars[st.an.S.i + 1]; if (!nb) { stop(); return; }
        st.path = tickPath(nb, N); st.pk = 0; st.pj = st.an.S.i + 1; st.tickChecked = st.pj;
      }
      if (st.pk < st.path.length) { st.tick = st.path[st.pk++]; manualSeg(st.tick, st.pj); tickDraw(); }
      else { st.tick = null; st.path = null; stepFwd(); st.barT0 = performance.now(); }
    }, st.rate * 1000 / (N + 1));
  }
  function stop() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.clockTimer) { clearInterval(st.clockTimer); st.clockTimer = null; }
    st.barT0 = null; finishTicks();
    if (st.tick) { st.tick = null; if (st.an && st.an.S.i >= 0) render(); }
    $('play').textContent = 'Reproducir'; updateClock();
  }
  function toggle() {
    if (!st.timer) { play(); return; }
    var mid = !!st.tick; stop(); if (mid) stepFwd();   /* al pausar a media vela, la vela se completa */
  }

  /* ---------- paneles ---------- */
  function phase(rel, orb) {
    return rel < 540 ? 'Sesión de Asia' : rel < 840 ? 'Sesión de Londres' : rel < 930 ? 'Pre-apertura de Nueva York'
      : rel < 930 + orb ? 'Formando el ORB' : rel < 1320 ? 'Sesión de Nueva York' : 'Después del cierre';
  }
  function dirTag(d) { return d > 0 ? '<span class="tag buy">Compra</span>' : d < 0 ? '<span class="tag sell">Venta</span>' : '<span class="tag wait">Esperar</span>'; }
  var ANS = { buy: 'Comprar', sell: 'Vender', wait: 'Esperar', none: 'Sin respuesta' };

  function renderNow() {
    var S = st.an.S, px = S.bar.c, up = null, dn = null;
    S.levels.forEach(function (lv) { if (!lv.final) return; if (lv.price >= px && (!up || lv.price < up.price)) up = lv; if (lv.price < px && (!dn || lv.price > dn.price)) dn = lv; });
    var l2 = [];
    if (up) l2.push('Arriba: ' + up.short + ' a ' + fmtN(up.price - px) + ' pts');
    if (dn) l2.push('Abajo: ' + dn.short + ' a ' + fmtN(px - dn.price) + ' pts');
    if (S.open && (st.pend == null || S.open.ev !== st.pend)) l2.push((S.open.dir > 0 ? 'Compra' : 'Venta') + ' abierta desde ' + fmtP(S.open.entry));
    $('now').innerHTML = '<div class="l1"><span class="phase">' + phase(S.rel, st.an.cfg.orbMin) + '</span><span class="px">' + fmtP(px) + '</span></div>' +
      '<div class="l2">' + (l2.length ? esc(l2.join(' · ')) : 'Todavía no hay niveles definidos cerca.') + '</div>';
    updateClock();
  }

  function setupHtml(su) {
    var pt = INST[st.ticker] || 20, side = su.dir > 0 ? 'Compra' : 'Venta', ev = st.an.S.events[su.ev];
    var h = '<div class="plan">' +
      '<div class="row"><span class="k">' + side + '</span><span class="v">' + fmtP(su.entry) + '<small>al cierre de la vela de las ' + hhmm(su.ct) + '</small></span></div>' +
      '<div class="row stop"><span class="k">Stop</span><span class="v">' + fmtP(su.stop) + '<small>' + esc(ev.stopWhy || '') + '</small></span></div>' +
      '<div class="row tgt"><span class="k">Objetivo</span><span class="v">' + fmtP(su.target) + '<small>' + fmtN(st.an.cfg.rr) + ' veces el riesgo</small></span></div>' +
      '<div class="row"><span class="k">Riesgo</span><span class="v">' + fmtN(su.risk) + ' pts<small>$' + fmtN(su.risk * pt) + ' por contrato ' + esc(st.ticker) + '</small></span></div></div>';
    if (su.status === 'open') h += '<p class="outcome">Operación abierta. Avanza para ver cómo termina.</p>';
    else if (su.status === 'win') h += '<p class="outcome win">Terminó en el objetivo a las ' + hhmm(su.tExit) + ': +' + fmtN(su.r) + 'R</p>';
    else if (su.status === 'loss') h += '<p class="outcome loss">Terminó en el stop a las ' + hhmm(su.tExit) + ': −1R</p>';
    else h += '<p class="outcome ' + (su.r >= 0 ? 'win' : 'loss') + '">Se cerró por horario en ' + fmtP(su.exit) + ': ' + (su.r >= 0 ? '+' : '−') + fmtN(Math.abs(su.r)) + 'R</p>';
    return h;
  }

  function renderTutor() {
    var S = st.an.S, el = $('tutor'), e;
    if (st.pend != null) {
      e = S.events[st.pend];
      el.innerHTML = '<div class="quiz"><div class="ev-head"><h3>Momento de decisión</h3><span class="ev-time mono">' + hhmm(e.t) + '</span></div>' +
        '<p style="margin:0">Mira la última vela cerrada y los niveles. ¿Qué harías aquí?</p>' +
        '<div class="opts"><button class="btn" type="button" data-ans="buy">Comprar</button><button class="btn" type="button" data-ans="sell">Vender</button><button class="btn" type="button" data-ans="wait">Esperar</button></div></div>';
      return;
    }
    e = st.sel != null ? S.events[st.sel] : S.events[S.events.length - 1];
    if (!e) { el.innerHTML = '<p class="empty">Avanza la sesión. Aquí aparece la lectura de cada evento: qué pasó, por qué importa y qué hacer.</p>'; return; }
    var su = e.setup != null ? S.setups[e.setup] : e.ofSetup != null ? S.setups[e.ofSetup] : null;
    var h = '<div class="ev-head"><h3>' + esc(e.title) + '</h3>' + (e.type === 'RESULT' ? '' : dirTag(e.setup != null ? e.dir : 0)) + '</div>' +
      '<div class="ev-time mono">' + hhmm(e.t) + (e.id !== S.events.length - 1 ? ' · evento anterior' : '') + '</div><dl>' +
      '<div><dt>Qué pasó</dt><dd>' + esc(e.what) + '</dd></div><div><dt>Por qué importa</dt><dd>' + esc(e.why) + '</dd></div>' +
      (e.plan ? '<div><dt>Qué hacer</dt><dd>' + esc(e.plan) + '</dd></div>' : '') + (e.type === 'RESULT' ? '' : ctxHtml(e, su)) + '</dl>';
    if (e.setup != null && su) h = h.slice(0, h.indexOf('<dl>')) + reasonsHtml(e, su);   /* en una entrada, el tutor explica sus razones una por una */
    if (su) h += setupHtml(su);
    if (e.note) h += '<p class="note">' + esc(e.note) + '</p>';
    var a = st.ans[e.id];
    if (a) { var ok = a === correct(e); h += '<p class="verdict ' + (ok ? 'ok' : 'no') + '">Tu respuesta: ' + ANS[a] + '. La regla: ' + ANS[correct(e)] + '.</p>'; }
    el.innerHTML = h;
  }

  function renderLevels() {
    var S = st.an.S, px = S.bar.c, rows = S.levels.map(function (lv) { return { p: lv.price, lv: lv }; });
    var vp = st.ind.vp ? ind().vp : null;
    if (vp) [['POC', vp.poc], ['VAH', vp.vah], ['VAL', vp.val]].forEach(function (q) { rows.push({ p: q[1], lv: { price: q[1], short: q[0], kind: 'vp', final: true, brk: null, dev: true } }); });
    rows.push({ p: px, px: true }); rows.sort(function (a, b) { return b.p - a.p || (a.px ? 1 : -1); });
    $('levels').innerHTML = rows.map(function (r) {
      if (r.px) return '<tr class="px"><td>Precio</td><td class="n">' + fmtP(r.p) + '</td><td class="stt"></td></tr>';
      var lv = r.lv, d = lv.price - px;
      var s = lv.dev ? 'sesión en curso' : !lv.final ? 'formándose' : lv.brk ? (lv.brk.dir > 0 ? 'roto al alza' : 'roto a la baja') : 'intacto';
      return '<tr><td><span class="dot" style="background:var(--lv-' + lv.kind + ')"></span>' + lv.short + '</td><td class="n">' + fmtP(lv.price) + '</td><td class="stt">' + (d >= 0 ? '+' : '−') + fmtN(Math.abs(d)) + ' · ' + s + '</td></tr>';
    }).join('');
  }

  function renderLog() {
    var S = st.an.S, h = '';
    for (var j = S.events.length - 1; j >= 0; j--) {
      var e = S.events[j], hid = st.pend === e.id;
      var cls = e.type === 'RESULT' ? (e.result === 'win' ? 'buy' : e.result === 'loss' ? 'sell' : '') : (e.setup != null ? (e.dir > 0 ? 'buy' : 'sell') : '');
      h += '<li data-ev="' + e.id + '" class="' + (st.sel === e.id ? 'sel' : '') + '"><span class="t">' + hhmm(e.t) + '</span><span class="pill ' + (hid ? '' : cls) + '">' + (hid ? '?' : esc(e.code)) + '</span><span>' + (hid ? 'Momento de decisión' : esc(e.title)) + '</span></li>';
    }
    $('log').innerHTML = h || '<li style="cursor:default" class="empty"><span></span><span></span><span>Sin eventos todavía.</span></li>';
  }

  function renderScore() {
    var S = st.an.S, pt = INST[st.ticker] || 20, n = 0, w = 0, l = 0, R = 0, pts = 0;
    S.setups.forEach(function (su) { if (su.status === 'open' || (st.pend != null && su.ev === st.pend)) return; n++; if (su.r > 0) w++; else if (su.r < 0) l++; R += su.r; pts += (su.exit - su.entry) * su.dir; });
    var sign = function (x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + fmtN(Math.abs(x)); };
    $('score').innerHTML = '<div><b>' + n + '</b><span>cerradas</span></div><div><b>' + w + ' / ' + l + '</b><span>ganadas / perdidas</span></div>' +
      '<div><b class="' + (R > 0 ? 'pos' : R < 0 ? 'neg' : '') + '">' + sign(R) + 'R</b><span>acumulado</span></div>' +
      '<div><b class="' + (pts > 0 ? 'pos' : pts < 0 ? 'neg' : '') + '">' + (pts < 0 ? '−' : '') + '$' + fmtN(Math.abs(pts * pt)) + '</b><span>por contrato</span></div>';
    var keys = Object.keys(st.ans), ok = 0; keys.forEach(function (k) { var e = S.events[k]; if (e && st.ans[k] === correct(e)) ok++; });
    $('scoreNote').textContent = (st.practice || keys.length ? 'Práctica: coincidiste con la regla en ' + ok + ' de ' + keys.length + ' decisiones. ' : '') +
      'Reglas mecánicas con los valores de Reglas y datos, sin comisiones ni deslizamiento. Si stop y objetivo caen en la misma vela de 1 minuto, cuenta el stop. Sirve para estudiar, no es una recomendación de operar.';
  }

  /* ---------- indicadores (calculados solo con velas ya vistas) ---------- */
  function profAt(i) {
    var d = st.day, a0 = st.cfg.vpFrom === 'rth' ? 930 : 0, key = '_f' + a0;
    if (d[key] == null) { d[key] = d.bars.length; for (var j = 0; j < d.bars.length; j++) if ((d.bars[j].t - d.sessStart) / MIN >= a0) { d[key] = j; break; } }
    return d[key] <= i ? E.profile(d.bars, d[key], i, st.an.cfg.vpBin) : null;
  }
  function computeInd() {
    var S = st.an.S, cfg = st.an.cfg, cs = st.hist.concat(S.candles), n, i, j;
    if (S.cur) cs.push(S.cur); n = cs.length;
    var I = { cs: cs, rsi: [], macd: [], sig: [], hist: [], wr: [], vwap: [], vavg: [], hasVol: false };
    var P = 14, ag = 0, al = 0;
    for (i = 0; i < n; i++) {
      if (i === 0) { I.rsi.push(null); continue; }
      var ch = cs[i].c - cs[i - 1].c, g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i <= P) { ag += g; al += l; if (i === P) { ag /= P; al /= P; I.rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } else I.rsi.push(null); }
      else { ag = (ag * (P - 1) + g) / P; al = (al * (P - 1) + l) / P; I.rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); }
    }
    var e12 = 0, e26 = 0, sg = 0;
    for (i = 0; i < n; i++) {
      var c = cs[i].c; e12 = i ? e12 + (c - e12) * 2 / 13 : c; e26 = i ? e26 + (c - e26) * 2 / 27 : c;
      var m = e12 - e26;
      if (i < 25) { I.macd.push(null); I.sig.push(null); I.hist.push(null); continue; }
      sg = i === 25 ? m : sg + (m - sg) * 2 / 10;
      I.macd.push(m); I.sig.push(i < 33 ? null : sg); I.hist.push(i < 33 ? null : m - sg);
    }
    for (i = 0; i < n; i++) {
      if (cs[i].v > 0) I.hasVol = true;
      if (i < 13) I.wr.push(null);
      else { var hh = -Infinity, ll = Infinity; for (j = i - 13; j <= i; j++) { if (cs[j].h > hh) hh = cs[j].h; if (cs[j].l < ll) ll = cs[j].l; } I.wr.push(hh === ll ? -50 : (hh - cs[i].c) / (hh - ll) * -100); }
      if (i < 20) I.vavg.push(null);
      else { var sv = 0; for (j = i - 20; j < i; j++) sv += cs[j].v; I.vavg.push(sv / 20); }
    }
    var pv = 0, vv = 0, by = {}, a0 = st.cfg.vwapFrom === 'rth' ? 930 : 0, bars = st.day.bars;
    for (i = 0; i <= S.i; i++) {
      var b = bars[i], rel = Math.round((b.t - st.day.sessStart) / MIN); if (rel < a0) continue;
      var v = b.v || 0; pv += (b.h + b.l + b.c) / 3 * v; vv += v; if (vv > 0) by[Math.floor(rel / cfg.tf)] = pv / vv;
    }
    for (i = 0; i < n; i++) I.vwap.push(by[cs[i].bk] != null ? by[cs[i].bk] : null);
    I.vp = I.hasVol ? profAt(S.i) : null;
    return I;
  }
  function ind() { return st.I || (st.I = computeInd()); }
  function paneList() {
    var I = ind(), p = [];
    if (st.ind.vol && I.hasVol) p.push(['vol', 60]);
    if (st.ind.rsi) p.push(['rsi', 78]);
    if (st.ind.macd) p.push(['macd', 90]);
    if (st.ind.wr) p.push(['wr', 78]);
    return p;
  }
  function layout() {
    var base = window.matchMedia && window.matchMedia('(max-width:980px)').matches ? 330 : 470, sum = 0;
    paneList().forEach(function (q) { sum += q[1]; });
    var hpx = (base + sum) + 'px', box = $('chartbox'); if (box.style.height !== hpx) box.style.height = hpx;
  }
  function ctxHtml(e, su) {
    var I = ind(), cs = I.cs, lo = 0, hi = cs.length - 1, k = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (cs[mid].t <= e.ct) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    var c = cs[k]; if (!c) return '';
    var d = su && e.setup != null ? su.dir : 0, items = [], fav = 0, tot = 0;
    function add(txt, bull) {
      var cls = ''; if (d && bull) { tot++; if (bull === d) { fav++; cls = ' fav'; } else cls = ' con'; }
      items.push('<span class="ic' + cls + '">' + txt + '</span>');
    }
    if (st.ind.vwap && I.vwap[k] != null) { var dv = c.c - I.vwap[k]; add((dv >= 0 ? 'Sobre el VWAP' : 'Bajo el VWAP') + ' por ' + fmtN(Math.abs(dv)) + ' pts', dv >= 0 ? 1 : -1); }
    if (st.ind.vp) {
      var vp = profAt(e.i);
      if (vp) { if (c.c > vp.vah) add('Sobre el área de valor · VAH ' + fmtP(vp.vah), 1); else if (c.c < vp.val) add('Bajo el área de valor · VAL ' + fmtP(vp.val), -1); else add('Dentro del área de valor · POC ' + fmtP(vp.poc), 0); }
    }
    if (st.ind.rsi && I.rsi[k] != null) { var r = I.rsi[k]; add('RSI ' + r.toFixed(0) + (r >= 70 ? ' · sobrecompra' : r <= 30 ? ' · sobreventa' : ''), r > 50 ? 1 : r < 50 ? -1 : 0); }
    if (st.ind.macd && I.hist[k] != null) add(I.hist[k] >= 0 ? 'MACD sobre su señal' : 'MACD bajo su señal', I.hist[k] >= 0 ? 1 : -1);
    if (st.ind.wr && I.wr[k] != null) { var w = I.wr[k]; add('%R −' + Math.abs(w).toFixed(0) + (w >= -20 ? ' · sobrecompra' : w <= -80 ? ' · sobreventa' : ''), w > -50 ? 1 : -1); }
    if (st.ind.vol && I.vavg[k]) add('Volumen ' + (c.v / I.vavg[k]).toFixed(1) + '× el promedio', 0);
    if (!items.length) return '';
    var sum = '';
    if (tot) sum = '<small class="ctxsum">' + fav + ' de ' + tot + ' a favor de la ' + (d > 0 ? 'compra' : 'venta') + '; los marcados en otro color van en contra. No filtran la entrada, solo dan contexto.' +
      (e.type === 'FALSO' || e.type === 'RECH' ? ' En un giro es normal que el impulso todavía apunte al otro lado.' : '') + '</small>';
    return '<div><dt>Indicadores en esa vela</dt><dd>' + items.join('') + sum + '</dd></div>';
  }

  /* ---------- razones de una entrada: por qué se toma, qué tiene en contra y qué la invalida ---------- */
  function reasons(e, su) {
    var I = ind(), cs = I.cs, lo = 0, hi = cs.length - 1, k = 0, S = st.an.S;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (cs[mid].t <= e.ct) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    var K = cs[k], d = su.dir, sell = d < 0, side = sell ? 'venta' : 'compra', rev = e.type === 'FALSO' || e.type === 'RECH';
    var pro = [e.what + ' ' + e.why], con = [];
    /* la vela de la señal */
    var rng = K.h - K.l;
    if (rng > 0) {
      var pos = (K.c - K.l) / rng;
      if (sell ? pos <= 0.35 : pos >= 0.65) pro.push('La vela cerró en su tercio ' + (sell ? 'inferior' : 'superior') + ': los ' + (sell ? 'vendedores' : 'compradores') + ' dominaron el cierre.');
      else if (sell ? pos >= 0.65 : pos <= 0.35) con.push('La vela cerró en su parte ' + (sell ? 'alta' : 'baja') + ': el cierre no confirma la ' + side + ' con fuerza.');
      var wick = sell ? K.h - Math.max(K.o, K.c) : Math.min(K.o, K.c) - K.l;
      if (rev && wick / rng >= 0.4) pro.push('Dejó una mecha ' + (sell ? 'superior' : 'inferior') + ' de ' + fmtN(wick) + ' pts, el ' + Math.round(wick / rng * 100) + ' % de la vela: el precio fue rechazado con claridad.');
    }
    if (st.ind.vol && I.vavg[k]) {
      var vr = K.v / I.vavg[k];
      if (vr >= 1.3) pro.push('Volumen ' + vr.toFixed(1) + ' veces el promedio: hubo participación real en el movimiento.');
      else if (vr <= 0.7) con.push('Volumen bajo, ' + vr.toFixed(1) + ' veces el promedio: poca participación detrás de la señal.');
    }
    /* confluencia con otros niveles ya definidos en ese momento */
    var own = null; S.levels.forEach(function (lv) { if (lv.id === e.level) own = lv; });
    var base = own ? own.price : su.entry;
    var lvls = S.levels.filter(function (lv) { return lv.final && lv.finalT <= e.t && lv.id !== e.level; });
    var near = lvls.filter(function (lv) { return Math.abs(lv.price - base) <= 8 && (lv.price - su.entry) * d <= 2; })   /* los que quedan por delante son obstáculos, no apoyo */
     .map(function (lv) { return lv.short + ' (' + fmtP(lv.price) + ')'; });
    if (near.length) pro.push('Hay confluencia: ' + near.join(' y ') + (near.length > 1 ? ' están' : ' está') + ' a menos de 8 pts del mismo punto, así que más participantes miran esta zona.');
    /* VWAP */
    if (st.ind.vwap && I.vwap[k] != null) {
      var dv = K.c - I.vwap[k], adv = fmtN(Math.round(Math.abs(dv)));
      if (sell ? dv < 0 : dv > 0) pro.push('El precio está ' + (sell ? 'bajo' : 'sobre') + ' el VWAP por ' + adv + ' pts: la ' + side + ' va a favor del precio promedio de la sesión.');
      else if (rev && Math.abs(dv) >= su.risk * 1.5) pro.push('El precio está estirado ' + adv + ' pts ' + (sell ? 'sobre' : 'bajo') + ' el VWAP: tiene espacio para regresar hacia el promedio.');
      else con.push('El precio sigue ' + (sell ? 'sobre' : 'bajo') + ' el VWAP por ' + adv + ' pts: la sesión todavía favorece a los ' + (sell ? 'compradores' : 'vendedores') + '.');
    }
    /* área de valor de la sesión en ese momento */
    if (st.ind.vp) {
      var vp = profAt(e.i);
      if (vp) {
        var above = K.c > vp.vah, below = K.c < vp.val;
        if (rev) {
          if (sell ? above : below) pro.push('El precio está fuera del área de valor, por ' + (sell ? 'arriba (VAH ' + fmtP(vp.vah) : 'abajo (VAL ' + fmtP(vp.val)) + '): un regreso hacia el valor juega a favor.');
          else if (sell ? below : above) con.push('El precio ya está ' + (sell ? 'bajo' : 'sobre') + ' el área de valor: ' + (sell ? 'vender' : 'comprar') + ' aquí es perseguir el movimiento.');
        } else if (sell ? below : above) pro.push('El precio acepta niveles ' + (sell ? 'bajo' : 'sobre') + ' el área de valor: el mercado busca precios más ' + (sell ? 'bajos' : 'altos') + '.');
        else if (sell ? above : below) con.push('El precio está al otro lado del área de valor: la ' + side + ' va contra la zona donde más se ha negociado.');
      }
    }
    /* impulso */
    if (st.ind.rsi && I.rsi[k] != null) {
      var r = I.rsi[k];
      if (rev) { if (sell ? r >= 70 : r <= 30) pro.push('RSI en ' + (sell ? 'sobrecompra' : 'sobreventa') + ' (' + r.toFixed(0) + '): el movimiento previo venía extendido.'); }
      else if (sell ? r < 50 : r > 50) pro.push('RSI en ' + r.toFixed(0) + ', del lado ' + (sell ? 'bajista' : 'alcista') + ' de 50: el impulso acompaña.');
      else con.push('RSI en ' + r.toFixed(0) + ': el impulso todavía no acompaña la ' + side + '.');
    }
    if (st.ind.macd && I.hist[k] != null) {
      if (sell ? I.hist[k] < 0 : I.hist[k] > 0) pro.push('MACD ' + (sell ? 'bajo' : 'sobre') + ' su señal: el impulso ya giró a favor.');
      else con.push('MACD todavía ' + (sell ? 'sobre' : 'bajo') + ' su señal: el impulso contrario no ha terminado de girar.');
    }
    if (st.ind.wr && I.wr[k] != null && rev) {
      var w = I.wr[k];
      if (sell ? w >= -20 : w <= -80) pro.push('Williams %R en ' + (sell ? 'sobrecompra' : 'sobreventa') + ' (−' + Math.abs(w).toFixed(0) + '): confirma que el precio estaba en un extremo.');
    }
    /* espacio hasta el objetivo */
    var block = null, tdist = Math.abs(su.target - su.entry);
    lvls.forEach(function (lv) { var dist = (lv.price - su.entry) * d; if (dist > 2 && dist < tdist && (!block || dist < block.dist)) block = { lv: lv, dist: dist }; });
    if (block) con.push('Hay un nivel en el camino: ' + block.lv.short + ' en ' + fmtP(block.lv.price) + ', a ' + fmtN(block.dist) + ' pts, antes del objetivo que está a ' + fmtN(tdist) + ' pts. Ahí el precio puede frenar: es buen punto para pasar el stop a la entrada.');
    else pro.push('Camino libre: no hay niveles marcados entre la entrada y el objetivo, a ' + fmtN(tdist) + ' pts.');
    /* hora del día */
    var rel = Math.round((e.t - st.day.sessStart) / MIN);
    if (rel >= 1050 && rel < 1170) con.push('Es el mediodía de Nueva York (11:30 a 13:30): suele haber menos movimiento y más giros que no continúan.');
    else if (rel >= 930 && rel < 1020) pro.push('Ocurre en los primeros 90 minutos de Nueva York, la franja con más participación del día.');
    var score = pro.length - con.length;
    return { pro: pro, con: con, side: side, grade: score >= 4 ? 'alta' : score >= 2 ? 'media' : 'baja',
             inval: 'Un precio en ' + fmtP(su.stop) + ', ' + (e.stopWhy || 'al otro lado de la señal') + '. Si llega ahí, los ' + (sell ? 'compradores' : 'vendedores') + ' recuperaron el control y la razón de la entrada dejó de existir: se sale sin discutir.' };
  }
  function reasonsHtml(e, su) {
    var R = reasons(e, su), li = function (t) { return '<li>' + esc(t) + '</li>'; };
    return '<div class="why"><h4>Se toma la ' + R.side + ' porque</h4><ol>' + R.pro.map(li).join('') + '</ol>' +
      '<h4>En contra</h4>' + (R.con.length ? '<ul>' + R.con.map(li).join('') + '</ul>' : '<p>Nada relevante en contra con los indicadores activos.</p>') +
      '<h4>Qué la invalida</h4><p>' + esc(R.inval) + '</p>' +
      '<p class="grade g-' + R.grade + '">Confluencia ' + R.grade + ': ' + R.pro.length + ' a favor, ' + R.con.length + ' en contra.</p></div>';
  }

  /* ---------- gráfico ---------- */
  var col = null;
  function colors() {
    if (col) return col; var cs = getComputedStyle(document.documentElement);
    function g(n) { return cs.getPropertyValue(n).trim(); }
    col = { bg: g('--chart'), grid: g('--grid'), ink: g('--ink'), muted: g('--muted'), up: g('--up'), down: g('--down'), accent: g('--accent'),
            prior: g('--lv-prior'), lon: g('--lv-lon'), asia: g('--lv-asia'), orb: g('--lv-orb'), surface: g('--surface'), line: g('--line'), vwap: g('--vwap'), vp: g('--lv-vp') };
    return col;
  }
  function A(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function niceStep(range, lines) { var raw = range / lines, pool = [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000]; for (var i = 0; i < pool.length; i++) if (pool[i] >= raw) return pool[i]; return 2500; }

  function draw() {
    var cv = $('chart'), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H || !st.an) return;
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    var C = colors(), S = st.an.S, cfg = st.an.cfg, I = ind(), i;
    var cs = st.hist.concat(S.candles); if (S.cur) cs.push(S.cur);
    if (st.tick) {
      var tk = st.tick, tbk = Math.floor(Math.round((tk.t - st.day.sessStart) / MIN) / cfg.tf), lc = cs[cs.length - 1];
      if (S.cur && S.cur.bk === tbk) cs = cs.slice(0, -1).concat([{ bk: tbk, t: lc.t, rel: lc.rel, o: lc.o, h: Math.max(lc.h, tk.h), l: Math.min(lc.l, tk.l), c: tk.c, v: lc.v + tk.v }]);
      else cs = cs.concat([{ bk: tbk, t: st.day.sessStart + tbk * cfg.tf * MIN, rel: tbk * cfg.tf, o: tk.o, h: tk.h, l: tk.l, c: tk.c, v: tk.v }]);
    }
    var panes = paneList(), paneH = 0; panes.forEach(function (q) { paneH += q[1]; });
    var AX = 78, BX = 22, TP = 24, pw = W - AX, ph = H - BX - TP - paneH;
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H); st.hits = [];
    if (!cs.length) return;
    var n = st.visN; st.pan = Math.max(0, Math.min(st.pan, cs.length - 5));
    var end = cs.length - st.pan, start = Math.max(0, end - n), slot = pw / (n + Math.max(4, Math.round(n * 0.18)));   /* margen libre a la derecha para las etiquetas */
    st.geom = { start: start, end: end, slot: slot, pw: pw, cs: cs };
    function X(k) { return (k - start + 0.5) * slot; }
    function idxOf(t) { var lo = 0, hi = cs.length - 1, r = 0; while (lo <= hi) { var m = (lo + hi) >> 1; if (cs[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
    var selEv = st.sel != null ? S.events[st.sel] : null;
    function hidden(su) { return st.pend != null && su.ev === st.pend; }
    function focus(su) { return (su.status === 'open' && st.pan === 0) || (selEv && (selEv.setup === su.id || selEv.ofSetup === su.id)); }

    var lo = Infinity, hi = -Infinity;
    for (i = start; i < end; i++) { if (cs[i].l < lo) lo = cs[i].l; if (cs[i].h > hi) hi = cs[i].h; }
    S.setups.forEach(function (su) { if (hidden(su) || !focus(su)) return; var k = idxOf(su.ct); if (k < start - 2 || k >= end) return; lo = Math.min(lo, su.stop, su.target); hi = Math.max(hi, su.stop, su.target); });
    if (st.pan === 0) st.mt.forEach(function (tr) { if (tr.status !== 'open') return; [tr.stop, tr.target].forEach(function (v) { if (v != null && Math.abs(v - tr.entry) <= 400) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    var pad = (hi - lo) * 0.08 || 5; lo -= pad; hi += pad;
    if (st.ldrag) { lo = st.ldrag.lo; hi = st.ldrag.hi; }   /* la escala no se mueve mientras arrastras una línea */
    st.geom.lo = lo; st.geom.hi = hi; st.geom.TP = TP; st.geom.ph = ph;
    function Y(p) { return TP + (hi - p) / (hi - lo) * ph; }

    x.font = '11px "IBM Plex Mono", ui-monospace, monospace'; x.textBaseline = 'middle';
    /* bandas de sesión, una por cada día visible */
    [['asia', 0, 540, 'Asia'], ['lon', 540, 840, 'Londres'], ['orb', 930, 930 + cfg.orbMin, 'ORB']].forEach(function (b) {
      var a = -1;
      function flush(z) {
        if (a < 0) return; var xa = X(a) - slot / 2, xb = X(z) + slot / 2;
        x.fillStyle = A(C[b[0]], 0.07); x.fillRect(xa, TP, xb - xa, ph);
        x.fillStyle = C[b[0]]; x.textAlign = 'left'; if (xb - xa > 46) x.fillText(b[3], xa + 4, TP + 8);
        a = -1;
      }
      for (i = start; i < end; i++) {
        var r = cs[i].rel, inb = r >= b[1] && r < b[2];
        if (inb && a >= 0 && cs[i].t - cs[i - 1].t > 6 * HOUR) flush(i - 1);
        if (inb) { if (a < 0) a = i; } else flush(i - 1);
      }
      flush(end - 1);
    });
    /* cuadrícula */
    var stp = niceStep(hi - lo, 7); x.strokeStyle = C.grid; x.lineWidth = 1; x.textAlign = 'left';
    for (var p = Math.ceil(lo / stp) * stp; p < hi; p += stp) { var gy = Math.round(Y(p)) + 0.5; x.beginPath(); x.moveTo(0, gy); x.lineTo(pw, gy); x.stroke(); x.fillStyle = C.muted; x.fillText(fmtP(p), pw + 6, gy); }
    x.strokeStyle = C.line; x.beginPath(); x.moveTo(pw + 0.5, 0); x.lineTo(pw + 0.5, H - BX); x.moveTo(0, H - BX + 0.5); x.lineTo(W, H - BX + 0.5); x.stroke();
    var lastLab = -99, labStep = cfg.tf >= 240 ? 1440 : cfg.tf >= 60 ? 360 : cfg.tf >= 15 ? 60 : cfg.tf >= 5 ? 30 : 10; x.textAlign = 'center';
    for (i = start; i < end; i++) {
      var cx = X(i), newDay = i > 0 && cs[i].rel < cs[i - 1].rel;
      if (newDay) { var sx = Math.round(cx - slot / 2) + 0.5; x.strokeStyle = C.muted; x.setLineDash([1, 4]); x.beginPath(); x.moveTo(sx, TP); x.lineTo(sx, H - BX); x.stroke(); x.setLineDash([]); }
      if (newDay && cx - lastLab >= 40) {
        var dd = new Date(cs[i].t - cs[i].rel * MIN + 6 * HOUR);
        x.fillStyle = C.ink; x.fillText(('0' + dd.getUTCDate()).slice(-2) + '/' + ('0' + (dd.getUTCMonth() + 1)).slice(-2), cx, H - BX / 2); lastLab = cx;
      } else if (cx - lastLab >= 64 && cs[i].rel % labStep === 0) { x.fillStyle = C.muted; x.fillText(hhmm(cs[i].t), cx, H - BX / 2); lastLab = cx; }
    }

    x.save(); x.beginPath(); x.rect(0, TP - 6, pw, ph + 6); x.clip();
    /* zonas FVG */
    var marks = st.ind.marks !== false;
    (marks ? S.zones : []).forEach(function (z) {
      var xa = Math.max(0, X(idxOf(z.t0)) - slot / 2), xb = z.tEnd != null ? X(idxOf(z.tEnd)) + slot / 2 : pw;
      if (xb < 0 || xa > pw || z.t0 > cs[end - 1].t) return;
      var y1 = Y(z.top), y2 = Y(z.bot), c = z.dir > 0 ? C.up : C.down;
      x.fillStyle = A(c, z.dead ? 0.05 : 0.15); x.fillRect(xa, y1, xb - xa, y2 - y1);
      if (!z.dead) { x.strokeStyle = A(c, 0.7); x.setLineDash(z.inv ? [4, 3] : []); x.strokeRect(xa + 0.5, y1 + 0.5, xb - xa - 1, y2 - y1 - 1); x.setLineDash([]);
        if (y2 - y1 >= 12) { x.fillStyle = c; x.textAlign = 'left'; x.fillText(z.inv ? 'iFVG' : 'FVG', xa + 4, y1 + 7); } }
    });
    /* niveles */
    var tags = [];
    var VP = st.ind.vp ? I.vp : null;
    if (VP) {
      var xs = Math.max(0, X(idxOf(st.day.sessStart)) - slot / 2), maxW = Math.min(pw * 0.24, Math.max(20, pw - xs)), kb;
      for (kb = VP.lo; kb <= VP.hi; kb++) {
        var vq = VP.vol[kb]; if (!vq) continue;
        var yA = Y((kb + 1) * VP.bin), yB = Y(kb * VP.bin); if (yB < TP - 6 || yA > TP + ph + 6) continue;
        var isPoc = kb === VP.pocBin, inVA = kb >= VP.dnBin && kb <= VP.upBin;
        x.fillStyle = A(isPoc ? C.accent : C.vp, isPoc ? 0.45 : inVA ? 0.26 : 0.12);
        x.fillRect(xs, yA + 0.5, vq / VP.max * maxW, Math.max(1, yB - yA - 1));
      }
      [['POC', VP.poc], ['VAH', VP.vah], ['VAL', VP.val]].forEach(function (q) {
        var yy = Y(q[1]); if (yy < TP || yy > TP + ph) return;
        x.strokeStyle = C.vp; x.lineWidth = 1; x.setLineDash(q[0] === 'POC' ? [] : [5, 4]);
        x.beginPath(); x.moveTo(xs, Math.round(yy) + 0.5); x.lineTo(pw, Math.round(yy) + 0.5); x.stroke(); x.setLineDash([]);
        tags.push({ y: yy, text: q[0], fg: C.vp, bg: C.bg, border: C.vp });
      });
    }
    S.levels.forEach(function (lv) {
      var y = Y(lv.price); if (y < TP - 4 || y > TP + ph + 4 || lv.fromT > cs[end - 1].t + cfg.tf * MIN) return;
      var xa = Math.max(0, X(idxOf(lv.fromT)) - slot / 2), c = C[lv.kind];
      x.strokeStyle = c; x.lineWidth = 1.25; x.setLineDash(lv.final ? [] : [3, 4]);
      x.beginPath(); x.moveTo(xa, Math.round(y) + 0.5); x.lineTo(pw, Math.round(y) + 0.5); x.stroke(); x.setLineDash([]);
      tags.push({ y: y, text: lv.short, fg: c, bg: C.bg, border: c });
    });
    /* operaciones */
    (marks ? S.setups : []).forEach(function (su) {
      if (hidden(su)) return;
      var ka = idxOf(su.ct), xa = X(ka), kb = su.tExit != null ? idxOf(su.tExit) : null, xb = kb != null ? X(kb) : pw;
      if (xb < 0 || xa > pw) return;
      if (focus(su)) {
        if (kb != null && xb - xa < slot * 4) xb = xa + slot * 4;
        var ye = Y(su.entry), ys = Y(su.stop), yt = Y(su.target);
        x.fillStyle = A(C.down, 0.16); x.fillRect(xa, Math.min(ye, ys), xb - xa, Math.abs(ys - ye));
        x.fillStyle = A(C.up, 0.16); x.fillRect(xa, Math.min(ye, yt), xb - xa, Math.abs(yt - ye));
        [[ye, C.ink], [ys, C.down], [yt, C.up]].forEach(function (q) { x.strokeStyle = q[1]; x.lineWidth = 1; x.beginPath(); x.moveTo(xa, Math.round(q[0]) + 0.5); x.lineTo(xb, Math.round(q[0]) + 0.5); x.stroke(); });
        tags.push({ y: ye, text: 'Entrada', fg: C.bg, bg: C.ink }, { y: ys, text: 'Stop', fg: C.bg, bg: C.down }, { y: yt, text: 'Objetivo', fg: C.bg, bg: C.up });
      } else if (kb != null) {
        var c2 = su.r >= 0 ? C.up : C.down;
        x.strokeStyle = c2; x.lineWidth = 1.5; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(xa, Y(su.entry)); x.lineTo(xb, Y(su.exit)); x.stroke(); x.setLineDash([]);
        x.fillStyle = c2; x.beginPath(); x.arc(xb, Y(su.exit), 3, 0, 6.3); x.fill();
      }
    });
    /* velas */
    var bw = Math.max(1, Math.min(14, slot * 0.68));
    for (i = start; i < end; i++) {
      var k = cs[i], up = k.c >= k.o, cc = up ? C.up : C.down, cx2 = Math.round(X(i)) + 0.5;
      x.strokeStyle = cc; x.lineWidth = 1; x.beginPath(); x.moveTo(cx2, Y(k.h)); x.lineTo(cx2, Y(k.l)); x.stroke();
      var yo = Y(k.o), yc = Y(k.c), top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
      x.fillStyle = cc; x.fillRect(cx2 - bw / 2, top, bw, hh);
    }
    if (st.ind.vwap) {
      x.strokeStyle = C.vwap; x.lineWidth = 1.6; x.beginPath(); var pen = false;
      for (i = start; i < end; i++) { var vw = I.vwap[i]; if (vw == null) { pen = false; continue; } if (pen) x.lineTo(X(i), Y(vw)); else { x.moveTo(X(i), Y(vw)); pen = true; } }
      x.stroke();
      if (I.vwap[end - 1] != null) tags.push({ y: Y(I.vwap[end - 1]), text: 'VWAP', fg: C.vwap, bg: C.bg, border: C.vwap });
    }
    /* marcas de eventos */
    var MARK = { BRK: 1, FALSO: 1, RECH: 1, RET: 1, FVGT: 1, IFVG: 1, IFVGR: 1 }, stack = {};
    x.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; x.textAlign = 'center';
    (marks ? S.events : []).forEach(function (e) {
      var pendHere = st.pend === e.id; if (!MARK[e.type] && !pendHere) return;
      var kI = idxOf(e.ct); if (kI < start || kI >= end) return;
      var k = cs[kI], below = !pendHere && e.dir > 0, key = kI + (below ? 'b' : 'a'), nS = stack[key] || 0; stack[key] = nS + 1;
      var txt = pendHere ? '?' : e.code, w = x.measureText(txt).width + 8, mx = X(kI);
      var my = below ? Y(k.l) + 12 + nS * 15 : Y(k.h) - 12 - nS * 15;
      var c = pendHere ? C.accent : e.setup != null ? (e.dir > 0 ? C.up : C.down) : C.muted;
      x.fillStyle = e.setup != null || pendHere ? c : C.bg; x.strokeStyle = c; x.lineWidth = st.sel === e.id ? 2.5 : 1;
      x.beginPath(); x.rect(mx - w / 2, my - 7, w, 14); x.fill(); x.stroke();
      x.fillStyle = e.setup != null || pendHere ? C.bg : c; x.fillText(txt, mx, my + 0.5);
      st.hits.push({ x: mx - w / 2 - 3, y: my - 10, w: w + 6, h: 20, id: e.id });
    });
    /* mis operaciones */
    st.mt.forEach(function (tr) {
      var xa = X(idxOf(tr.t)), ye = Y(tr.entry);
      if (tr.status === 'open') {
        /* líneas finas con una etiqueta pequeña a la derecha, al estilo de TradingView */
        var x0 = Math.max(0, xa), ptv = (INST[st.ticker] || 20) * tr.qty, fl = ((st.tick ? st.tick.c : S.bar.c) - tr.entry) * tr.dir;
        var lab = function (y, tag, txt, colr, txtCol) {
          x.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
          var w1 = x.measureText(tag).width + 10, w2 = x.measureText(txt).width + 12, lx = pw - w1 - w2 - 8, top = Math.round(y) - 8;
          x.fillStyle = C.bg; x.fillRect(lx, top, w1 + w2, 16);
          x.fillStyle = colr; x.fillRect(lx, top, w1, 16);
          x.strokeStyle = colr; x.lineWidth = 1; x.setLineDash([]); x.strokeRect(lx + 0.5, top + 0.5, w1 + w2 - 1, 15);
          x.textAlign = 'left'; x.fillStyle = C.bg; x.fillText(tag, lx + 5, top + 8.5);
          x.fillStyle = txtCol || colr; x.fillText(txt, lx + w1 + 6, top + 8.5);
        };
        var hline = function (y, colr, dash, hot) { x.strokeStyle = colr; x.lineWidth = hot ? 2 : 1; x.setLineDash(dash); x.beginPath(); x.moveTo(x0, Math.round(y) + 0.5); x.lineTo(pw, Math.round(y) + 0.5); x.stroke(); x.setLineDash([]); };
        hline(ye, C.accent, [], false);
        [[tr.stop, C.down, 'SL', 'stop'], [tr.target, C.up, 'TP', 'target']].forEach(function (q) {
          if (q[0] == null) return; var yy = Y(q[0]), d = (q[0] - tr.entry) * tr.dir;
          hline(yy, q[1], [4, 3], st.ldrag && st.ldrag.key === q[3]);
          lab(yy, q[2], sgn(d) + ' pts  ' + money(d * ptv), q[1]);
          tags.push({ y: yy, text: fmtP(q[0]), fg: C.bg, bg: q[1] });
        });
        lab(ye, (tr.dir > 0 ? 'Compra ' : 'Venta ') + tr.qty, sgn(fl) + ' pts  ' + money(fl * ptv), C.accent, fl >= 0 ? C.up : C.down);
        tags.push({ y: ye, text: fmtP(tr.entry), fg: C.bg, bg: C.accent });
      } else {
        var xb = X(idxOf(tr.tExit));
        x.strokeStyle = C.accent; x.lineWidth = 2; x.setLineDash([]); x.beginPath(); x.moveTo(xa, ye); x.lineTo(xb, Y(tr.exit)); x.stroke();
        x.fillStyle = C.accent; x.fillRect(xb - 3, Y(tr.exit) - 3, 6, 6);
      }
      x.fillStyle = C.accent; x.beginPath();
      if (tr.dir > 0) { x.moveTo(xa, ye + 3); x.lineTo(xa - 4, ye + 10); x.lineTo(xa + 4, ye + 10); }
      else { x.moveTo(xa, ye - 3); x.lineTo(xa - 4, ye - 10); x.lineTo(xa + 4, ye - 10); }
      x.closePath(); x.fill();
    });
    x.restore();

    /* etiquetas en el eje de precios */
    var last = cs[end - 1];
    tags.push({ y: Y(last.c), text: fmtP(last.c), fg: C.bg, bg: last.c >= last.o ? C.up : C.down, px: true });
    if (st.pan === 0) tags.push({ y: Y(last.c) + 0.01, text: barLeft(), fg: C.ink, bg: C.surface, border: C.line });
    tags.sort(function (a, b) { return a.y - b.y; });
    for (i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 15) tags[i].y = tags[i - 1].y + 15;
    x.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace'; x.textAlign = 'left';
    tags.forEach(function (t) {
      if (t.y < 8 || t.y > TP + ph + 2) return;
      x.fillStyle = t.bg; x.fillRect(pw + 2, t.y - 7, AX - 4, 14);
      if (t.border) { x.strokeStyle = t.border; x.lineWidth = 1; x.strokeRect(pw + 2.5, t.y - 6.5, AX - 5, 13); }
      x.fillStyle = t.fg; x.fillText(t.text, pw + 6, t.y + 0.5);
    });

    /* paneles de indicadores */
    var hovering = st.hover && st.hover.x < pw && st.hover.y > TP && st.hover.y < H - BX;
    var hk = hovering ? Math.max(start, Math.min(end - 1, Math.floor(st.hover.x / slot) + start)) : end - 1;
    var py = TP + ph;
    function plot(arr, Yf, color, lw) {
      x.strokeStyle = color; x.lineWidth = lw || 1.4; x.setLineDash([]); x.beginPath(); var on = false;
      for (var k = start; k < end; k++) { var v = arr[k]; if (v == null) { on = false; continue; } if (on) x.lineTo(X(k), Yf(v)); else { x.moveTo(X(k), Yf(v)); on = true; } }
      x.stroke();
    }
    function ref(y, txt) {
      x.strokeStyle = C.muted; x.lineWidth = 1; x.setLineDash([2, 4]); x.beginPath(); x.moveTo(0, Math.round(y) + 0.5); x.lineTo(pw, Math.round(y) + 0.5); x.stroke(); x.setLineDash([]);
      x.fillStyle = C.muted; x.textAlign = 'left'; x.fillText(txt, pw + 6, y);
    }
    function f1(v) { return v == null ? '–' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1); }
    x.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    panes.forEach(function (q) {
      var y0 = py, h = q[1], top = y0 + 20, bot = y0 + h - 5, k, title; py += h;
      x.strokeStyle = C.line; x.lineWidth = 1; x.beginPath(); x.moveTo(0, y0 + 0.5); x.lineTo(W, y0 + 0.5); x.stroke();
      if (q[0] === 'vol') {
        var mv = 0; for (k = start; k < end; k++) { if (cs[k].v > mv) mv = cs[k].v; if (I.vavg[k] > mv) mv = I.vavg[k]; }
        if (mv > 0) {
          for (k = start; k < end; k++) { var bh = cs[k].v / mv * (bot - top); x.fillStyle = A(cs[k].c >= cs[k].o ? C.up : C.down, 0.6); x.fillRect(Math.round(X(k)) + 0.5 - bw / 2, bot - bh, bw, bh); }
          plot(I.vavg, function (v) { return bot - v / mv * (bot - top); }, C.muted, 1);
        }
        title = 'Volumen ' + fmtN(cs[hk].v) + (I.vavg[hk] ? ' · promedio de 20 velas ' + fmtN(Math.round(I.vavg[hk])) : '');
      } else if (q[0] === 'rsi') {
        var Yr = function (v) { return top + (100 - v) / 100 * (bot - top); };
        ref(Yr(70), '70'); ref(Yr(30), '30'); plot(I.rsi, Yr, C.accent);
        title = 'RSI 14 · ' + f1(I.rsi[hk]);
      } else if (q[0] === 'wr') {
        var Yw = function (v) { return top + (-v) / 100 * (bot - top); };
        ref(Yw(-20), '−20'); ref(Yw(-80), '−80'); plot(I.wr, Yw, C.prior);
        title = 'Williams %R 14 · ' + f1(I.wr[hk]);
      } else {
        var m = 0; for (k = start; k < end; k++) [I.macd[k], I.sig[k], I.hist[k]].forEach(function (v) { if (v != null && Math.abs(v) > m) m = Math.abs(v); });
        m = m || 1; var mid = (top + bot) / 2, Ym = function (v) { return mid - v / m * (bot - top) / 2; };
        ref(mid, '0');
        for (k = start; k < end; k++) { var hv = I.hist[k]; if (hv == null) continue; x.fillStyle = A(hv >= 0 ? C.up : C.down, 0.55); x.fillRect(Math.round(X(k)) + 0.5 - bw / 2, Math.min(mid, Ym(hv)), bw, Math.abs(Ym(hv) - mid)); }
        plot(I.macd, Ym, C.accent); plot(I.sig, Ym, C.orb, 1.2);
        title = 'MACD 12·26·9 · ' + f1(I.macd[hk]) + ' · señal ' + f1(I.sig[hk]) + ' · histograma ' + f1(I.hist[hk]);
      }
      x.fillStyle = C.muted; x.textAlign = 'left'; x.fillText(title, 6, y0 + 10);
    });

    /* cursor */
    var ro = cs[hk];
    if (hovering) {
      x.strokeStyle = C.muted; x.lineWidth = 1; x.setLineDash([2, 3]); x.beginPath();
      x.moveTo(Math.round(X(hk)) + 0.5, TP); x.lineTo(Math.round(X(hk)) + 0.5, H - BX);
      if (st.hover.y < TP + ph) { x.moveTo(0, st.hover.y + 0.5); x.lineTo(pw, st.hover.y + 0.5); }
      x.stroke(); x.setLineDash([]);
      if (st.hover.y < TP + ph) {
        var hp = hi - (st.hover.y - TP) / ph * (hi - lo);
        x.fillStyle = C.muted; x.fillRect(pw + 2, st.hover.y - 7, AX - 4, 14); x.fillStyle = C.bg; x.textAlign = 'left'; x.fillText(fmtP(hp), pw + 6, st.hover.y + 0.5);
      }
    }
    $('readout').innerHTML = '<b>' + hhmm(ro.t) + '</b> A <b>' + fmtP(ro.o) + '</b> Máx <b>' + fmtP(ro.h) + '</b> Mín <b>' + fmtP(ro.l) + '</b> C <b>' + fmtP(ro.c) + '</b>' + (st.ind.vwap && I.vwap[hk] != null ? ' VWAP <b>' + fmtP(I.vwap[hk]) + '</b>' : '');
    $('follow').hidden = st.pan === 0;
  }

  function render() {
    if (!st.an || st.an.S.i < 0) return;
    syncManual(); layout(); renderNow(); renderTrade(); renderTutor(); renderLevels(); renderLog(); renderScore(); draw();
    var S = st.an.S; $('scrub').value = S.i + 1;
    $('back').disabled = S.i < 1; $('fwd').disabled = S.i + 1 >= st.day.bars.length;
  }

  /* ---------- eventos de la interfaz ---------- */
  function applyCfg(reload) {
    save(); st.ans = {}; var keep = st.an ? st.an.S.i + 1 : 0;
    if (reload && st.source === 'traderos') loadReal(keep); else if (st.day) openDay(925, keep);
  }
  function bind() {
    $('inst').value = st.ticker; $('tf').value = String(st.cfg.tf); $('date').value = iso(st.D); $('date').max = iso(lastSession() + 0);
    $('s_orb').value = String(st.cfg.orbMin); $('s_pd').value = st.cfg.pdMode; $('s_win').value = st.cfg.win; $('s_rr').value = String(st.cfg.rr);
    $('s_risk').value = st.cfg.maxRisk; $('s_buf').value = st.cfg.buf; $('s_fvg').value = st.cfg.minFvg; $('s_fail').value = st.cfg.failBars;
    $('s_asia').checked = !!st.cfg.asia; $('s_practice').checked = st.practice;
    $('s_vwap').value = st.cfg.vwapFrom || 'ses';
    $('s_vwap').onchange = function () { st.cfg.vwapFrom = this.value; st.I = null; save(); render(); };
    $('s_vp').value = st.cfg.vpFrom || 'ses'; $('s_vp').onchange = function () { st.cfg.vpFrom = this.value; st.I = null; save(); render(); };
    $('s_vpbin').value = String(st.cfg.vpBin); $('s_vpbin').onchange = function () { st.cfg.vpBin = +this.value; applyCfg(); };
    $('s_vplv').checked = st.cfg.vpLevels !== false; $('s_vplv').onchange = function () { st.cfg.vpLevels = this.checked; applyCfg(); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-ind]'), function (cb) {
      var k = cb.getAttribute('data-ind'); cb.checked = !!st.ind[k];
      cb.onchange = function () { st.ind[k] = this.checked; save(); render(); };
    });

    $('inst').onchange = function () { st.ticker = this.value; save(); if (st.source === 'csv') render(); else loadReal(); };
    $('date').onchange = function () {
      if (!this.value) return; var p = this.value.split('-'); st.D = Date.UTC(+p[0], +p[1] - 1, +p[2]); st.ans = {}; st.asked = true;
      if (st.source === 'csv') { setStatus(null); openDay(925); } else loadReal();
    };
    $('tf').onchange = function () { st.cfg.tf = +this.value; st.ans = {}; applyCfg(); };
    $('s_orb').onchange = function () { st.cfg.orbMin = +this.value; applyCfg(); };
    $('s_pd').onchange = function () { st.cfg.pdMode = this.value; applyCfg(true); };
    $('s_win').onchange = function () { st.cfg.win = this.value; applyCfg(); };
    $('s_rr').onchange = function () { st.cfg.rr = +this.value; applyCfg(); };
    function num(id, key, lo, hi) { $(id).onchange = function () { var v = +this.value; if (!isFinite(v)) return; st.cfg[key] = Math.max(lo, Math.min(hi, v)); this.value = st.cfg[key]; applyCfg(); }; }
    num('s_risk', 'maxRisk', 5, 400); num('s_buf', 'buf', 0, 20); num('s_fvg', 'minFvg', 1, 100); num('s_fail', 'failBars', 1, 10);
    $('s_asia').onchange = function () { st.cfg.asia = this.checked; applyCfg(); };
    $('s_practice').onchange = function () { st.practice = this.checked; if (!st.practice) st.pend = null; save(); render(); };
    $('csvFile').onchange = function () { if (this.files && this.files[0]) importCsv(this.files[0]); this.value = ''; };
    $('retry').onclick = function () { loadReal(); };

    $('play').onclick = toggle;
    ['m_sl', 'm_tp', 'm_loss', 'm_gain'].forEach(function (id) { $(id).oninput = applySizing; });
    $('m_qty').oninput = renderCalc;
    $('m_buy').onclick = function () { openManual(1); }; $('m_sell').onclick = function () { openManual(-1); };
    $('m_close').onclick = function () { var p = openPos(); if (!p) return; closeManual(p, curPrice(), 'manual', st.tick ? st.an.S.i + 1 : st.an.S.i, simNow()); msg(''); render(); };
    $('m_be').onclick = function () {
      var p = openPos(); if (!p) return;
      if ((curPrice() - p.entry) * p.dir <= 0) { msg('El precio todavía no está a favor de tu entrada: el stop no puede ir a la entrada.'); return; }
      p.stop = p.entry; msg(''); render();
    };
    function edit(inp, key) {
      var p = openPos(); if (!p) return; var v = inp.value === '' ? null : +inp.value, cur = curPrice();
      if (v != null && isFinite(v)) {
        var ok = key === 'stop' ? (cur - v) * p.dir > 0 : (v - cur) * p.dir > 0;
        if (!ok) { msg(key === 'stop' ? 'El stop debe quedar ' + (p.dir > 0 ? 'por debajo' : 'por encima') + ' del precio actual.' : 'El objetivo debe quedar ' + (p.dir > 0 ? 'por encima' : 'por debajo') + ' del precio actual.'); inp.blur(); render(); return; }
      }
      p[key] = v != null && isFinite(v) ? v : null; msg(''); inp.blur(); render();
    }
    $('m_slp').onchange = function () { edit(this, 'stop'); }; $('m_tpp').onchange = function () { edit(this, 'target'); };
    $('fwd').onclick = function () { stop(); stepFwd(); };
    $('back').onclick = stepBack; $('nextEv').onclick = nextEvent; $('prevEv').onclick = prevEvent;
    $('speed').onchange = function () { st.mode = this.value.charAt(0); st.rate = +this.value.slice(1); if (st.timer) { stop(); play(); } };
    $('jump').onchange = function () {
      if (this.value === '') return; var rel = +this.value, n = st.day.bars.length; stop();
      for (var i = 0; i < st.day.bars.length; i++) if ((st.day.bars[i].t - st.day.sessStart) / MIN >= rel) { n = i + 1; break; }
      this.value = ''; st.pan = 0; st.sel = null; rebuild(n);
    };
    $('scrub').oninput = function () { stop(); st.pan = 0; st.sel = null; rebuild(+this.value); };
    $('zin').onclick = function () { st.visN = Math.max(30, Math.round(st.visN * 0.75)); draw(); };
    $('zout').onclick = function () { st.visN = Math.min(900, Math.round(st.visN * 1.33)); draw(); };
    $('follow').onclick = function () { st.pan = 0; draw(); };

    $('tutor').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ans]'); if (!b || st.pend == null) return;
      st.ans[st.pend] = b.getAttribute('data-ans'); st.sel = st.pend; st.pend = null; render();
    });
    $('log').addEventListener('click', function (ev) {
      var li = ev.target.closest('[data-ev]'); if (!li) return; var id = +li.getAttribute('data-ev');
      if (st.pend === id) return; st.sel = st.sel === id ? null : id; render();
    });

    var cv = $('chart'), drag = null;
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    /* líneas de mi operación: se arrastran en el gráfico, como en TradingView */
    function yOf(p) { var g = st.geom; return g.TP + (g.hi - p) / (g.hi - g.lo) * g.ph; }
    function pOf(y) { var g = st.geom; return Math.round((g.hi - (y - g.TP) / g.ph * (g.hi - g.lo)) * 4) / 4; }
    function lineHit(p) {
      var tr = st.an && st.an.S.i >= 0 ? openPos() : null, g = st.geom;
      if (!tr || !g || g.lo == null || p.x > g.pw || p.y < g.TP - 4 || p.y > g.TP + g.ph + 4) return null;
      if (tr.stop != null && Math.abs(p.y - yOf(tr.stop)) <= 7) return 'stop';
      if (tr.target != null && Math.abs(p.y - yOf(tr.target)) <= 7) return 'target';
      if ((tr.stop == null || tr.target == null) && Math.abs(p.y - yOf(tr.entry)) <= 7) return 'new';
      return null;
    }
    function dragLine(y) {
      var tr = openPos(); if (!tr) { st.ldrag = null; render(); return; }
      var p = pOf(y), cur = curPrice(), k = st.ldrag.key;
      if (!k) {
        var side = (p - tr.entry) * tr.dir;
        if (side < 0 && tr.stop == null) k = 'stop'; else if (side > 0 && tr.target == null) k = 'target';
        if (!k) return; st.ldrag.key = k;
      }
      if (k === 'stop') { if ((cur - p) * tr.dir < 0.25) p = cur - tr.dir * 0.25; }      /* el stop no cruza el precio actual */
      else if ((p - cur) * tr.dir < 0.25) p = cur + tr.dir * 0.25;                       /* el objetivo tampoco */
      tr[k] = p; msg(''); renderTrade(); draw();
    }
    cv.addEventListener('pointerdown', function (e) {
      var p = pos(e), hit = lineHit(p);
      try { cv.setPointerCapture(e.pointerId); } catch (x) {}
      if (hit) { st.ldrag = { key: hit === 'new' ? null : hit, lo: st.geom.lo, hi: st.geom.hi }; e.preventDefault(); draw(); return; }
      drag = { x: e.clientX, pan: st.pan, moved: false };
    });
    cv.addEventListener('pointermove', function (e) {
      st.hover = pos(e);
      if (st.ldrag) { dragLine(st.hover.y); return; }
      cv.style.cursor = lineHit(st.hover) ? 'ns-resize' : 'crosshair';
      if (drag && st.geom) { var d = Math.round((e.clientX - drag.x) / st.geom.slot); if (d) drag.moved = true; st.pan = Math.max(0, drag.pan + d); }
      draw();
    });
    function endDrag(e) {
      if (st.ldrag) { st.ldrag = null; drag = null; render(); return; }
      var was = drag; drag = null; if (!e || (was && was.moved)) return;
      var p = pos(e); for (var i = st.hits.length - 1; i >= 0; i--) { var h = st.hits[i]; if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) { if (st.pend !== h.id) { st.sel = st.sel === h.id ? null : h.id; render(); } return; } }
    }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', function () { endDrag(null); });
    cv.addEventListener('pointerleave', function () { st.hover = null; draw(); });
    cv.addEventListener('wheel', function (e) { e.preventDefault(); st.visN = Math.max(30, Math.min(900, Math.round(st.visN * (e.deltaY > 0 ? 1.15 : 0.87)))); draw(); }, { passive: false });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stop(); stepFwd(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBack(); }
      else if (e.key === ' ') { if (tag === 'button') return; e.preventDefault(); toggle(); }
      else if (e.key === 'n' || e.key === 'N') nextEvent();
    });
    if (window.ResizeObserver) new ResizeObserver(function () { if (st.an && st.an.S.i >= 0) layout(); draw(); }).observe($('chartbox')); else window.addEventListener('resize', draw);
    function retheme() { col = null; draw(); }
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', retheme); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  }

  st.D = lastSession();
  bind();
  loadDemo();
  loadReal();
})();
