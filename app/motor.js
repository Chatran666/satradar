// Motor de cálculo (Web Worker): órbitas SGP4, sombra terrestre, brillo y pases.
importScripts('lib/satellite.js', 'astro.js');
const S = self.satellite;
const DEG = 180 / Math.PI;
const RE = 6378.137;
const MU = 398600.4418;
const PASO_PASE = 10000; // ms entre puntos del trayecto
const PASO_PROX = 60000; // ms entre muestras en la búsqueda de próximos pases

// ---------- Brillo propio ----------
// Escala usada acá: magnitud a 1000 km con 90° de fase (brillo "promedio").
// Las magnitudes de McCants (quicksat.mag) están a fase llena y en la mejor
// orientación: se pasan a esta escala sumando OFFSET_QS (ver intrmagdef de McCants).
const OFFSET_QS = 1.0;

// Familias conocidas, para objetos que no están en el archivo de McCants.
// [patrón, magnitud, escala] escala 'qs' = como McCants; 'directa' = ya en esta escala
const TABLA_MAG = [
  [/^ISS \(ZARYA\)/, -2.5, 'qs'],
  [/^CSS \(TIANHE\)/, -1.5, 'qs'],
  [/^HST$/, 1.5, 'qs'],
  [/^SPACEMOBILE|^BLUEBIRD/, 2.0, 'qs'],
  [/^SL-16 R\/B/, 2.0, 'qs'],
  [/^SL-3 R\/B/, 3.5, 'qs'],
  [/^SL-4 R\/B/, 3.5, 'qs'],
  [/^SL-12 R\/B/, 3.5, 'qs'],
  [/^SL-14 R\/B/, 4.0, 'qs'],
  [/^SL-8 R\/B/, 4.0, 'qs'],
  [/^SL-6 R\/B/, 4.0, 'qs'],
  [/^CZ-2[CD] R\/B/, 3.0, 'qs'],
  [/^CZ-4[BC] R\/B/, 3.5, 'qs'],
  [/^CZ-\d.* R\/B/, 3.0, 'qs'],
  [/^H-2A R\/B/, 2.5, 'qs'],
  [/^ARIANE 5 R\/B/, 2.5, 'qs'],
  [/^ARIANE 4.* R\/B/, 3.0, 'qs'],
  [/^TITAN 4B R\/B/, 2.0, 'qs'],
  [/^DELTA [12] R\/B/, 3.5, 'qs'],
  [/^FALCON 9 R\/B/, 3.0, 'qs'],
  [/^STARLINK/, 6.0, 'directa'],
  [/^KUIPER/, 6.0, 'directa'],
  [/^QIANFAN|^G60|^GUOWANG|^SATNET/, 6.5, 'directa'],
  [/^IRIDIUM|^GLOBALSTAR/, 6.0, 'directa'],
  [/^ONEWEB/, 7.5, 'directa'],
];

// Ajustes calculados comparando 4.163 magnitudes de McCants con tamaños reales
let fuentesBrillo = { mccants: {}, gcat: {}, rcs: {} };

function magEstandar(id, nombre, enListaBrillantes) {
  const qs = fuentesBrillo.mccants[id];
  if (qs !== undefined) return { std: qs + OFFSET_QS, src: 'mccants' };
  for (const [re, m, esc] of TABLA_MAG) {
    if (re.test(nombre.toUpperCase())) return { std: esc === 'qs' ? m + OFFSET_QS : m, src: esc === 'qs' ? 'familia' : 'estimado' };
  }
  const dim = fuentesBrillo.gcat[id];
  if (dim) {
    const [L, D, S] = dim;
    const area = L * D + (S > D ? (S - D) * Math.min(L, 2) * 0.5 : 0);
    return { std: 7.5 - 1.95 * Math.log10(Math.max(area, 0.01)), src: 'gcat' };
  }
  const rcs = fuentesBrillo.rcs[id];
  if (rcs > 0) return { std: 7.3 - 2.5 * Math.log10(rcs), src: 'radar' };
  if (enListaBrillantes) return { std: 4.5, src: 'lista' };
  return { std: 7.5, src: 'estimado' };
}

