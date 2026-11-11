// Fotos reales de satélites sobre una ubicación: Sentinel-2 (ESA) y Landsat (USGS/NASA),
// buscadas en el catálogo público de Microsoft Planetary Computer.
// Idea basada en Watched (Armaan Gupta, licencia MIT).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const DATOS = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const UA = { 'User-Agent': 'SatRadar (uso personal)' };

// Cómo pintar cada colección en color natural
const RENDER = {
  'sentinel-2-l2a': 'assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0',
  'landsat-c2-l2': 'assets=red&assets=green&assets=blue&color_formula=gamma+RGB+2.7%2C+saturation+1.5%2C+sigmoidal+RGB+15+0.55&nodata=0',
};
// Número de catálogo (NORAD) de cada satélite, para calcular el pase que sacó la foto
const NORAD = { 'sentinel-2a': 40697, 'sentinel-2b': 42063, 'sentinel-2c': 60989, 'landsat-8': 39084, 'landsat-9': 49260 };
const NOMBRES = { 'sentinel-2a': 'Sentinel-2A', 'sentinel-2b': 'Sentinel-2B', 'sentinel-2c': 'Sentinel-2C', 'landsat-8': 'Landsat 8', 'landsat-9': 'Landsat 9' };

function crearFotos({ dir, fetch, imagenDesdePng }) {
  fs.mkdirSync(dir, { recursive: true });
  const cacheBusqueda = new Map();
  const cacheNubes = new Map();

  function caja(lat, lon, km, aspecto = 0.75) {
    const dLat = (km * aspecto) / 111.32;
    const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((x) => x.toFixed(5)).join(',');
  }

  async function buscar(lat, lon, dias) {
    const clave = [lat.toFixed(3), lon.toFixed(3), dias].join('|');
    const c = cacheBusqueda.get(clave);
    if (c && Date.now() - c.fecha < 3600000) return c.lista;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86400000);
    const lista = [];
    for (const col of ['sentinel-2-l2a', 'landsat-c2-l2']) {
      const r = await fetch(STAC, {
        method: 'POST',
        headers: { ...UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collections: [col],
          intersects: { type: 'Point', coordinates: [lon, lat] },
          datetime: desde.toISOString() + '/' + hasta.toISOString(),
          sortby: [{ field: 'datetime', direction: 'desc' }],
          limit: 60,
        }),
      });
      if (!r.ok) throw new Error('catálogo de imágenes: HTTP ' + r.status);
      const j = await r.json();
      for (const f of j.features || []) {
        const p = f.properties || {};
        const plataforma = String(p.platform || '').toLowerCase();
        lista.push({
          id: f.id, coleccion: col, fecha: Date.parse(p.datetime), plataforma,
          nombre: NOMBRES[plataforma] || p.platform || col,
          norad: NORAD[plataforma] || null,
          nubesEscena: typeof p['eo:cloud_cover'] === 'number' ? p['eo:cloud_cover'] : null,
        });
      }
    }
    // La misma pasada puede venir partida en varias escenas: queda una por satélite y fecha
    const vistos = new Set();
    const unicas = lista.sort((a, b) => b.fecha - a.fecha).filter((x) => {
      const k = x.plataforma + '|' + Math.round(x.fecha / 600000);
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    await Promise.all(unicas.map((x, i) => (x.coleccion === 'sentinel-2-l2a' && i < 40 ? nubesEnElPunto(x, lat, lon).then((v) => (x.nubesLocal = v)) : null)));
    cacheBusqueda.set(clave, { fecha: Date.now(), lista: unicas });
    return unicas;
  }

  // Sentinel-2 trae una capa que clasifica cada píxel (nube, sombra, agua…): se cuentan las nubes
  // en ~1,5 km alrededor del punto, en vez del porcentaje de toda la escena.
  async function nubesEnElPunto(item, lat, lon) {
    const clave = item.id + lat.toFixed(3) + lon.toFixed(3);
    if (cacheNubes.has(clave)) return cacheNubes.get(clave);
    try {
      const url = `${DATOS}/${caja(lat, lon, 1.5, 1)}/40x40.png?collection=${item.coleccion}&item=${encodeURIComponent(item.id)}&assets=SCL&nodata=0`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const px = imagenDesdePng(Buffer.from(await r.arrayBuffer())); // BGRA
      let total = 0, nubes = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue; // sin dato
        const clase = px[i];
        total++;
        if (clase === 8 || clase === 9 || clase === 10 || clase === 3) nubes++; // nube, cirro o sombra de nube
      }
      const v = total ? Math.round((nubes / total) * 100) : null;
      cacheNubes.set(clave, v);
      return v;
    } catch {
      return null;
    }
  }

  // Recorte en JPG alrededor del punto. km = media anchura de la vista.
  async function imagen(item, lat, lon, km, ancho, alto) {
    const nombre = crypto.createHash('sha1').update([item.id, lat.toFixed(4), lon.toFixed(4), km, ancho, alto].join('|')).digest('hex') + '.jpg';
    const f = path.join(dir, nombre);
    if (fs.existsSync(f)) return fs.readFileSync(f);
    const render = RENDER[item.coleccion];
    if (!render) throw new Error('colección desconocida');
    const url = `${DATOS}/${caja(lat, lon, km, alto / ancho)}/${ancho}x${alto}.jpg?collection=${item.coleccion}&item=${encodeURIComponent(item.id)}&${render}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(f, buf);
    limpiar();
    return buf;
  }

  // Mantiene la carpeta de fotos guardadas por debajo de ~150 MB
  function limpiar() {
    try {
      const archivos = fs.readdirSync(dir).map((n) => { const p = path.join(dir, n); const st = fs.statSync(p); return { p, t: st.mtimeMs, s: st.size }; });
      let total = archivos.reduce((a, b) => a + b.s, 0);
      for (const a of archivos.sort((x, y) => x.t - y.t)) {
        if (total < 150 * 1048576) break;
        fs.unlinkSync(a.p);
        total -= a.s;
      }
    } catch {}
  }

  return { buscar, imagen };
}

module.exports = { crearFotos, NORAD };
