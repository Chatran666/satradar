// Proceso principal: ventana, descarga de datos (ver fuentes.js) y copia local.
const { app, BrowserWindow, ipcMain, net, Menu, shell, clipboard, nativeImage } = require('electron');
const tcp = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { crearGestor } = require('./fuentes');
const { safeStorage } = require('electron');

const archivoCuenta = () => path.join(app.getPath('userData'), 'cuenta-spacetrack.bin');

function leerCuenta() {
  try {
    const buf = fs.readFileSync(archivoCuenta());
    const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    const c = JSON.parse(txt);
    return c && c.usuario && c.clave ? c : null;
  } catch {
    return null;
  }
}
function guardarCuenta(c) {
  const txt = JSON.stringify(c);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, 'utf8');
  fs.writeFileSync(archivoCuenta(), buf);
}

let gestor = null;
function getGestor() {
  if (!gestor) {
    gestor = crearGestor({
      dir: path.join(app.getPath('userData'), 'datos'),
      fetch: (url, op) => net.fetch(url, op),
      credenciales: leerCuenta,
    });
  }
  return gestor;
}

let enCurso = null;
async function obtenerDatos(forzar, sender) {
  if (!enCurso) {
    enCurso = getGestor()
      .actualizar(forzar, (info) => { try { sender.send('datos:aviso', info); } catch {} })
      .finally(() => { enCurso = null; });
  }
  await enCurso;
  return getGestor().combinar();
}

function escribirJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}
function leerJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

ipcMain.handle('datos:obtener', (e, forzar) => obtenerDatos(!!forzar, e.sender));
ipcMain.handle('datos:copia', () => getGestor().combinar());

