// Servidor web local: deja ver la app desde el celular (misma red WiFi)
// y sirve la vista para OBS. Solo lectura: no permite cambiar nada de la PC.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

function crearServidor({ dirApp, obtenerDatos, leerAjustes, obtenerClima }) {
  let srv = null;
  let actual = { puerto: 0, red: false };
  let cacheDatos = { firma: '', gz: null };

  function datosComprimidos() {
    const d = obtenerDatos();
    const firma = (d.fuentes || []).map((f) => f.id + ':' + (f.fecha || 0)).join('|');
    if (firma !== cacheDatos.firma || !cacheDatos.gz) {
      const json = JSON.stringify(d);
      cacheDatos = { firma, gz: zlib.gzipSync(json, { level: 6 }), json: Buffer.from(json) };
    }
    return cacheDatos;
  }

  function responder(res, codigo, tipo, cuerpo, extra = {}) {
    res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(cuerpo);
  }

  async function manejar(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (req.method !== 'GET') return responder(res, 405, 'text/plain', 'Solo lectura');
      if (p === '/api/ping') return responder(res, 200, 'application/json', '{"satradar":true}');
      if (p === '/api/datos') {
        const c = datosComprimidos();
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return responder(res, 200, 'application/json', c.gz, { 'Content-Encoding': 'gzip' });
        return responder(res, 200, 'application/json', c.json);
      }
      if (p === '/api/ajustes') return responder(res, 200, 'application/json', JSON.stringify(leerAjustes() || {}));
      if (p === '/api/clima') {
        const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
        if (isNaN(lat) || isNaN(lon)) return responder(res, 400, 'text/plain', 'lat/lon');
        return responder(res, 200, 'application/json', JSON.stringify(await obtenerClima(lat, lon)));
      }
      // Archivos de la app (sin salir de la carpeta)
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const f = path.resolve(dirApp, rel);
      if (!f.startsWith(path.resolve(dirApp) + path.sep) || rel.includes('datos-prueba')) return responder(res, 404, 'text/plain', 'No');
      fs.readFile(f, (err, buf) => {
        if (err) return responder(res, 404, 'text/plain', 'No encontrado');
        responder(res, 200, TIPOS[path.extname(f).toLowerCase()] || 'application/octet-stream', buf);
      });
    } catch (e) {
      responder(res, 500, 'text/plain', 'Error');
    }
  }

  function ipsLocales() {
    const out = [];
    for (const lista of Object.values(os.networkInterfaces())) {
      for (const a of lista || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    // Primero las típicas de casa (192.168.x / 10.x)
    return out.sort((a, b) => (/^192\.168\./.test(b) ? 1 : 0) - (/^192\.168\./.test(a) ? 1 : 0));
  }

  // red=true: celular (toda la red local). red=false: solo esta PC (OBS)
  function configurar({ activo, red, puerto }) {
    return new Promise((resolve) => {
      const quiere = activo ? { puerto: puerto || 8770, red: !!red } : null;
      const igual = srv && quiere && quiere.puerto === actual.puerto && quiere.red === actual.red;
      if (igual) return resolve(estado());
      const arrancar = () => {
        if (!quiere) { srv = null; return resolve(estado()); }
        srv = http.createServer(manejar);
        srv.on('error', (e) => { actual.error = e.code === 'EADDRINUSE' ? `El puerto ${quiere.puerto} está ocupado` : e.message; srv = null; resolve(estado()); });
        srv.listen(quiere.puerto, quiere.red ? '0.0.0.0' : '127.0.0.1', () => {
          actual = { ...quiere, error: null };
          resolve(estado());
        });
      };
      if (srv) { const s = srv; srv = null; s.close(() => arrancar()); s.closeAllConnections?.(); }
      else arrancar();
    });
  }

  function estado() {
    if (!srv) return { activo: false, error: actual.error || null };
    const ips = actual.red ? ipsLocales() : [];
    return {
      activo: true, red: actual.red, puerto: actual.puerto,
      urlCelular: ips.length ? `http://${ips[0]}:${actual.puerto}/` : null,
      otrasIps: ips.slice(1).map((ip) => `http://${ip}:${actual.puerto}/`),
      urlObs: `http://localhost:${actual.puerto}/?modo=obs`,
    };
  }

  return { configurar, estado };
}

module.exports = { crearServidor };