// ---------- Estado ----------
let sats = []; // {id, nombre, rec, std, src, perigeo, starlink}
let candidatos = [];
let porId = new Map();
let obs = { lat: -34.6037, lon: -58.3816, alt: 0.02 };
let obsGd = null;
let obsEcf = null;
let cfg = { nelm: 4.4, minEl: 10, solMax: -6, starlink: true, alTerminar: 'gris', nubes: null };
// nubes: { manual: número | null, horas: { [horaUnix]: penalización } }
let pases = new Map(); // id -> pase
let arriba = new Set(); // ids sobre el horizonte
let ultimoBarrido = null;
let ctxCache = new Map();
let prox = { generacion: 0, desde: 0, hasta: 0, lista: [], listo: false };

function setObs(o) {
  obs = o;
  obsGd = { latitude: o.lat / DEG, longitude: o.lon / DEG, height: o.alt || 0 };
  obsEcf = S.geodeticToEcf(obsGd);
}
setObs(obs);

// Magnitud límite para satélites en este momento (cielo, crepúsculo, Luna)
function penNubes(t) {
  const n = cfg.nubes;
  if (!n) return 0;
  if (n.manual != null) return n.manual;
  const h = n.horas && n.horas[Math.floor(t / 3600000)];
  return h == null ? 0 : h;
}

function limiteActual(solEl, lunaEl, lunaIlum, t) {
  let lim = cfg.nelm - 0.5; // objeto en movimiento: un poco más exigente
  lim -= penNubes(t);
  if (solEl > -12) lim -= Math.min(1.5, ((solEl + 12) / 6) * 1.5);
  if (lunaEl > 0) lim -= 1.2 * lunaIlum * Math.min(1, (lunaEl + 2) / 30);
  return lim;
}

function look(eci, gmst) {
  const la = S.ecfToLookAngles(obsGd, S.eciToEcf(eci, gmst));
  return { az: la.azimuth * DEG, el: la.elevation * DEG, range: la.rangeSat };
}

function contexto(t, sinCache) {
  let c = sinCache ? null : ctxCache.get(t);
  if (c) return c;
  const date = new Date(t);
  const gmst = S.gstime(date);
  const sol = Astro.sunEci(date);
  const ns = Math.hypot(sol.x, sol.y, sol.z);
  const solHat = { x: sol.x / ns, y: sol.y / ns, z: sol.z / ns };
  const solL = look(sol, gmst);
  const luna = Astro.moonEci(date);
  const lunaL = look(luna, gmst);
  const fase = Astro.moonPhase(date);
  const obsEci = S.ecfToEci(obsEcf, gmst);
  c = {
    t, date, gmst, sol, solHat, obsEci,
    solEl: solL.el, solAz: solL.az,
    lunaEl: lunaL.el, lunaAz: lunaL.az, lunaIlum: fase.illum, creciente: fase.waxing,
    oscuro: solL.el <= cfg.solMax,
    nubes: penNubes(t),
    limite: limiteActual(solL.el, lunaL.el, fase.illum, t),
  };
  if (sinCache) return c;
  if (ctxCache.size > 4000) ctxCache.clear();
  ctxCache.set(t, c);
  return c;
}

