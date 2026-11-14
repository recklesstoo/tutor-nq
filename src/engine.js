/* Motor de análisis: procesa velas de 1 minuto en orden, sin mirar al futuro. */
(function (root) {
  'use strict';
  var MIN = 60000, DAY = 86400000, HOUR = 3600000;
  var DEF = { tf: 5, orbMin: 15, failBars: 3, rr: 2, maxRisk: 60, buf: 2, minFvg: 8,
              pdMode: 'rth', win: 'ny', zoneLife: 40, cool: 6, asia: true, vpBin: 5, vpLevels: true };
  var WIN = { ny: [930, 1320], lonny: [540, 1320], all: [0, 1375] };

  function fmtP(p) { return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtN(p) { return (Math.round(p * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function hhmm(t) { var d = new Date(t); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }

  /* Separa la sesión del día D (18:00 del día anterior a 17:00, hora de Nueva York) y calcula el día previo. */
  function prepareDay(all, D, cfgIn) {
    var cfg = Object.assign({}, DEF, cfgIn);
    var s0 = D - 6 * HOUR, s1 = D + 17 * HOUR, bars = [], i, b, P = null;
    for (i = 0; i < all.length; i++) { b = all[i]; if (b.t >= s0 && b.t < s1) bars.push(b); }
    for (i = all.length - 1; i >= 0; i--) {
      b = all[i]; if (b.t >= s0) continue;
      var d = Math.floor(b.t / DAY) * DAY, m = (b.t - d) / MIN;
      if (m >= 570 && m < 960) { P = d; break; }
    }
    var prior = null;
    if (P != null) {
      var a = cfg.pdMode === 'full' ? P - 6 * HOUR : P + 570 * MIN;
      var z = cfg.pdMode === 'full' ? P + 17 * HOUR : P + 960 * MIN;
      var hi = -Infinity, lo = Infinity, n = 0;
      for (i = 0; i < all.length; i++) { b = all[i]; if (b.t >= a && b.t < z) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; n++; } }
      if (n) {
        prior = { date: P, high: hi, low: lo, mode: cfg.pdMode };
        var sub = all.filter(function (q) { return q.t >= a && q.t < z; }), vp = profile(sub, 0, sub.length - 1, cfg.vpBin);
        if (vp) prior.vp = { poc: vp.poc, vah: vp.vah, val: vp.val };
      }
    }
    return { date: D, sessStart: s0, bars: bars, prior: prior };
  }

  /* Perfil de volumen estimado: el volumen de cada vela de 1 minuto se reparte parejo entre su mínimo y su máximo. */
  function profile(bars, i0, i1, bin) {
    var vol = {}, tot = 0, lo = Infinity, hi = -Infinity, i, k;
    for (i = i0; i <= i1; i++) {
      var b = bars[i], v = b.v || 0; if (!v) continue;
      var a = Math.floor(b.l / bin), z = Math.floor(b.h / bin), share = v / (z - a + 1);
      for (k = a; k <= z; k++) vol[k] = (vol[k] || 0) + share;
      if (a < lo) lo = a; if (z > hi) hi = z; tot += v;
    }
    if (!tot) return null;
    var poc = lo, max = 0; for (k = lo; k <= hi; k++) if ((vol[k] || 0) > max) { max = vol[k]; poc = k; }
    var up = poc, dn = poc, acc = max, goal = tot * 0.7;
    while (acc < goal && (up < hi || dn > lo)) {
      var vu = up < hi ? (vol[up + 1] || 0) : -1, vd = dn > lo ? (vol[dn - 1] || 0) : -1;
      if (vu >= vd) { up++; acc += vu; } else { dn--; acc += vd; }
    }
    return { bin: bin, vol: vol, lo: lo, hi: hi, max: max, total: tot, pocBin: poc, upBin: up, dnBin: dn,
             poc: (poc + 0.5) * bin, vah: (up + 1) * bin, val: dn * bin };
  }

  function create(day, cfgIn) {
    var cfg = Object.assign({}, DEF, cfgIn);
    var win = WIN[cfg.win] || WIN.ny;
    var S = { i: -1, bar: null, last: null, candles: [], cur: null, levels: [], zones: [], events: [], setups: [], open: null, rel: 0 };
    var tfTxt = cfg.tf >= 60 ? (cfg.tf / 60) + ' h' : cfg.tf + ' min';

    function addLevel(id, name, short, kind, hiSide, price, t, final) {
      var lv = { id: id, name: name, short: short, kind: kind, price: price, final: final, fromT: t, finalT: final ? t : null,
                 side: 0, defSide: hiSide ? -1 : 1, brk: null, lastK: -99 };
      S.levels.push(lv); return lv;
    }
    if (day.prior) {
      addLevel('pdh', 'máximo del día previo', 'PDH', 'prior', true, day.prior.high, day.sessStart, true);
      addLevel('pdl', 'mínimo del día previo', 'PDL', 'prior', false, day.prior.low, day.sessStart, true);
      if (cfg.vpLevels && day.prior.vp) {
        addLevel('pvah', 'VAH del día previo', 'pVAH', 'vp', true, day.prior.vp.vah, day.sessStart, true);
        addLevel('ppoc', 'POC del día previo', 'pPOC', 'vp', true, day.prior.vp.poc, day.sessStart, true);
        addLevel('pval', 'VAL del día previo', 'pVAL', 'vp', false, day.prior.vp.val, day.sessStart, true);
      }
    }
    var ranges = [
      { key: 'asia', a: 0, z: 540, on: cfg.asia, label: 'Asia', short: 'ASIA' },
      { key: 'lon', a: 540, z: 840, on: true, label: 'Londres', short: 'LON' },
      { key: 'orb', a: 930, z: 930 + cfg.orbMin, on: true, label: 'ORB', short: 'ORB' }
    ];

    function ev(type, code, K, title, what, why, plan) {
      var e = { id: S.events.length, i: S.i, t: S.bar.t, ct: K ? K.t : S.bar.t, type: type, code: code,
                title: title, what: what, why: why, plan: plan || '', dir: 0 };
      S.events.push(e); return e;
    }

    function signal(e, dir, entry, stop, stopWhy) {
      e.dir = dir; e.stopWhy = stopWhy;
      var risk = Math.abs(entry - stop);
      if (S.rel < win[0] || S.rel >= win[1]) { e.note = 'Ocurrió fuera de tu ventana de entradas: se anota, no se opera.'; return; }
      if (S.rel >= 930 && S.rel < 930 + cfg.orbMin) { e.note = 'El ORB todavía se está formando: se anota, no se opera.'; return; }
      if (S.open) {
        e.note = dir === S.open.dir ? 'Ya hay una operación abierta en esta dirección: no se suma otra.'
                                    : 'Señal contraria a la operación abierta: no se revierte, se respeta el stop.';
        return;
      }
      if (risk <= 0) return;
      if (risk > cfg.maxRisk) {
        e.note = 'El stop quedaría a ' + fmtN(risk) + ' pts, más que tu máximo de ' + fmtN(cfg.maxRisk) + ' pts. Se deja pasar.';
        e.skipped = { entry: entry, stop: stop, risk: risk }; return;
      }
      var su = { id: S.setups.length, dir: dir, entry: entry, stop: stop, target: entry + dir * cfg.rr * risk, risk: risk,
                 i: S.i, t: S.bar.t, ct: e.ct, status: 'open', ev: e.id };
      S.setups.push(su); S.open = su; e.setup = su.id;
    }

    function closeSetup(su, status, price, r) {
      su.status = status; su.exit = price; su.r = r; su.tExit = S.bar.t; su.iExit = S.i; S.open = null;
      var side = su.dir > 0 ? 'compra' : 'venta';
      var what = 'La ' + side + ' de las ' + hhmm(su.t) + ' en ' + fmtP(su.entry) + ' salió en ' + fmtP(price) + '.';
      var e;
      if (status === 'win') e = ev('RESULT', 'OK', null, 'Objetivo alcanzado: +' + fmtN(r) + 'R', what, 'Salida en el objetivo planificado, sin improvisar.');
      else if (status === 'loss') e = ev('RESULT', 'SL', null, 'Stop tocado: −1R', what, 'Una pérdida de 1R dentro del plan es parte del método. Lo que no puede pasar es mover el stop.');
      else e = ev('RESULT', 'FIN', null, 'Cierre por horario: ' + (r >= 0 ? '+' : '−') + fmtN(Math.abs(r)) + 'R', what, 'No se deja una operación abierta fuera de tu horario.');
      e.ofSetup = su.id; e.dir = su.dir; e.result = status;
    }

    function levelLogic(lv, K, k) {
      var p = lv.price, c = K.c, b = lv.brk, e;
      if (lv.side === 0) lv.side = lv.defSide;
      var prev = lv.side, cool = k - lv.lastK >= cfg.cool;
      var P = fmtP(p), nm = lv.name + ' (' + P + ')';
      function brkEvent(dir) {
        lv.brk = { dir: dir, k: k, ext: dir > 0 ? K.h : K.l, ret: false }; lv.lastK = k;
        e = ev('BRK', 'R', K, 'Rompimiento de ' + lv.short + (dir > 0 ? ' al alza' : ' a la baja'),
          'La vela de ' + tfTxt + ' cerró en ' + fmtP(c) + ', ' + (dir > 0 ? 'por encima' : 'por debajo') + ' del ' + nm + '.',
          'Un cierre fuera del nivel muestra intención, pero todavía no es entrada: muchos rompimientos se devuelven en las velas siguientes.',
          'Espera. Si el precio retestea ' + P + ' y lo sostiene, se busca ' + (dir > 0 ? 'compra' : 'venta') +
          '. Si en ' + cfg.failBars + ' velas vuelve a cerrar ' + (dir > 0 ? 'por debajo' : 'por encima') + ', es falso rompimiento y se busca ' + (dir > 0 ? 'venta' : 'compra') + '.');
        e.dir = dir; e.level = lv.id;
      }
      if (b) {
        b.ext = b.dir > 0 ? Math.max(b.ext, K.h) : Math.min(b.ext, K.l);
        var back = b.dir > 0 ? c < p : c > p;
        if (back) {
          var n = k - b.k;
          if (n <= cfg.failBars) {
            e = ev('FALSO', 'FR', K, 'Falso rompimiento de ' + lv.short,
              'Rompió el ' + nm + ' y ' + n + (n === 1 ? ' vela' : ' velas') + ' después cerró de vuelta ' + (b.dir > 0 ? 'por debajo' : 'por encima') +
              ', en ' + fmtP(c) + '. Extremo de la trampa: ' + fmtP(b.ext) + '.',
              'Quien entró en el rompimiento quedó atrapado, y sus stops alimentan el movimiento contrario.');
            e.level = lv.id; lv.brk = null; lv.lastK = k;
            signal(e, -b.dir, c, b.ext + b.dir * cfg.buf, 'más allá del extremo de la trampa');
          } else brkEvent(-b.dir);
        } else if (!b.ret && k > b.k && (b.dir > 0 ? K.l <= p + cfg.buf : K.h >= p - cfg.buf)) {
          b.ret = true; lv.lastK = k;
          e = ev('RET', 'RT', K, 'Retesteo de ' + lv.short + ' sostenido',
            'Después de romper, el precio volvió al ' + nm + ' y la vela cerró ' + (b.dir > 0 ? 'por encima' : 'por debajo') + ', en ' + fmtP(c) + '.',
            'El nivel roto cambió de función: lo que era ' + (b.dir > 0 ? 'resistencia ahora actúa como soporte' : 'soporte ahora actúa como resistencia') + '.');
          e.level = lv.id;
          signal(e, b.dir, c, (b.dir > 0 ? Math.min(K.l, p) : Math.max(K.h, p)) - b.dir * cfg.buf, 'al otro lado del nivel retesteado');
        }
      } else if (prev < 0) {
        if (c > p) brkEvent(1);
        else if (K.h > p && c < p && cool) {
          lv.lastK = k;
          e = ev('RECH', 'RZ', K, 'Rechazo en ' + lv.short,
            'El precio subió hasta ' + fmtP(K.h) + ', tocando el ' + nm + ', y la vela cerró de vuelta por debajo, en ' + fmtP(c) + '.',
            'Barrió la liquidez del nivel sin lograr aceptación arriba: es la señal típica de giro en un nivel clave.');
          e.level = lv.id; signal(e, -1, c, K.h + cfg.buf, 'por encima de la mecha que barrió el nivel');
        }
      } else if (prev > 0) {
        if (c < p) brkEvent(-1);
        else if (K.l < p && c > p && cool) {
          lv.lastK = k;
          e = ev('RECH', 'RZ', K, 'Rechazo en ' + lv.short,
            'El precio bajó hasta ' + fmtP(K.l) + ', tocando el ' + nm + ', y la vela cerró de vuelta por encima, en ' + fmtP(c) + '.',
            'Barrió la liquidez del nivel sin lograr aceptación abajo: es la señal típica de giro en un nivel clave.');
          e.level = lv.id; signal(e, 1, c, K.l - cfg.buf, 'por debajo de la mecha que barrió el nivel');
        }
      }
      if (c > p) lv.side = 1; else if (c < p) lv.side = -1;
    }

    function zoneLogic(K, k) {
      for (var j = 0; j < S.zones.length; j++) {
        var z = S.zones[j], c = K.c, e;
        if (z.dead || k <= z.k) continue;
        if (k - z.k > cfg.zoneLife) { z.dead = true; z.tEnd = K.t; continue; }
        var rng = fmtP(z.bot) + '–' + fmtP(z.top);
        if (!z.inv) {
          if (z.dir > 0 ? c < z.bot : c > z.top) {
            var was = z.dir > 0 ? 'alcista' : 'bajista';
            z.inv = true; z.kInv = k; z.tInv = K.t; z.dir = -z.dir;
            e = ev('IFVG', 'i', K, 'FVG invertido (iFVG)',
              'La vela cerró en ' + fmtP(c) + ', atravesando por completo el FVG ' + was + ' ' + rng + '.',
              'La zona que debía sostener falló. Ahora funciona al revés, como ' + (z.dir < 0 ? 'resistencia' : 'soporte') + '.',
              'Espera. Si el precio regresa a la zona desde ' + (z.dir < 0 ? 'abajo' : 'arriba') + ' y no la recupera, se busca ' + (z.dir < 0 ? 'venta' : 'compra') + '.');
            e.dir = z.dir; e.zone = z.id;
          } else if (!z.touched && (z.dir > 0 ? K.l <= z.top : K.h >= z.bot)) {
            z.touched = true;
            e = ev('FVGT', 'FVG', K, 'Regreso al FVG ' + (z.dir > 0 ? 'alcista' : 'bajista'),
              'El precio volvió a la zona ' + rng + ' y la vela cerró en ' + fmtP(c) + ' sin perderla.',
              'La zona se defendió en el primer regreso, que es el toque con mejor probabilidad.');
            e.zone = z.id; signal(e, z.dir, c, z.dir > 0 ? z.bot - cfg.buf : z.top + cfg.buf, 'al otro lado del FVG');
          }
        } else {
          if (z.dir < 0 ? c > z.top : c < z.bot) { z.dead = true; z.tEnd = K.t; }
          else if (!z.invTouched && k > z.kInv && (z.dir < 0 ? K.h >= z.bot : K.l <= z.top)) {
            z.invTouched = true;
            e = ev('IFVGR', 'iFVG', K, 'Retesteo del iFVG',
              'El precio regresó a la zona invertida ' + rng + ' y la vela cerró en ' + fmtP(c) + ' sin recuperarla.',
              'Confirma que la zona cambió de función.');
            e.zone = z.id; signal(e, z.dir, c, z.dir < 0 ? z.top + cfg.buf : z.bot - cfg.buf, 'al otro lado de la zona invertida');
          }
        }
      }
    }

    function fvgDetect(k) {
      if (k < 2 || S.rel < win[0] - 90 || S.rel >= win[1]) return;
      var A = S.candles[k - 2], B = S.candles[k - 1], K = S.candles[k];
      if (K.t - A.t !== 2 * cfg.tf * MIN) return;
      var dir = 0, bot, top;
      if (K.l - A.h >= cfg.minFvg) { dir = 1; bot = A.h; top = K.l; }
      else if (A.l - K.h >= cfg.minFvg) { dir = -1; bot = K.h; top = A.l; }
      if (!dir) return;
      var z = { id: S.zones.length, dir: dir, orig: dir, bot: bot, top: top, k: k, t0: B.t, inv: false, touched: false, dead: false };
      S.zones.push(z);
      var live = S.zones.filter(function (q) { return !q.dead; });
      if (live.length > 8) { live[0].dead = true; live[0].tEnd = K.t; }
      var e = ev('FVG', 'F', K, 'FVG ' + (dir > 0 ? 'alcista' : 'bajista') + ' de ' + fmtN(top - bot) + ' pts',
        'Quedó un hueco entre ' + fmtP(bot) + ' y ' + fmtP(top) + ' que el precio cruzó sin negociar.',
        'Marca desequilibrio: el precio suele regresar a rellenarlo antes de continuar.',
        'Espera. Si el precio regresa a la zona y la respeta, se busca ' + (dir > 0 ? 'compra' : 'venta') + '. Si una vela la cierra por completo, se invierte (iFVG).');
      e.dir = dir; e.zone = z.id;
    }

    function onClose(K) {
      var k = S.candles.length; K.k = k; S.candles.push(K);
      for (var j = 0; j < S.levels.length; j++) { var lv = S.levels[j]; if (lv.final && K.t >= lv.finalT) levelLogic(lv, K, k); }
      zoneLogic(K, k);
      fvgDetect(k);
    }

    function step() {
      if (S.i + 1 >= day.bars.length) return false;
      var bar = day.bars[++S.i]; S.bar = bar;
      var rel = Math.round((bar.t - day.sessStart) / MIN); S.rel = rel;
      var j, lv;
      if (S.i === 0) for (j = 0; j < S.levels.length; j++) { lv = S.levels[j]; lv.side = bar.o > lv.price ? 1 : bar.o < lv.price ? -1 : 0; }

      for (j = 0; j < ranges.length; j++) {
        var r = ranges[j]; if (!r.on || r.done) continue;
        if (rel >= r.a && rel < r.z) {
          if (!r.hi) {
            r.hi = addLevel(r.key + 'H', 'máximo de ' + (r.key === 'orb' ? 'la apertura (ORB)' : r.label), r.short + ' H', r.key, true, bar.h, bar.t, false);
            r.lo = addLevel(r.key + 'L', 'mínimo de ' + (r.key === 'orb' ? 'la apertura (ORB)' : r.label), r.short + ' L', r.key, false, bar.l, bar.t, false);
          } else { if (bar.h > r.hi.price) r.hi.price = bar.h; if (bar.l < r.lo.price) r.lo.price = bar.l; }
        } else if (rel >= r.z && r.hi) {
          r.done = true;
          [r.hi, r.lo].forEach(function (L) { L.final = true; L.finalT = bar.t; var c0 = S.last ? S.last.c : bar.o; L.side = c0 > L.price ? 1 : c0 < L.price ? -1 : 0; });
          var size = fmtN(r.hi.price - r.lo.price), e;
          if (r.key === 'orb') {
            e = ev('ORB', 'ORB', null, 'ORB de ' + cfg.orbMin + ' min definido',
              'El rango de apertura quedó entre ' + fmtP(r.lo.price) + ' y ' + fmtP(r.hi.price) + ' (' + size + ' pts).',
              'Un cierre fuera del rango marca la primera intención del día. Si falla y vuelve a entrar, suele buscar el lado contrario.',
              'Espera un cierre de vela de ' + tfTxt + ' fuera del rango. No anticipes dentro del rango.');
          } else {
            e = ev('NIVEL', r.short, null, 'Rango de ' + r.label + ' definido',
              r.label + ' dejó el máximo en ' + fmtP(r.hi.price) + ' y el mínimo en ' + fmtP(r.lo.price) + ' (' + size + ' pts).',
              'Por encima del máximo y por debajo del mínimo hay stops acumulados: es la liquidez que la sesión siguiente suele ir a buscar.',
              'No se entra aquí. Observa qué hace el precio cuando llegue a uno de los dos extremos.');
          }
          e.range = r.key;
        }
      }

      if (S.open && S.i > S.open.i) {
        var su = S.open, d = su.dir;
        var hitStop = d > 0 ? bar.l <= su.stop : bar.h >= su.stop;
        var hitTgt = d > 0 ? bar.h >= su.target : bar.l <= su.target;
        if (rel >= win[1]) closeSetup(su, 'flat', bar.o, (bar.o - su.entry) * d / su.risk);
        else if (hitStop) closeSetup(su, 'loss', su.stop, -1);      /* si stop y objetivo caen en la misma vela, cuenta el stop */
        else if (hitTgt) closeSetup(su, 'win', su.target, cfg.rr);
      }

      var bk = Math.floor(rel / cfg.tf), K;
      if (S.cur && S.cur.bk !== bk) { K = S.cur; S.cur = null; onClose(K); }
      if (!S.cur) S.cur = { bk: bk, t: day.sessStart + bk * cfg.tf * MIN, rel: bk * cfg.tf, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
      else { K = S.cur; if (bar.h > K.h) K.h = bar.h; if (bar.l < K.l) K.l = bar.l; K.c = bar.c; K.v += bar.v || 0; }
      if (rel % cfg.tf === cfg.tf - 1) { K = S.cur; S.cur = null; onClose(K); }
      S.last = bar;
      return true;
    }

    return { S: S, cfg: cfg, day: day, win: win, step: step };
  }

  /* Sesiones simuladas para el ejemplo inicial (generador con semilla fija). */
  function synth(D, seed) {
    var s = seed >>> 0;
    function rnd() { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    function gauss() { var u = 0; for (var i = 0; i < 4; i++) u += rnd(); return (u - 2) * 1.73; }
    function q(x) { return Math.round(x * 4) / 4; }
    var days = [], d = D;
    while (days.length < 6) { var wd = new Date(d).getUTCDay(); if (wd >= 1 && wd <= 5) days.unshift(d); d -= DAY; }
    var p = 28400, out = [];
    days.forEach(function (day) {
      var drift = 0;
      for (var rel = 0; rel < 1380; rel++) {
        var vol = rel < 540 ? 2.2 : rel < 840 ? 3.6 : rel < 930 ? 4.5 : rel < 990 ? 11 : rel < 1200 ? 7 : rel < 1320 ? 8 : 4;
        if (rel % 45 === 0) drift = gauss() * vol * 0.12;
        var o = p, c = o + drift + gauss() * vol;
        var h = Math.max(o, c) + Math.abs(gauss()) * vol * 0.5, l = Math.min(o, c) - Math.abs(gauss()) * vol * 0.5;
        p = q(c);
        out.push({ t: day - 6 * HOUR + rel * MIN, o: q(o), h: q(h), l: q(l), c: p, v: Math.round(vol * 40 * (0.5 + rnd())) });
      }
    });
    return out;
  }

  var api = { DEF: DEF, WIN: WIN, MIN: MIN, DAY: DAY, HOUR: HOUR, create: create, prepareDay: prepareDay, profile: profile, synth: synth, hhmm: hhmm, fmtP: fmtP, fmtN: fmtN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : this);
