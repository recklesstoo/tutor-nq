const E = require('../src/engine.js');
const assert = require('assert');
const { MIN, DAY, HOUR } = E;
const D = Date.UTC(2026, 10, 12), P = D - DAY;

// --- escenario construido a mano: ORB, rompimiento, falso rompimiento, objetivo ---
function flat(t0, n, p, w) { const o = []; for (let i = 0; i < n; i++) o.push({ t: t0 + i * MIN, o: p, h: p + w, l: p - w, c: p, v: 1 }); return o; }
let all = [];
// día previo: RTH con máximo 200 y mínimo 100
all = all.concat(flat(P + 570 * MIN, 100, 150, 1));
all.push({ t: P + 670 * MIN, o: 150, h: 200, l: 100, c: 150, v: 1 });
// sesión de D: noche plana en 150
const s0 = D - 6 * HOUR;
all = all.concat(flat(s0, 930, 150, 1));                       // 18:00 → 09:29
all = all.concat(flat(s0 + 930 * MIN, 15, 155, 5));            // ORB 09:30–09:44 : 150–160
all = all.concat(flat(s0 + 945 * MIN, 4, 163, 2));             // 09:45–09:48
all.push({ t: s0 + 949 * MIN, o: 163, h: 166, l: 162, c: 165, v: 1 }); // cierra 165 > 160
all = all.concat(flat(s0 + 950 * MIN, 4, 158, 1));
all.push({ t: s0 + 954 * MIN, o: 158, h: 158, l: 154, c: 155, v: 1 }); // cierra 155 < 160 → falso
for (let i = 0; i < 40; i++) { const p = 154 - i; all.push({ t: s0 + (955 + i) * MIN, o: p + 1, h: p + 1, l: p, c: p, v: 1 }); }
all.sort((a, b) => a.t - b.t);

const cfg = { tf: 5, orbMin: 15, failBars: 3, rr: 2, maxRisk: 60, buf: 2, minFvg: 8, vpLevels: false };
const day = E.prepareDay(all, D, cfg);
assert.deepStrictEqual([day.prior.high, day.prior.low], [200, 100], 'día previo');
const an = E.create(day, cfg);
while (an.step());
const S = an.S;
const types = S.events.map(e => e.type + ':' + (e.level || e.range || ''));
console.log(S.events.map(e => E.hhmm(e.t) + ' ' + e.type + ' ' + e.title + (e.note ? ' [' + e.note + ']' : '')).join('\n'));
const orbH = S.levels.find(l => l.id === 'orbH'), orbL = S.levels.find(l => l.id === 'orbL');
assert.deepStrictEqual([orbH.price, orbL.price], [160, 150], 'ORB');
assert.ok(types.includes('ORB:orb'), 'evento ORB');
assert.ok(types.includes('BRK:orbH'), 'rompimiento ORB H');
const fr = S.events.find(e => e.type === 'FALSO' && e.level === 'orbH');
assert.ok(fr, 'falso rompimiento ORB H');
const su = S.setups[fr.setup];
assert.ok(su, 'el falso rompimiento genera operación');
assert.deepStrictEqual([su.dir, su.entry, su.stop, su.target], [-1, 155, 168, 129], 'entrada/stop/objetivo');
assert.strictEqual(su.status, 'win'); assert.strictEqual(su.exit, 129);

// --- perfil de volumen ---
{
  const b = [{ l: 100, h: 104.75, v: 10 }, { l: 100, h: 104.75, v: 10 }, { l: 105, h: 109.75, v: 50 }, { l: 110, h: 114.75, v: 5 }, { l: 95, h: 99.75, v: 5 }];
  const vp = E.profile(b, 0, b.length - 1, 5);
  assert.strictEqual(vp.total, 80); assert.strictEqual(vp.poc, 107.5);
  assert.deepStrictEqual([vp.val, vp.vah], [100, 110], 'área de valor 70%');
  assert.strictEqual(E.profile([{ l: 1, h: 2, v: 0 }], 0, 0, 5), null);
}
// --- datos simulados: invariantes ---
for (const seed of [7, 11, 2026, 99]) for (const tf of [1, 5, 15]) {
  const bars = E.synth(D, seed), c = { tf, win: 'lonny' };
  const d = E.prepareDay(bars, D, c);
  assert.strictEqual(d.bars.length, 1380); assert.ok(d.prior && d.prior.vp && d.prior.vp.val <= d.prior.vp.poc && d.prior.vp.poc <= d.prior.vp.vah);
  const a = E.create(d, c); while (a.step());
  const ev = a.S.events;
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].i >= ev[i - 1].i, 'orden');
  for (const s of a.S.setups) {
    assert.ok(s.risk > 0 && s.risk <= a.cfg.maxRisk, 'riesgo dentro del máximo');
    assert.ok(s.status !== 'open', 'ninguna operación queda abierta');
    assert.ok((s.stop - s.entry) * s.dir < 0 && (s.target - s.entry) * s.dir > 0, 'stop y objetivo del lado correcto');
    if (s.status === 'win') assert.strictEqual(s.r, a.cfg.rr);
    if (s.status === 'loss') assert.strictEqual(s.r, -1);
    assert.ok(s.iExit > s.i);
  }
  // sin mirar al futuro: una corrida parcial produce el mismo prefijo de eventos
  for (const n of [400, 950, 1100]) {
    const b = E.create(d, c); for (let i = 0; i < n; i++) b.step();
    const full = ev.filter(e => e.i < n).map(e => e.i + e.type + e.title + e.what);
    assert.deepStrictEqual(b.S.events.map(e => e.i + e.type + e.title + e.what), full, 'prefijo');
  }
  const cnt = {}; ev.forEach(e => cnt[e.type] = (cnt[e.type] || 0) + 1);
  const R = a.S.setups.reduce((x, s) => x + s.r, 0);
  console.log('seed', seed, 'tf', tf, JSON.stringify(cnt), 'ops', a.S.setups.length, 'R', R.toFixed(2));
}
console.log('OK');