// Evalúa un satélite en un instante. Devuelve null si no se pudo propagar.
function evaluar(s, c, completo) {
  const pv = S.propagate(s.rec, c.date);
  if (!pv || !pv.position || isNaN(pv.position.x)) return null;
  const r = pv.position;
  const la = look(r, c.gmst);
  if (la.el <= 0 && !completo) return la;
  // ¿Le da el sol? (sombra cilíndrica de la Tierra)
  const proy = r.x * c.solHat.x + r.y * c.solHat.y + r.z * c.solHat.z;
  let iluminado = true;
  if (proy < 0) {
    const px = r.x - proy * c.solHat.x, py = r.y - proy * c.solHat.y, pz = r.z - proy * c.solHat.z;
    iluminado = Math.hypot(px, py, pz) > RE;
  }
  // Ángulo de fase en el satélite (Sol - satélite - observador)
  const ax = c.sol.x - r.x, ay = c.sol.y - r.y, az = c.sol.z - r.z;
  const bx = c.obsEci.x - r.x, by = c.obsEci.y - r.y, bz = c.obsEci.z - r.z;
  const cosF = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
  const frac = Math.max(0.005, (1 + cosF) / 2);
  let mag = s.std - 15.75 + 2.5 * Math.log10((la.range * la.range) / frac);
  // Extinción atmosférica cerca del horizonte
  if (la.el > 0) {
    const se = Math.sin(la.el / DEG);
    const masa = 1 / (se + 0.025 * Math.exp(-11 * se));
    mag += 0.25 * (masa - 1);
  }
  const visible = c.oscuro && la.el >= cfg.minEl && iluminado && mag <= c.limite;
  const alt = Math.hypot(r.x, r.y, r.z) - RE;
  return { az: la.az, el: la.el, range: la.range, iluminado, mag, visible, alt };
}

// ---------- Carga de datos ----------
function cargar(m) {
  fuentesBrillo = { mccants: m.mccants || {}, gcat: m.gcat || {}, rcs: m.rcs || {} };
  const lista = new Set((m.brillantes || []).map(Number));
  const vistos = new Set();
  sats = [];
  let k = 0;
  const total = m.orbitas.length;
  // Lanzamiento más reciente de los datos (para detectar trenes recién lanzados)
  const codigo = (o) => {
    const x = /^(\d{4})-(\d{3})/.exec(String(o.OBJECT_ID || ''));
    return x ? +x[1] * 1000 + +x[2] : 0;
  };
  let ultimoLanz = 0;
  for (const o of m.orbitas) { const c = codigo(o); if (c > ultimoLanz) ultimoLanz = c; }
  for (const o of m.orbitas) {
    if (++k % 1500 === 0) self.postMessage({ tipo: 'progreso-carga', valor: k / total });
    const id = +o.NORAD_CAT_ID;
    if (vistos.has(id)) continue;
    vistos.add(id);
    let rec;
    try {
      rec = S.json2satrec(o);
    } catch (e) {
      continue;
    }
    if (!rec || rec.error) continue;
    const n = (o.MEAN_MOTION * 2 * Math.PI) / 86400;
    const a = Math.cbrt(MU / (n * n));
    const perigeo = a * (1 - o.ECCENTRICITY) - RE;
    const nombre = String(o.OBJECT_NAME || id).trim();
    let mg = magEstandar(id, nombre, lista.has(id));
    const starlink = /^STARLINK/i.test(nombre);
    const apogeo = a * (1 + o.ECCENTRICITY) - RE;
    // Tren de Starlink: lanzados hace poco, todavía bajos y en fila (mucho más brillantes)
    // ~20 lanzamientos ≈ el último mes; todavía por debajo de 450 km = subiendo en fila
    const tren = starlink && apogeo < 450 && codigo(o) >= ultimoLanz - 20;
    if (tren) mg = { std: 4.5, src: 'tren' };
    sats.push({ id, nombre, rec, std: mg.std, src: mg.src, perigeo, starlink, tren, orb: o._fuente || '',
      rApo: apogeo + RE, wSat: n });
  }
  elegirCandidatos();
}

// Solo vale la pena seguir los que en el mejor caso (pasando por el cenit,
// totalmente iluminados) podrían llegar al límite del cielo.
function elegirCandidatos() {
  const mejorLimite = cfg.nelm - 0.5;
  candidatos = sats.filter((s) => {
    if (!cfg.starlink && s.starlink && !s.tren) return false;
    if (s.perigeo > 8000 || s.perigeo < 100) return false;
    const minMag = s.std - 15.75 + 2.5 * Math.log10(s.perigeo * s.perigeo);
    return minMag <= mejorLimite;
  });
  porId = new Map(candidatos.map((s) => [s.id, s]));
  pases.clear();
  arriba.clear();
  ultimoBarrido = null;
  ctxCache.clear();
}