// Pronóstico de nubes (Open-Meteo, gratis y sin cuenta). Se guarda 1 h.
ipcMain.handle('clima:obtener', (_e, lat, lon) => obtenerClima(lat, lon));
async function obtenerClima(lat, lon) {
  const f = path.join(app.getPath('userData'), 'datos', 'clima.json');
  const c = leerJson(f);
  const misma = c && Math.abs(c.lat - lat) < 0.1 && Math.abs(c.lon - lon) < 0.1;
  if (misma && Date.now() - c.fecha < 3600000) return c;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) +
      '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&forecast_days=8&timezone=GMT&timeformat=unixtime';
    const r = await net.fetch(url, { headers: { 'User-Agent': 'SatRadar/1.5 (uso personal)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const h = j.hourly || {};
    const horas = (h.time || []).map((t, i) => {
      const ms = typeof t === 'number' ? t * 1000 : Date.parse(String(t) + 'Z');
      return [ms, h.cloud_cover?.[i], h.cloud_cover_low?.[i], h.cloud_cover_mid?.[i], h.cloud_cover_high?.[i]];
    }).filter((x) => !isNaN(x[0]));
    if (!horas.length) throw new Error('sin datos');
    const nuevo = { lat, lon, fecha: Date.now(), horas, error: null };
    escribirJson(f, nuevo);
    return nuevo;
  } catch (err) {
    return misma ? { ...c, error: err.message } : { lat, lon, fecha: null, horas: [], error: err.message };
  }
}

// ---------- Fotos reales de satélites ----------
const { crearFotos } = require('./fotos');
let fotosMod = null;
function fotos() {
  if (!fotosMod) {
    fotosMod = crearFotos({
      dir: path.join(app.getPath('userData'), 'fotos'),
      fetch: (url, op) => net.fetch(url, op),
      imagenDesdePng: (buf) => nativeImage.createFromBuffer(buf).toBitmap(),
    });
  }
  return fotosMod;
}
ipcMain.handle('fotos:buscar', async (_e, lat, lon, dias) => {
  try { return { lista: await fotos().buscar(+lat, +lon, +dias || 30) }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('fotos:imagen', async (_e, item, lat, lon, km, ancho, alto) => {
  try {
    const buf = await fotos().imagen(item, +lat, +lon, +km, Math.min(2048, +ancho), Math.min(2048, +alto));
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (err) { return { error: err.message }; }
});

// ---------- Servidor para el celular y OBS ----------
const { crearServidor } = require('./servidor');
const servidor = crearServidor({
  dirApp: path.join(__dirname, 'app'),
  obtenerDatos: () => getGestor().combinar(),
  leerAjustes: () => leerJson(path.join(app.getPath('userData'), 'ajustes.json')),
  obtenerClima,
  fotos: () => fotos(),
});
async function configurarServidor(a) {
  a = a || {};
  return servidor.configurar({ activo: !!(a.servCelular || a.servObs), red: !!a.servCelular, puerto: +a.servPuerto || 8770 });
}
ipcMain.handle('servidor:config', async (_e, a) => {
  const est = await configurarServidor(a);
  if (est.urlCelular) {
    try { est.qr = await require('qrcode').toDataURL(est.urlCelular, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } }); } catch {}
  }
  return est;
});

// ---------- Control del SDR por rigctl (SDR++, SDR# con plugin, gqrx) ----------
let rig = { sock: null, clave: '', listo: false, error: null };
ipcMain.handle('rig:frecuencia', (_e, host, puerto, hz) => new Promise((resolve) => {
  const clave = host + ':' + puerto;
  const enviar = () => {
    rig.sock.write('F ' + Math.round(hz) + '\n');
    resolve({ ok: true });
  };
  if (rig.sock && rig.clave === clave && rig.listo) return enviar();
  if (rig.sock) { try { rig.sock.destroy(); } catch {} }
  rig = { sock: null, clave, listo: false, error: null };
  const s = tcp.createConnection({ host, port: +puerto }, () => { rig.listo = true; enviar(); });
  rig.sock = s;
  s.setTimeout(3000, () => { s.destroy(); });
  s.on('data', () => {});
  s.on('error', (e) => { rig.listo = false; rig.error = e.code === 'ECONNREFUSED' ? 'El programa SDR no acepta conexiones (¿activaste el servidor rigctl?)' : e.message; resolve({ ok: false, error: rig.error }); });
  s.on('close', () => { rig.listo = false; if (rig.sock === s) rig.sock = null; });
}));
ipcMain.handle('rig:soltar', () => { if (rig.sock) try { rig.sock.destroy(); } catch {} rig.sock = null; return true; });

// ---------- Actualizaciones ----------
function versionMayor(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
ipcMain.handle('act:buscar', async (_e, url) => {
  const actual = app.getVersion();
  if (!url) return { actual, error: 'Sin dirección de actualizaciones configurada' };
  try {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'SatRadar/' + actual } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { actual, ultima: j.version, nueva: versionMayor(j.version, actual), url: j.url, notas: j.notas || '' };
  } catch (e) {
    return { actual, error: e.message };
  }
});
ipcMain.handle('act:instalar', async (e, url) => {
  try {
    if (!/^https:\/\//.test(url)) throw new Error('dirección inválida');
    const r = await net.fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    const lector = r.body.getReader();
    const partes = [];
    let recibido = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      partes.push(Buffer.from(value));
      recibido += value.length;
      try { e.sender.send('act:progreso', total ? recibido / total : 0); } catch {}
    }
    const f = path.join(os.tmpdir(), 'SatRadar-Setup-nuevo.exe');
    fs.writeFileSync(f, Buffer.concat(partes));
    const err = await shell.openPath(f);
    if (err) throw new Error(err);
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('portapapeles', (_e, txt) => { clipboard.writeText(String(txt)); return true; });
// Solo abre direcciones del propio servidor local (vista previa de OBS)
ipcMain.handle('abrir:local', (_e, url) => {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});

ipcMain.on('ventana:llamar', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isFocused()) w.flashFrame(true);
});
ipcMain.handle('cuenta:estado', () => { const c = leerCuenta(); return c ? { usuario: c.usuario } : null; });
ipcMain.handle('cuenta:guardar', (_e, c) => {
  if (!c || !c.usuario || !c.clave) return false;
  guardarCuenta({ usuario: String(c.usuario).trim(), clave: String(c.clave) });
  return true;
});
ipcMain.handle('cuenta:borrar', () => { try { fs.unlinkSync(archivoCuenta()); } catch {} return true; });
ipcMain.handle('ajustes:leer', () => leerJson(path.join(app.getPath('userData'), 'ajustes.json')));
ipcMain.handle('ajustes:guardar', (_e, a) => {
  escribirJson(path.join(app.getPath('userData'), 'ajustes.json'), a);
  return true;
});

function crearVentana() {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#000000',
    title: 'SatRadar',
    icon: path.join(__dirname, 'app', 'icono.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

app.setAppUserModelId('com.mariano.satradar');
// Permite que suenen los avisos aunque no se haya tocado la ventana
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => {
  // Limpia archivos de la versión 1.0 (reemplazados por una copia por fuente)
  for (const f of ['orbitas.json', 'satcat.json']) {
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'datos', f)); } catch {}
  }
  // Instalado: acceso del menú Inicio con el mismo ID de la app (lo pide Windows para mostrar notificaciones)
  if (process.platform === 'win32' && /\\Programs\\SatRadar\\/i.test(process.execPath)) {
    try {
      const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SatRadar.lnk');
      shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', { target: process.execPath, appUserModelId: 'com.mariano.satradar', description: 'SatRadar' });
    } catch {}
  }
  crearVentana();
  configurarServidor(leerJson(path.join(app.getPath('userData'), 'ajustes.json')));
});
app.on('window-all-closed', () => app.quit());
