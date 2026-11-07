// Gestor de fuentes de datos gratuitas. Cada fuente se guarda por separado en
// la PC, se actualiza con su propia frecuencia y nunca se pide más seguido de
// lo que permiten los servidores (CelesTrak bloquea a quien abusa).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const H = 3600000;
const UA = { 'User-Agent': 'SatRadar/1.5 (uso personal)' };
const CT = 'https://celestrak.org';

const FUENTES = [
  // --- Órbitas ---
  { id: 'ct-activos', nombre: 'CelesTrak · satélites activos', tipo: 'orbitas', cada: 12 * H,
    url: CT + '/NORAD/elements/gp.php?GROUP=active&FORMAT=json' },
  { id: 'ct-brillantes', nombre: 'CelesTrak · objetos brillantes (incluye cohetes)', tipo: 'orbitas', cada: 12 * H,
    url: CT + '/NORAD/elements/gp.php?GROUP=visual&FORMAT=json' },
  { id: 'ct-sup-starlink', nombre: 'CelesTrak SupGP · Starlink (datos del operador)', tipo: 'orbitas', cada: 12 * H, precisa: true,
    url: CT + '/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json' },
  { id: 'ct-sup-oneweb', nombre: 'CelesTrak SupGP · OneWeb (datos del operador)', tipo: 'orbitas', cada: 12 * H, precisa: true,
    url: CT + '/NORAD/elements/supplemental/sup-gp.php?FILE=oneweb&FORMAT=json' },
  { id: 'ct-sup-kuiper', nombre: 'CelesTrak SupGP · Kuiper (datos del operador)', tipo: 'orbitas', cada: 12 * H, precisa: true,
    url: CT + '/NORAD/elements/supplemental/sup-gp.php?SOURCE=Kuiper-E&FORMAT=json' },
  { id: 'ct-sup-iss', nombre: 'CelesTrak SupGP · Estación Espacial Internacional', tipo: 'orbitas', cada: 12 * H, precisa: true,
    url: CT + '/NORAD/elements/supplemental/sup-gp.php?SOURCE=ISS-E&FORMAT=json' },
  { id: 'ct-sup-css', nombre: 'CelesTrak SupGP · Estación china Tiangong', tipo: 'orbitas', cada: 12 * H, precisa: true,
    url: CT + '/NORAD/elements/supplemental/sup-gp.php?SOURCE=CSS-E&FORMAT=json' },
  { id: 'spacetrack', nombre: 'Space-Track · catálogo completo en órbita baja (cohetes y restos)', tipo: 'orbitas', cada: 12 * H, cuenta: true },
  // --- Brillo y tamaño ---
  { id: 'mccants', nombre: 'McCants · magnitudes medidas por observadores', tipo: 'mccants', cada: 7 * 24 * H,
    url: 'https://www.mmccants.org/programs/qsmag.zip' },
  { id: 'gcat', nombre: 'GCAT (J. McDowell) · tamaño real de cada objeto', tipo: 'gcat', cada: 14 * 24 * H,
    url: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv' },
  { id: 'ct-satcat', nombre: 'CelesTrak SATCAT · tamaño por radar', tipo: 'satcat', cada: 7 * 24 * H,
    url: CT + '/satcat/records.php?GROUP=active&FORMAT=json' },
  // --- Radio ---
  { id: 'satnogs', nombre: 'SatNOGS · frecuencias de radio de los satélites', tipo: 'satnogs', cada: 7 * 24 * H,
    url: 'https://db.satnogs.org/api/transmitters/?format=json' },
];

const ST_QUERY =
  '/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-30/MEAN_MOTION/%3E11.25/orderby/norad_cat_id/format/json';

function crearGestor({ dir, fetch, credenciales }) {
  const archivo = (id) => path.join(dir, id + '.json');
  const archivoEstado = path.join(dir, 'estado-fuentes.json');
  fs.mkdirSync(dir, { recursive: true });

  const leer = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const escribir = (f, d) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, f); };

  let estado = leer(archivoEstado) || {}; // id -> {fecha, intento, error, cantidad}
  const guardarEstado = () => escribir(archivoEstado, estado);

  let alBytes = null; // (recibido, total) de la descarga en curso
  async function bajarTexto(url, opciones = {}) {
    const r = await fetch(url, { ...opciones, headers: { ...UA, ...(opciones.headers || {}) } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let buf;
    if (r.body && r.body.getReader) {
      const total = +(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
      const lector = r.body.getReader();
      const partes = [];
      let recibido = 0;
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        partes.push(Buffer.from(value));
        recibido += value.length;
        if (alBytes) alBytes(recibido, total);
      }
      buf = Buffer.concat(partes);
    } else {
      buf = Buffer.from(await r.arrayBuffer());
    }
    return opciones.binario ? buf : buf.toString('utf8');
  }

  // ----- Procesadores: convierten lo bajado en algo compacto -----
  async function procesar(f) {
    if (f.tipo === 'orbitas' && f.id === 'spacetrack') {
      const c = credenciales();
      if (!c) throw new Error('sin cuenta configurada');
      const body = new URLSearchParams({ identity: c.usuario, password: c.clave, query: 'https://www.space-track.org' + ST_QUERY });
      const txt = await bajarTexto('https://www.space-track.org/ajaxauth/login', {
        method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      let j;
      try { j = JSON.parse(txt); } catch { throw new Error('usuario o contraseña incorrectos'); }
      if (!Array.isArray(j)) throw new Error(j && j.error ? j.error : 'respuesta inesperada');
      return j.map(normalizarOmm).filter(Boolean);
    }
    if (f.tipo === 'orbitas') {
      const j = JSON.parse(await bajarTexto(f.url));
      if (!Array.isArray(j)) throw new Error('respuesta inesperada');
      return j.map(normalizarOmm).filter(Boolean);
    }
    if (f.tipo === 'mccants') {
      const zip = await bajarTexto(f.url, { binario: true });
      return parsearQuicksat(extraerZip(zip, /\.mag$/i));
    }
    if (f.tipo === 'gcat') return parsearGcat(await bajarTexto(f.url));
    if (f.tipo === 'satnogs') {
      const j = JSON.parse(await bajarTexto(f.url));
      if (!Array.isArray(j)) throw new Error('respuesta inesperada');
      const out = {};
      for (const x of j) {
        if (x.status !== 'active' || !x.alive || !x.norad_cat_id || !x.downlink_low) continue;
        if (x.downlink_low < 1e6 || x.downlink_low > 6e9) continue;
        (out[x.norad_cat_id] = out[x.norad_cat_id] || []).push({ d: String(x.description || '').slice(0, 80), f: x.downlink_low, m: x.mode || '' });
      }
      return out;
    }
    if (f.tipo === 'satcat') {
      const j = JSON.parse(await bajarTexto(f.url));
      const out = {};
      for (const x of j) if (x.RCS) out[+x.NORAD_CAT_ID] = +x.RCS;
      return out;
    }
    throw new Error('fuente desconocida');
  }

  // ----- Actualización respetando los tiempos de cada servidor -----
  async function actualizar(forzar, aviso) {
    const pendientes = [];
    for (const f of FUENTES) {
      const e = estado[f.id] || {};
      if (f.cuenta && !credenciales()) {
        estado[f.id] = { ...e, error: null, inactiva: true };
        continue;
      }
      const edad = e.fecha ? Date.now() - e.fecha : Infinity;
      const desdeIntento = e.intento ? Date.now() - e.intento : Infinity;
      // Nunca repetir antes de 2 h (aunque se fuerce): regla de CelesTrak
      const toca = forzar ? edad > 2 * H : edad > f.cada;
      const espera = forzar && e.error ? 15 * 60000 : 2 * H;
      if (toca && desdeIntento >= espera) pendientes.push(f);
    }
    for (let i = 0; i < pendientes.length; i++) {
      const f = pendientes[i];
      const e = estado[f.id] || {};
      const info = { i, n: pendientes.length, nombre: f.nombre, recibido: 0, total: 0 };
      if (aviso) aviso(info);
      let ultimo = 0;
      alBytes = (recibido, total) => {
        const ahora = Date.now();
        if (aviso && ahora - ultimo > 150) { ultimo = ahora; aviso({ ...info, recibido, total }); }
      };
      e.intento = Date.now();
      try {
        const datos = await procesar(f);
        const cantidad = Array.isArray(datos) ? datos.length : Object.keys(datos).length;
        // Los datos del operador pueden venir vacíos legítimamente (sin publicaciones por ahora)
        if (!cantidad && !f.precisa) throw new Error('vino vacío');
        escribir(archivo(f.id), datos);
        estado[f.id] = { fecha: Date.now(), intento: e.intento, error: null, cantidad };
      } catch (err) {
        estado[f.id] = { ...e, error: err.message || String(err) };
      }
      alBytes = null;
      guardarEstado();
    }
    if (aviso && pendientes.length) aviso({ i: pendientes.length, n: pendientes.length, nombre: '', fin: true });
    guardarEstado();
  }

  // ----- Fusión: por cada satélite se queda con la órbita más reciente -----
  function combinar() {
    const orbitas = new Map();
    const brillantes = [];
    for (const f of FUENTES.filter((x) => x.tipo === 'orbitas')) {
      const lista = leer(archivo(f.id));
      if (!Array.isArray(lista)) continue;
      for (const o of lista) {
        const prev = orbitas.get(o.NORAD_CAT_ID);
        const nueva = Date.parse(o.EPOCH + 'Z');
        // Los datos del operador (SupGP) ganan si no son más viejos que 1 día
        const ganar = !prev || nueva > prev._t || (f.precisa && nueva > prev._t - 86400000);
        if (ganar) orbitas.set(o.NORAD_CAT_ID, { ...o, _t: nueva, _fuente: f.id });
        if (f.id === 'ct-brillantes') brillantes.push(o.NORAD_CAT_ID);
      }
    }
    const fechas = FUENTES.filter((f) => f.tipo === 'orbitas').map((f) => (estado[f.id] || {}).fecha).filter(Boolean);
    return {
      orbitas: [...orbitas.values()],
      brillantes,
      mccants: leer(archivo('mccants')) || {},
      gcat: leer(archivo('gcat')) || {},
      rcs: leer(archivo('ct-satcat')) || {},
      transmisores: leer(archivo('satnogs')) || {},
      fecha: fechas.length ? Math.max(...fechas) : null,
      fuentes: FUENTES.map((f) => ({ id: f.id, nombre: f.nombre, cuenta: !!f.cuenta, ...(estado[f.id] || {}) })),
    };
  }

  return { actualizar, combinar };
}

// ----- Utilidades de formato -----
function normalizarOmm(o) {
  const id = +o.NORAD_CAT_ID;
  if (!id || !o.EPOCH || o.MEAN_MOTION == null) return null;
  const num = (k) => (o[k] === undefined || o[k] === null || o[k] === '' ? 0 : +o[k]);
  return {
    OBJECT_NAME: String(o.OBJECT_NAME || id).trim(),
    OBJECT_ID: o.OBJECT_ID || '',
    EPOCH: String(o.EPOCH).replace(/Z$/, ''),
    MEAN_MOTION: num('MEAN_MOTION'),
    ECCENTRICITY: num('ECCENTRICITY'),
    INCLINATION: num('INCLINATION'),
    RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
    ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'),
    MEAN_ANOMALY: num('MEAN_ANOMALY'),
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: id,
    ELEMENT_SET_NO: num('ELEMENT_SET_NO') || 999,
    REV_AT_EPOCH: num('REV_AT_EPOCH'),
    BSTAR: num('BSTAR'),
    MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'),
    MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'),
    OBJECT_TYPE: o.OBJECT_TYPE || undefined,
  };
}

// Número de catálogo con formato "alfa-5" (A0000 = 100000)
function catalogo(txt) {
  const t = txt.trim();
  if (/^\d+$/.test(t)) return +t;
  const m = /^([A-HJ-NP-Z])(\d{4})$/.exec(t);
  if (!m) return null;
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return (letras.indexOf(m[1]) + 10) * 10000 + +m[2];
}

// quicksat.mag: magnitud "más brillante probable" a 1000 km y fase llena
function parsearQuicksat(txt) {
  const out = {};
  const lineas = txt.split(/\r?\n/);
  for (const l of lineas.slice(1)) {
    const id = catalogo(l.slice(0, 5));
    const mag = parseFloat(l.slice(33, 37));
    if (id && !isNaN(mag)) out[id] = mag;
  }
  if (Object.keys(out).length < 500) throw new Error('archivo de magnitudes con formato inesperado');
  return out;
}

// GCAT satcat.tsv: largo, diámetro y envergadura en metros
function parsearGcat(txt) {
  const lineas = txt.split('\n');
  const cab = lineas[0].replace(/^#/, '').split('\t').map((s) => s.trim());
  const col = (n) => cab.indexOf(n);
  const iS = col('Satcat'), iL = col('Length'), iD = col('Diameter'), iSp = col('Span');
  if ([iS, iL, iD, iSp].some((i) => i < 0)) throw new Error('GCAT cambió de formato');
  const out = {};
  for (let k = 1; k < lineas.length; k++) {
    const l = lineas[k];
    if (!l || l[0] === '#') continue;
    const c = l.split('\t');
    const id = parseInt(c[iS], 10);
    const L = parseFloat(c[iL]), D = parseFloat(c[iD]), S = parseFloat(c[iSp]);
    if (!id || !(L > 0) || !(D > 0)) continue;
    out[id] = [L, D, S > 0 ? S : 0];
  }
  return out;
}

// Lector mínimo de .zip (sin dependencias)
function extraerZip(buf, patron) {
  let fin = buf.length - 22;
  while (fin >= 0 && buf.readUInt32LE(fin) !== 0x06054b50) fin--;
  if (fin < 0) throw new Error('zip inválido');
  const n = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  for (let i = 0; i < n; i++) {
    const metodo = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const lenNom = buf.readUInt16LE(p + 28), lenExt = buf.readUInt16LE(p + 30), lenCom = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + lenNom).toString('latin1');
    if (patron.test(nombre)) {
      const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const datos = buf.slice(ini, ini + comp);
      const crudo = metodo === 8 ? zlib.inflateRawSync(datos) : datos;
      return crudo.toString('latin1');
    }
    p += 46 + lenNom + lenExt + lenCom;
  }
  throw new Error('no se encontró el archivo de magnitudes en el zip');
}

module.exports = { crearGestor, FUENTES, parsearQuicksat, parsearGcat, extraerZip, normalizarOmm };