// ---------- Pase actual de un satélite ----------
function calcularPase(s, t) {
  const t0 = Math.floor(t / PASO_PASE) * PASO_PASE;
  let ini = t0;
  for (let i = 0; i < 200; i++) {
    const e = evaluar(s, contexto(ini - PASO_PASE), false);
    if (!e || e.el <= 0) break;
    ini -= PASO_PASE;
  }
  const pts = [];
  let tt = ini;
  let algunoVisible = false;
  for (let i = 0; i < 400; i++) {
    const e = evaluar(s, contexto(tt), true);
    if (!e) break;
    pts.push({ t: tt, az: e.az, el: e.el, v: e.visible, m: e.mag == null ? null : Math.round(e.mag * 10) / 10 });
    if (e.visible) algunoVisible = true;
    if (e.el <= 0 && i > 0) break;
    tt += PASO_PASE;
  }
  return { ini, fin: tt, pts, algunoVisible };
}

function paseVigente(s, t) {
  const p = pases.get(s.id);
  if (p && t >= p.ini - PASO_PASE && t <= p.fin + PASO_PASE) return p;
  const n = calcularPase(s, t);
  pases.set(s.id, n);
  return n;
}

// ---------- Tic en tiempo real ----------
function tic(t) {
  const c = contexto(t);
  const barrido = ultimoBarrido === null || Math.abs(t - ultimoBarrido) > 15000;
  if (barrido) {
    arriba.clear();
    for (const s of candidatos) {
      const e = evaluar(s, c, false);
      if (e && e.el > 0) arriba.add(s.id);
    }
    ultimoBarrido = t;
    // Liberar pases de satélites que ya no están arriba
    for (const id of pases.keys()) if (!arriba.has(id)) pases.delete(id);
  }
  const items = [];
  for (const id of arriba) {
    const s = porId.get(id);
    if (!s) continue;
    const e = evaluar(s, c, true);
    if (!e || e.el <= 0) continue;
    const p = paseVigente(s, t);
    if (!p.algunoVisible) continue; // nunca alcanza brillo suficiente: no se muestra
    let estado;
    if (e.visible) estado = 'visible';
    else if (p.pts.some((q) => q.v && q.t > t)) estado = 'pendiente';
    else estado = 'terminado';
    if (estado === 'terminado' && cfg.alTerminar === 'ocultar') continue;
    items.push({
      id, nombre: s.nombre, std: s.std, src: s.src, orb: s.orb, tren: s.tren,
      az: e.az, el: e.el, mag: e.mag, range: e.range, alt: e.alt, iluminado: e.iluminado,
      estado, ini: p.ini, fin: p.fin, pts: p.pts,
    });
  }
  self.postMessage({
    tipo: 'estado', t,
    sol: { az: c.solAz, el: c.solEl },
    luna: { az: c.lunaAz, el: c.lunaEl, ilum: c.lunaIlum, creciente: c.creciente },
    oscuro: c.oscuro, limite: c.limite, penNubes: c.nubes,
    cargados: sats.length, candidatos: candidatos.length, arriba: arriba.size,
    items,
    radio: radioEstado(t),
  });
  // Próximos pases: recalcular si la ventana quedó atrás
  if (!prox.calculando && (t < prox.desde - 60000 || t > prox.desde + 30 * 60000)) buscarProximos(t);
  // Planificador: después de los próximos pases, cada 6 h o si se saltó el tiempo
  else if (!prox.calculando && !noches.calculando && (t < noches.desde - 3600000 || t > noches.desde + 6 * 3600000)) planificarNoches(t);
}

// ---------- Próximos pases visibles (próximas 3 horas, en segundo plano) ----------

// ---------- Búsqueda exacta de pases ----------
// Basado en la idea de Watched (Armaan Gupta, licencia MIT): el ángulo entre el satélite y el
// observador, visto desde el centro de la Tierra, no puede cambiar más rápido que la velocidad
// orbital más la rotación terrestre. Si el satélite está lejos del "cono" donde podría verse,
// se puede saltar en el tiempo sin riesgo de perder un pase; cerca, se revisa fino y los bordes
// se ajustan al segundo.
const PASO_FINO = 10000;

function obsEciEn(gmst) {
  return S.ecfToEci(obsEcf, gmst);
}

// Ángulo geocéntrico satélite–observador (rad) y radio del satélite (km)
function anguloGeo(s, t) {
  const date = new Date(t);
  const pv = S.propagate(s.rec, date);
  if (!pv || !pv.position || isNaN(pv.position.x)) return null;
  const r = pv.position;
  const o = obsEciEn(S.gstime(date));
  const nr = Math.hypot(r.x, r.y, r.z), no = Math.hypot(o.x, o.y, o.z);
  const c = (r.x * o.x + r.y * o.y + r.z * o.z) / (nr * no);
  return { lam: Math.acos(Math.max(-1, Math.min(1, c))), r: nr };
}

// Mayor ángulo geocéntrico desde el que se lo ve a "minEl" grados de elevación
function anguloMaximo(rSat, minElGrados) {
  const e = minElGrados / DEG;
  return Math.acos(Math.min(1, (RE / rSat) * Math.cos(e))) - e;
}

// Intervalos [a, b] dentro de [desde, hasta] en que el Sol está bajo (noche útil)
function intervalosOscuros(desde, hasta) {
  const solEl = (t) => { const d = new Date(t); return look(Astro.sunEci(d), S.gstime(d)).el; };
  const oscuro = (t) => solEl(t) <= cfg.solMax;
  const out = [];
  let ini = oscuro(desde) ? desde : null;
  let prev = desde;
  for (let t = desde + 60000; t <= hasta + 60000; t += 60000) {
    const tt = Math.min(t, hasta);
    const o = oscuro(tt);
    if (o && ini === null) ini = bisecar((x) => oscuro(x), prev, tt, false);
    if (!o && ini !== null) { out.push([ini, bisecar((x) => oscuro(x), prev, tt, true)]); ini = null; }
    prev = tt;
    if (tt >= hasta) break;
  }
  if (ini !== null) out.push([ini, hasta]);
  return out;
}

// Momento (al segundo) en que pred cambia entre a y b. siEra=true: era verdadero en a.
function bisecar(pred, a, b, siEra) {
  while (b - a > 1000) {
    const m = Math.round((a + b) / 2);
    if (pred(m) === siEra) a = m; else b = m;
  }
  return siEra ? a : b;
}

// Busca pases en [desde, hasta] donde "cumple(s, t)" devuelve { ok, el, az, mag }.
// minEl: elevación mínima geométrica que exige cumple (para el salto seguro).
function buscarPasesExactos(s, intervalos, minEl, cumple) {
  const pases = [];
  const lamMax = anguloMaximo(s.rApo || RE + 2000, minEl) + 0.003;
  const vel = (s.wSat || 0.0011) + OMEGA; // rad/s
  for (const [a, b] of intervalos) {
    let t = a;
    let previo = null; // { t, ok }
    let pase = null;
    while (t <= b) {
      const g = anguloGeo(s, t);
      if (!g) break;
      if (g.lam > lamMax) {
        // Lejos: imposible que se vea antes de este salto
        if (pase) { cerrarPase(pase, previo.t, t, s, cumple, pases); pase = null; }
        previo = null;
        t += Math.max(5000, ((g.lam - lamMax) / vel) * 1000 * 0.85);
        continue;
      }
      const c = cumple(s, t);
      if (c.ok) {
        if (!pase) {
          const ini = previo && !previo.ok ? bisecar((x) => cumple(s, x).ok, previo.t, t, false) : t;
          pase = { ini, mejorMag: c.mag, muestras: [] };
        }
        pase.muestras.push({ t, el: c.el, az: c.az, mag: c.mag });
        if (c.mag < pase.mejorMag) pase.mejorMag = c.mag;
      } else if (pase) {
        cerrarPase(pase, previo.t, t, s, cumple, pases);
        pase = null;
      }
      previo = { t, ok: c.ok };
      t += PASO_FINO;
    }
    if (pase) cerrarPase(pase, previo ? previo.t : b, null, s, cumple, pases, b);
  }
  return pases;
}

function cerrarPase(pase, ultimoOk, siguiente, s, cumple, pases, limite) {
  const fin = siguiente != null ? bisecar((x) => cumple(s, x).ok, ultimoOk, siguiente, true) : (limite || ultimoOk);
  // Punto más alto: sección áurea alrededor de la mejor muestra
  let mejor = pase.muestras.reduce((m, q) => (q.el > m.el ? q : m), pase.muestras[0]);
  let lo = Math.max(pase.ini, mejor.t - PASO_FINO), hi = Math.min(fin, mejor.t + PASO_FINO);
  const elEn = (t) => { const c = cumple(s, t); return c.el; };
  const phi = 0.6180339887;
  let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo), f1 = elEn(x1), f2 = elEn(x2);
  for (let k = 0; k < 14 && hi - lo > 1000; k++) {
    if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = elEn(x2); }
    else { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = elEn(x1); }
  }
  const tMax = Math.round((lo + hi) / 2);
  const cMax = cumple(s, tMax), cIni = cumple(s, pase.ini), cFin = cumple(s, fin);
  pases.push({
    id: s.id, nombre: s.nombre, ini: pase.ini, fin,
    azIni: cIni.az, elIni: cIni.el, azFin: cFin.az, elFin: cFin.el,
    tMax, maxEl: Math.max(cMax.el, mejor.el), azMax: cMax.el >= mejor.el ? cMax.az : mejor.az,
    mag: Math.min(pase.mejorMag, cMax.mag ?? Infinity, cIni.mag ?? Infinity, cFin.mag ?? Infinity),
    src: s.src, tren: s.tren,
  });
}

// Condición "visible a ojo desnudo" en un instante
function visibleEn(s, t) {
  const c = contexto(t, true);
  const e = evaluar(s, c, false);
  if (!e || e.el < cfg.minEl) return { ok: false, el: e ? e.el : -90, az: e ? e.az : 0 };
  const f = evaluar(s, c, true);
  return { ok: !!f.visible, el: f.el, az: f.az, mag: f.mag };
}

function buscarProximos(desde) {
  const gen = ++prox.generacion;
  prox.calculando = true;
  prox.desde = desde;
  const intervalos = intervalosOscuros(desde, desde + 3 * 3600000);
  const lista = [];
  let i = 0;
  const lote = 300;
  self.postMessage({ tipo: 'progreso', valor: 0 });
  function trabajar() {
    if (gen !== prox.generacion) return;
    const finLote = Math.min(i + lote, candidatos.length);
    for (; i < finLote; i++) {
      if (!intervalos.length) { i = candidatos.length; break; }
      for (const p of buscarPasesExactos(candidatos[i], intervalos, cfg.minEl, visibleEn)) lista.push(p);
    }
    self.postMessage({ tipo: 'progreso', valor: candidatos.length ? i / candidatos.length : 1 });
    if (i < candidatos.length) setTimeout(trabajar, 0);
    else {
      lista.sort((a, b) => a.ini - b.ini);
      prox.calculando = false;
      self.postMessage({ tipo: 'proximos', desde, lista });
    }
  }
  setTimeout(trabajar, 0);
}

// ---------- Planificador: pases visibles de las próximas 7 noches ----------
const PASO_NOCHES = 120000;
let noches = { generacion: 0, desde: 0, calculando: false };
function planificarNoches(desde) {
  const gen = ++noches.generacion;
  noches.calculando = true;
  noches.desde = desde;
  const intervalos = intervalosOscuros(desde, desde + 7 * 86400000);
  // Solo los que pueden verse bien (sin la nube de Starlink comunes, salvo trenes)
  const lim = cfg.nelm - 0.5;
  const grupo = candidatos.filter((s) => (!s.starlink || s.tren) && s.std - 15.75 + 2.5 * Math.log10(s.perigeo * s.perigeo) <= lim - 0.3);
  const lista = [];
  let i = 0;
  function trabajar() {
    if (gen !== noches.generacion) return;
    const finLote = Math.min(i + 40, grupo.length);
    for (; i < finLote; i++) {
      for (const p of buscarPasesExactos(grupo[i], intervalos, cfg.minEl, visibleEn)) {
        p.nubes = penNubes(p.ini);
        lista.push(p);
      }
    }
    self.postMessage({ tipo: 'progreso-noches', valor: grupo.length ? i / grupo.length : 1 });
    if (i < grupo.length) setTimeout(trabajar, 0);
    else {
      lista.sort((a, b) => a.ini - b.ini);
      noches.calculando = false;
      self.postMessage({ tipo: 'noches', desde, lista });
    }
  }
  setTimeout(trabajar, 0);
}

// ---------- Radio: satélites con transmisores (SatNOGS) ----------
const OMEGA = 7.292115e-5; // rotación terrestre, rad/s
let radioSats = [];
let radioArriba = new Set();
let radioFin = new Map();
let radioUltimo = null;
let radioActivo = false;

function setRadio(transmisores) {
  const ids = new Set(Object.keys(transmisores || {}).map(Number));
  radioSats = sats.filter((s) => ids.has(s.id));
  radioArriba.clear(); radioFin.clear(); radioUltimo = null;
}

// Azimut, elevación, distancia y velocidad radial (km/s, + se aleja)
function radioEval(s, c) {
  const pv = S.propagate(s.rec, c.date);
  if (!pv || !pv.position || isNaN(pv.position.x)) return null;
  const r = pv.position, v = pv.velocity;
  const la = look(r, c.gmst);
  const o = c.obsEci;
  const vo = { x: -OMEGA * o.y, y: OMEGA * o.x, z: 0 };
  const dx = r.x - o.x, dy = r.y - o.y, dz = r.z - o.z;
  const d = Math.hypot(dx, dy, dz);
  const rr = (dx * (v.x - vo.x) + dy * (v.y - vo.y) + dz * (v.z - vo.z)) / d;
  return { az: la.az, el: la.el, range: d, rr };
}

function finDePase(s, t) {
  const f = radioFin.get(s.id);
  if (f && f > t) return f;
  let tt = t;
  for (let i = 0; i < 120; i++) {
    tt += 30000;
    const e = radioEval(s, contexto(tt, true));
    if (!e || e.el <= 0) break;
  }
  radioFin.set(s.id, tt);
  return tt;
}

function radioEstado(t) {
  if (!radioActivo || !radioSats.length) return null;
  const c = contexto(t);
  if (radioUltimo === null || Math.abs(t - radioUltimo) > 15000) {
    radioArriba.clear();
    for (const s of radioSats) {
      const e = radioEval(s, c);
      if (e && e.el > 0) radioArriba.add(s.id);
    }
    radioUltimo = t;
  }
  const out = [];
  for (const s of radioSats) {
    if (!radioArriba.has(s.id)) continue;
    const e = radioEval(s, c);
    if (!e || e.el <= 0) continue;
    out.push({ id: s.id, nombre: s.nombre, az: e.az, el: e.el, range: e.range, rr: e.rr, fin: finDePase(s, t) });
  }
  return out;
}

function radioProximos(desde, minEl) {
  const intervalo = [[desde, desde + 3 * 3600000]];
  const geom = (s, t) => {
    const d = new Date(t);
    const pv = S.propagate(s.rec, d);
    if (!pv || !pv.position || isNaN(pv.position.x)) return { ok: false, el: -90, az: 0 };
    const la = look(pv.position, S.gstime(d));
    return { ok: la.el >= minEl, el: la.el, az: la.az, mag: 0 };
  };
  const lista = [];
  for (const s of radioSats) for (const p of buscarPasesExactos(s, intervalo, minEl, geom)) lista.push(p);
  lista.sort((a, b) => a.ini - b.ini);
  self.postMessage({ tipo: 'radio-proximos', desde, lista });
}

// ---------- Satélites de fotos (Sentinel-2 y Landsat) ----------
// Su cámara cubre una franja de ~290 km (Sentinel-2) o ~185 km (Landsat): te fotografían cuando
// pasan casi por encima (elevación mínima aprox. según la franja) y es de día.
const SAT_FOTOS = { 40697: 77, 42063: 77, 60989: 77, 39084: 81, 49260: 81 };
const NOMBRE_FOTOS = { 40697: 'Sentinel-2A', 42063: 'Sentinel-2B', 60989: 'Sentinel-2C', 39084: 'Landsat 8', 49260: 'Landsat 9' };
function posiciones(consultas) {
  const porId = new Map(sats.map((s) => [s.id, s]));
  return consultas.map((q) => {
    const s = porId.get(+q.norad);
    if (!s) return null;
    // La hora del archivo marca el comienzo de la franja, que puede ser minutos antes de que el
    // satélite pase por encima: se busca su punto más alto entre 10 min antes y 60 min después.
    const en = (t) => {
      const d = new Date(t);
      const pv = S.propagate(s.rec, d);
      if (!pv || !pv.position || isNaN(pv.position.x)) return null;
      const la = look(pv.position, S.gstime(d));
      return { t, el: la.el, az: la.az, range: la.range, alt: Math.hypot(pv.position.x, pv.position.y, pv.position.z) - RE };
    };
    let mejor = null;
    for (let t = q.t - 600000; t <= q.t + 3600000; t += 15000) {
      const p = en(t);
      if (p && (!mejor || p.el > mejor.el)) mejor = p;
    }
    if (!mejor) return null;
    for (let paso = 7000; paso >= 500; paso = Math.round(paso / 2)) {
      for (const t of [mejor.t - paso, mejor.t + paso]) { const p = en(t); if (p && p.el > mejor.el) mejor = p; }
    }
    return mejor;
  });
}
function pasesFotos(desde, dias) {
  const porId = new Map(sats.map((s) => [s.id, s]));
  const lista = [];
  for (const [id, umbral] of Object.entries(SAT_FOTOS)) {
    const s = porId.get(+id);
    if (!s) continue;
    const cond = (sat, t) => {
      const d = new Date(t);
      const pv = S.propagate(sat.rec, d);
      if (!pv || !pv.position || isNaN(pv.position.x)) return { ok: false, el: -90, az: 0 };
      const g = S.gstime(d);
      const la = look(pv.position, g);
      const ok = la.el >= umbral && look(Astro.sunEci(d), g).el > 5;
      return { ok, el: la.el, az: la.az, mag: 0 };
    };
    for (const p of buscarPasesExactos(s, [[desde, desde + dias * 86400000]], umbral, cond)) lista.push({ ...p, nombre: NOMBRE_FOTOS[id] || p.nombre });
  }
  lista.sort((a, b) => a.ini - b.ini);
  return lista;
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.tipo === 'cargar') {
    cargar(m);
    prox.generacion++; prox.calculando = false; prox.desde = 0;
    noches.generacion++; noches.calculando = false; noches.desde = 0;
    if (m.transmisores) setRadio(m.transmisores);
    self.postMessage({ tipo: 'cargado', total: sats.length, candidatos: candidatos.length });
  } else if (m.tipo === 'config') {
    Object.assign(cfg, m.cfg);
    if (m.obs) setObs(m.obs);
    elegirCandidatos();
    prox.generacion++; prox.calculando = false; prox.desde = 0;
    noches.generacion++; noches.calculando = false; noches.desde = 0;
    radioUltimo = null; radioFin.clear();
  } else if (m.tipo === 'tic') {
    radioActivo = !!m.radio;
    tic(m.t);
  } else if (m.tipo === 'radio') {
    setRadio(m.transmisores);
  } else if (m.tipo === 'posiciones') {
    self.postMessage({ tipo: 'posiciones', pedido: m.pedido, res: posiciones(m.consultas || []) });
  } else if (m.tipo === 'pases-fotos') {
    self.postMessage({ tipo: 'pases-fotos', lista: pasesFotos(m.t, m.dias || 8) });
  } else if (m.tipo === 'radio-proximos') {
    radioProximos(m.t, m.minEl || 10);
  }
};
