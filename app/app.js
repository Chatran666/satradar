// Interfaz: radar, panel, controles de tiempo, sonido y ajustes.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('radar');
  const g = canvas.getContext('2d');

  // ---------- Ajustes ----------
  const DEFECTO = {
    ciudad: 'Buenos Aires (CABA)', lat: -34.6037, lon: -58.3816,
    cielo: 'auto', minEl: 10, solMax: -6, alTerminar: 'gris',
    starlink: true, nombres: true, rojo: false, brillo: 80,
    textoRadar: 100, grosorCuadricula: 100, grosorTrayectos: 100, panelOculto: false, barraOculta: false,
    textoLista: 120, nubes: 'auto', avisoMin: 2,
    sonido: true, volumen: 40, proxSinStarlink: false,
    silencio: false, sonidoVisible: true, volVisible: 40, sonidoAviso: true, volAviso: 60,
    nubesOn: true, maxPend: 0, estrellas: true, estrellasMag: 2, estrellasNombres: true,
    vista: 'mapa', planetas: true, observaciones: [], usarAprendido: true,
    radRango: 'fc0013', radRadar: false, rigOn: false, rigHost: '127.0.0.1', rigPuerto: 4532,
    servCelular: false, servObs: false, servPuerto: 8770, actUrl: '',
    avisoCartel: true, mostrarGuia: true, fotosDias: 30, fotosDespejadas: false,
    streamFormato: 'horizontal', streamLista: true, streamReloj: true, streamNombres: true, streamLetra: 120,
  };
  let aj = { ...DEFECTO };

  async function leerAjustes() {
    try {
      if (window.api) return (await window.api.leerAjustes()) || {};
      return JSON.parse(localStorage.getItem('satradar-ajustes') || '{}');
    } catch { return {}; }
  }
  function guardarAjustes() {
    try {
      if (window.api) window.api.guardarAjustes(aj);
      else localStorage.setItem('satradar-ajustes', JSON.stringify(aj));
    } catch { /* sin almacenamiento: seguimos igual */ }
  }

  function cieloElegido() {
    const est = Cielo.estimarCielo(aj.lat, aj.lon);
    if (aj.cielo === 'auto') return { nelm: est.nelm, nombre: est.tipo.nombre, auto: true, est };
    const t = Cielo.TIPOS.find((x) => x.id === aj.cielo) || Cielo.TIPOS[1];
    return { nelm: t.nelm, nombre: t.nombre, auto: false, est };
  }

  // ---------- Tiempo simulado ----------
  const params = new URLSearchParams(location.search);
  const modoObs = params.get('modo') === 'obs';
  let modoWeb = false; // abierto desde el celular (servidor de la PC)
  if (modoObs) document.body.classList.add('obs');
  const tiempo = { base: Date.now(), real: performance.now(), vel: 1, pausa: false };
  const tInicial = Date.parse(new URLSearchParams(location.search).get('t') || '');
  if (!isNaN(tInicial)) tiempo.base = tInicial;
  function ahoraSim() {
    if (tiempo.pausa) return tiempo.base;
    return tiempo.base + (performance.now() - tiempo.real) * tiempo.vel;
  }
  function fijarTiempo(t) {
    tiempo.base = t; tiempo.real = performance.now();
    saltoReciente = true;
  }
  function enVivo() {
    return !tiempo.pausa && tiempo.vel === 1 && Math.abs(ahoraSim() - Date.now()) < 3000;
  }

  // ---------- Motor ----------
  const motor = new Worker('motor.js');
  let estado = null;
  let proximos = null;
  let progresoProx = 0;
  let datosInfo = null;
  let seleccion = null;
  let saltoReciente = true;
  let estadosPrevios = new Map();
  let cargado = false;

  motor.onmessage = (ev) => {
    const m = ev.data;
    if (m.tipo === 'estado') {
      esperando = false;
      detectarCambios(m);
      estado = m;
      dibujar();
      actualizarHud();
      actualizarListaAhora();
      actualizarListaLateral();
      revisarAvisos();
      if (tabActiva === 'radio') actualizarRadio();
      seguirRig();
    } else if (m.tipo === 'proximos') {
      proximos = m;
      progresoProx = 1;
      actualizarProximos();
      actualizarListaLateral();
    } else if (m.tipo === 'progreso') {
      progresoProx = m.valor;
      $('prox-barra').firstElementChild.style.width = Math.round(m.valor * 100) + '%';
      $('prox-estado').textContent = m.valor < 1 ? 'Calculando… ' + Math.round(m.valor * 100) + '%' : '';
    } else if (m.tipo === 'noches') {
      noches = m;
      $('noches-barra').firstElementChild.style.width = '100%';
      actualizarNoches();
    } else if (m.tipo === 'progreso-noches') {
      $('noches-barra').firstElementChild.style.width = Math.round(m.valor * 100) + '%';
      if (!noches) $('lista-noches').innerHTML = `<div class="vacio">Calculando las próximas 7 noches… ${Math.round(m.valor * 100)}%</div>`;
    } else if (m.tipo === 'posiciones') {
      const r = pedidosPos.get(m.pedido);
      if (r) { pedidosPos.delete(m.pedido); r(m.res); }
    } else if (m.tipo === 'pases-fotos') {
      pasesFotosLista = m.lista;
      actualizarProximoFoto();
    } else if (m.tipo === 'radio-proximos') {
      radioProx = m;
      actualizarRadioProx();
    } else if (m.tipo === 'progreso-carga') {
      carga(null, 0.75 + m.valor * 0.23, 'Calculando órbitas · ' + Math.round(m.valor * 100) + '%');
    } else if (m.tipo === 'cargado') {
      setTimeout(() => { if (tabActiva === 'fotos') { pedirPasesFotos(); cargarFotos(false); } }, 500);
      carga(null, 1, 'Listo');
      cargado = true;
      $('aviso-carga').style.display = 'none';
    }
  };

  // ---------- Nubes ----------
  const NUBES_MANUAL = { despejado: 0, finas: 1.0, parcial: 1.8, nublado: 4 };
  let clima = null;
  function penPorNubes(total, baja, media, alta) {
    const ef = baja == null ? total : Math.max(baja || 0, media || 0, 0.7 * (alta || 0));
    if (ef == null || isNaN(ef)) return 0;
    if (ef < 15) return 0;
    if (ef >= 90) return 4;
    return ((ef - 15) / 75) * 2.5;
  }
  function nubesParaMotor() {
    if (!aj.nubesOn) return { manual: 0 };
    if (aj.nubes !== 'auto') return { manual: NUBES_MANUAL[aj.nubes] ?? 0 };
    const horas = {};
    if (clima && clima.horas) for (const [t, tot, b, m, a] of clima.horas) horas[Math.floor(t / 3600000)] = penPorNubes(tot, b, m, a);
    return { manual: null, horas };
  }
  function nubesAhora(t) {
    if (!clima || !clima.horas || !clima.horas.length) return null;
    const h = Math.floor(t / 3600000);
    return clima.horas.find((x) => Math.floor(x[0] / 3600000) === h) || null;
  }
  async function cargarClima() {
    if (!window.api || !window.api.clima || !aj.nubesOn || aj.nubes !== 'auto') { actualizarInfoNubes(); return; }
    try {
      clima = await window.api.clima(+aj.lat, +aj.lon);
    } catch (e) {
      clima = { horas: [], error: String(e) };
    }
    if (aj.nubes === 'auto' && aj.nubesOn) enviarConfig();
    actualizarInfoNubes();
    actualizarInfoDatos();
  }
  setInterval(cargarClima, 30 * 60000);

  function actualizarInfoNubes() {
    const el = $('aj-nubes-info');
    if (!el) return;
    if (!aj.nubesOn) { el.textContent = 'Apagado: se supone cielo despejado.'; return; }
    if (aj.nubes !== 'auto') {
      el.textContent = `Ajuste manual: los satélites se verán ${NUBES_MANUAL[aj.nubes].toFixed(1)} magnitudes más débiles.`;
      return;
    }
    if (!window.api) { el.textContent = 'El pronóstico se descarga en la app de Windows.'; return; }
    const h = nubesAhora(estado ? estado.t : Date.now());
    if (!h) { el.textContent = 'Sin pronóstico de nubes' + (clima && clima.error ? ` (${clima.error})` : '') + '. Se supone cielo despejado.'; return; }
    const [, tot, b, m, a] = h;
    el.textContent = `Ahora: ${Math.round(tot)}% nublado (bajas ${Math.round(b)}%, medias ${Math.round(m)}%, altas ${Math.round(a)}%). ` +
      `Resta ${penPorNubes(tot, b, m, a).toFixed(1)} mag. Pronóstico Open-Meteo ${clima.fecha ? edadTexto(Date.now() - clima.fecha) : ''}.`;
  }

  function enviarConfig() {
    const c = cieloElegido();
    motor.postMessage({
      tipo: 'config',
      cfg: { nelm: c.nelm + (aj.usarAprendido && ajusteAprendido().usable ? ajusteAprendido().c : 0), minEl: +aj.minEl, solMax: +aj.solMax, starlink: aj.starlink, alTerminar: aj.alTerminar, nubes: nubesParaMotor() },
      obs: { lat: +aj.lat, lon: +aj.lon, alt: 0.02 },
    });
    proximos = null;
    noches = null;
    estadosPrevios.clear();
    saltoReciente = true;
    actualizarProximos();
  }

  let firmaCargada = '';
  let descargando = null;

  function firmaDatos(d) {
    return (d.fuentes || []).map((f) => f.id + ':' + (f.fecha || 0)).join('|') + '#' + (d.orbitas || []).length;
  }

  function carga(texto, frac, detalle) {
    if (cargado) return;
    $('aviso-carga').style.display = 'flex';
    if (texto != null) $('carga-texto').textContent = texto;
    if (frac != null) $('carga-barra').firstElementChild.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (detalle != null) $('carga-detalle').textContent = detalle;
  }
  const mb = (b) => (b / 1048576).toFixed(1).replace('.', ',') + ' MB';

  function enviarAlMotor(d) {
    const firma = firmaDatos(d);
    if (firma === firmaCargada) return;
    firmaCargada = firma;
    carga('Preparando ' + d.orbitas.length.toLocaleString('es-AR') + ' objetos…', 0.75, 'Calculando órbitas');
    motor.postMessage({ tipo: 'cargar', orbitas: d.orbitas, brillantes: d.brillantes, mccants: d.mccants, gcat: d.gcat, rcs: d.rcs, transmisores: d.transmisores || {} });
    transmisores = d.transmisores || {};
    radioProx = null;
    enviarConfig();
  }

  async function cargarDatos(forzar) {
    carga('Cargando satélites…', 0.02, 'Leyendo la copia guardada');
    try {
      if (!window.api) {
        datosInfo = await datosDePrueba();
        enviarAlMotor(datosInfo);
        actualizarInfoDatos();
        return;
      }
      // 1) Arranque rápido con la copia guardada
      if (!cargado) {
        const copia = await window.api.copiaDatos();
        if (copia && copia.orbitas && copia.orbitas.length) {
          datosInfo = copia;
          enviarAlMotor(copia);
        }
      }
      // 2) Descargar lo que esté vencido (en segundo plano)
      if (!cargado && !(datosInfo && datosInfo.orbitas && datosInfo.orbitas.length)) {
        carga('Descargando datos por primera vez…', 0.05, 'Puede tardar un minuto');
      }
      const d = await window.api.obtenerDatos(!!forzar);
      descargando = null;
      datosInfo = d;
      if (d.orbitas && d.orbitas.length) enviarAlMotor(d);
      else if (!cargado) {
        carga('Sin datos de satélites', 0, 'Conectate a internet y tocá "Actualizar ahora" en Ajustes → Datos y servicios.');
      }
    } catch (e) {
      descargando = null;
      carga('No se pudieron cargar los datos', 0, String(e));
    }
    actualizarInfoDatos();
    refrescarCuenta();
  }

  if (window.api && window.api.alAvisoDatos) {
    window.api.alAvisoDatos((info) => {
      if (typeof info === 'string') info = { i: 0, n: 1, nombre: info };
      if (info.fin) { descargando = null; $('barra-descarga').style.display = 'none'; actualizarInfoDatos(); return; }
      const parcial = info.total ? info.recibido / info.total : 0;
      const frac = (info.i + parcial) / info.n;
      const bytes = info.recibido ? (info.total ? `${mb(info.recibido)} de ${mb(info.total)}` : mb(info.recibido)) : '';
      const corto = info.nombre.length > 34 ? info.nombre.slice(0, 33) + '…' : info.nombre;
      descargando = `${info.i + 1}/${info.n} ${corto}${bytes ? ' · ' + bytes : ''}`;
      carga(`Descargando datos (${info.i + 1} de ${info.n})`, 0.05 + frac * 0.68, info.nombre + (bytes ? ' · ' + bytes : ''));
      if (cargado) {
        $('barra-descarga').style.display = 'block';
        $('barra-descarga').firstElementChild.style.width = Math.round(frac * 100) + '%';
      }
      actualizarInfoDatos();
    });
  }

  async function datosDePrueba() {
    const j = (f) => fetch('datos-prueba/' + f).then((r) => r.json());
    const [a, b, mc, gc] = await Promise.all([j('activos.json'), j('brillantes.json'), j('mccants.json'), j('gcat.json')]);
    const orbitas = a.concat(b);
    return {
      orbitas, brillantes: b.map((x) => x.NORAD_CAT_ID), mccants: mc, gcat: gc, rcs: {},
      fecha: Date.now() - 5 * 3600000,
      fuentes: [
        { id: 'ct-activos', nombre: 'CelesTrak · satélites activos', fecha: Date.now() - 5 * 3600000, cantidad: a.length },
        { id: 'mccants', nombre: 'McCants · magnitudes medidas por observadores', fecha: Date.now() - 86400000, cantidad: Object.keys(mc).length },
        { id: 'spacetrack', nombre: 'Space-Track · catálogo completo', cuenta: true, inactiva: true },
        { id: 'ct-sup-starlink', nombre: 'CelesTrak SupGP · Starlink', error: 'HTTP 403', intento: Date.now() - 600000 },
      ],
    };
  }

  // Revisa cada hora si hay fuentes vencidas (cada fuente tiene su propia frecuencia)
  setInterval(() => { if (window.api) cargarDatos(false); }, 3600000);

  // ---------- Sonido ----------
  let audio = null;
  let ultimoPing = 0;
  function ping(probar) {
    if (!probar && (aj.silencio || !aj.sonidoVisible || aj.volVisible <= 0)) return;
    const ahora = performance.now();
    if (ahora - ultimoPing < 3000) return; // agrupa avisos seguidos (trenes de Starlink)
    ultimoPing = ahora;
    try {
      audio = audio || new AudioContext();
      const v = (aj.volVisible / 100) * 0.25;
      [[880, 0], [1320, 0.12]].forEach(([f, d]) => {
        const o = audio.createOscillator();
        const gn = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const t0 = audio.currentTime + d;
        gn.gain.setValueAtTime(0, t0);
        gn.gain.linearRampToValueAtTime(v, t0 + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        o.connect(gn).connect(audio.destination);
        o.start(t0);
        o.stop(t0 + 0.5);
      });
    } catch { /* sin audio */ }
  }

  function detectarCambios(m) {
    const nuevos = new Map();
    let hayCambio = false;
    for (const it of m.items) {
      nuevos.set(it.id, it.estado);
      if (it.estado === 'visible' && estadosPrevios.get(it.id) === 'pendiente') hayCambio = true;
    }
    if (hayCambio && !saltoReciente && tiempo.vel <= 10 && !tiempo.pausa) ping();
    estadosPrevios = nuevos;
    saltoReciente = false;
  }

  // ---------- Radar ----------
  let geo = { cx: 0, cy: 0, R: 1, dpr: 1 };
  function colores() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      linea: v('--linea'), lineaF: v('--linea-fuerte'), texto: v('--texto'), tenue: v('--texto-tenue'),
      acento: v('--acento'), visible: v('--visible'), pendiente: v('--pendiente'), terminado: v('--terminado'),
    };
  }
  let C = null;

  function redimensionar() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    geo.dpr = dpr;
    geo.w = r.width; geo.h = r.height;
    geo.cx = r.width / 2;
    geo.vertical = r.height > r.width * 1.15;
    const margen = 16 + 18 * ft();
    if (geo.vertical) {
      // Celular parado: radar arriba, lista abajo
      geo.R = Math.max(50, Math.min(r.width / 2 - margen, r.height * 0.32));
      geo.cy = (modoObs ? 0 : 105) + geo.R + margen;
    } else {
      geo.cy = r.height / 2;
      geo.R = Math.max(50, Math.min(r.width, r.height) / 2 - margen);
    }
    dibujar();
    if (typeof actualizarListaLateral === 'function') actualizarListaLateral();
  }

  const ft = () => (aj.textoRadar || 100) / 100;
  const gc = () => (aj.grosorCuadricula || 100) / 100;
  const gt = () => (aj.grosorTrayectos || 100) / 100;

  function proyectar(az, el) {
    const r = (geo.R * (90 - el)) / 90;
    const a = (az * Math.PI) / 180;
    const sx = aj.vista === 'cielo' ? -1 : 1;
    return [geo.cx + sx * r * Math.sin(a), geo.cy - r * Math.cos(a)];
  }

  function dibujar() {
    if (!C) C = colores();
    g.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    if (modoObs) g.clearRect(0, 0, geo.w, geo.h);
    else { g.fillStyle = '#000'; g.fillRect(0, 0, geo.w, geo.h); }
    const { cx, cy, R } = geo;

    // Cuadrícula
    g.lineWidth = 1 * gc();
    g.strokeStyle = C.lineaF;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = C.linea;
    g.beginPath(); g.arc(cx, cy, R / 2, 0, Math.PI * 2); g.stroke();
    g.setLineDash([2, 5]);
    g.beginPath(); g.arc(cx, cy, (R * (90 - aj.minEl)) / 90, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(cx - R, cy); g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R); g.lineTo(cx, cy + R);
    g.stroke();
    // Marcas de azimut cada 10°
    g.strokeStyle = C.lineaF;
    for (let a = 0; a < 360; a += 10) {
      const rad = (a * Math.PI) / 180;
      const l = (a % 30 === 0 ? 9 : 4) * Math.max(1, gc() * 0.8);
      g.beginPath();
      g.moveTo(cx + R * Math.sin(rad), cy - R * Math.cos(rad));
      g.lineTo(cx + (R + l) * Math.sin(rad), cy - (R + l) * Math.cos(rad));
      g.stroke();
    }
    g.fillStyle = C.texto;
    const f = ft();
    const sep = 12 + 9 * f;
    g.font = `600 ${15 * f}px "Segoe UI", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', cx, cy - R - sep);
    g.fillText('S', cx, cy + R + sep);
    const inv = aj.vista === 'cielo';
    g.fillText(inv ? 'O' : 'E', cx + R + sep, cy);
    g.fillText(inv ? 'E' : 'O', cx - R - sep, cy);
    g.fillStyle = C.tenue;
    g.font = `${11 * f}px Consolas, monospace`;
    g.textAlign = 'left';
    g.fillText('0°', cx + 4, cy - R + 9 * f);
    g.fillText('45°', cx + 4, cy - R / 2 + 9 * f);
    g.fillText('90°', cx + 4, cy + 9 * f);

    if (!estado) return;

    // Sol y Luna
    if (estado.sol.el > 0) {
      const [x, y] = proyectar(estado.sol.az, estado.sol.el);
      g.fillStyle = aj.rojo ? C.visible : '#d98a00';
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
    }
    if (estado.luna.el > 0) dibujarLuna();

    // Trayectos
    const t = estado.t;
    // Estrellas y planetas solo cuando ya oscureció (el Sol a más de 3° bajo el horizonte)
    const noche = estado.sol.el < -3;
    if (aj.estrellas && noche) dibujarEstrellas(t);
    if (aj.planetas && noche) dibujarPlanetas(t);
    if (aj.radRadar || radioSel) dibujarRadio();
    const mostrados = itemsEnRadar();
    for (const it of mostrados) dibujarTrayecto(it, t);
    // Satélites (los visibles arriba de todo)
    const orden = { terminado: 0, pendiente: 1, visible: 2 };
    const items = [...mostrados].sort((a, b) => orden[a.estado] - orden[b.estado]);
    for (const it of items) dibujarSat(it);
  }

  // Limita los rojos ("por hacerse visibles") a los N más próximos
  function itemsEnRadar() {
    const n = +aj.maxPend || 0;
    if (!n) return estado.items;
    const t = estado.t;
    const pend = estado.items.filter((i) => i.estado === 'pendiente')
      .sort((a, b) => proximoVisible(a, t) - proximoVisible(b, t)).slice(0, n);
    const ok = new Set(pend.map((i) => i.id));
    return estado.items.filter((i) => i.estado !== 'pendiente' || ok.has(i.id) || i.id === seleccion);
  }

  // ---------- Estrellas brillantes ----------
  // Coordenadas J2000 (grados) → azimut/elevación para la ubicación, con precesión aproximada
  function radecAzEl(lista, t, minEl = 0) {
    const d = (t - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const gmst = (280.46061837 + 360.98564736629 * d) % 360;
    const lst = (gmst + +aj.lon + 360) % 360;
    const lat = (+aj.lat * Math.PI) / 180;
    const anios = d / 365.25;
    const R = Math.PI / 180;
    const out = [];
    for (const o of lista) {
      const ra = o.ra + ((3.075 + 1.336 * Math.sin(o.ra * R) * Math.tan(o.dec * R)) * anios * 15) / 3600;
      const dec = o.dec + (20.04 * Math.cos(o.ra * R) * anios) / 3600;
      const H = (lst - ra) * R, de = dec * R;
      const el = Math.asin(Math.sin(lat) * Math.sin(de) + Math.cos(lat) * Math.cos(de) * Math.cos(H));
      if (el / R <= minEl) continue;
      const az = Math.atan2(-Math.cos(de) * Math.sin(H), Math.sin(de) * Math.cos(lat) - Math.cos(de) * Math.sin(lat) * Math.cos(H));
      out.push({ ...o, az: ((az / R) + 360) % 360, el: el / R });
    }
    return out;
  }
  const ESTR = (window.ESTRELLAS || []).map(([ra, dec, mag, nombre]) => ({ ra, dec, mag, nombre }));
  function estrellasAzEl(t, magMax = aj.estrellasMag, minEl = 0) {
    return radecAzEl(ESTR.filter((e) => e.mag <= magMax), t, minEl);
  }
  function planetasAzEl(t, minEl = 0) {
    if (!window.Planetas) return [];
    return radecAzEl(Planetas.planetas(t).filter((p) => p.mag < 3), t, minEl);
  }
  const COLOR_PLANETA = { Venus: '#fff4d6', 'Júpiter': '#f1dcb4', Marte: '#ff9a6b', Saturno: '#e8d9a0', Mercurio: '#c9c3b8' };
  function dibujarPlanetas(t) {
    const f = ft();
    for (const p of planetasAzEl(t)) {
      const [x, y] = proyectar(p.az, p.el);
      const r = Math.max(2.5, Math.min(6, 3.2 - p.mag * 0.6)) * Math.max(1, f * 0.8);
      g.globalAlpha = 0.9;
      g.fillStyle = aj.rojo ? '#c43020' : COLOR_PLANETA[p.nombre] || '#ddd';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = g.fillStyle; g.lineWidth = 1; g.globalAlpha = 0.5;
      g.beginPath(); g.arc(x, y, r + 3, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.8;
      g.font = `600 ${11 * f}px "Segoe UI", sans-serif`;
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(p.nombre, x + r + 6, y);
    }
    g.globalAlpha = 1;
  }
  function dibujarRadio() {
    if (!estado || !estado.radio) return;
    const f = ft();
    g.font = `${10 * f}px "Segoe UI", sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    for (const r of estado.radio) {
      if (!txEnRango(r.id).length) continue;
      const [x, y] = proyectar(r.az, r.el);
      const sel = radioSel && radioSel.id === r.id;
      g.fillStyle = aj.rojo ? '#7a1a10' : '#3fb6c8';
      g.globalAlpha = sel ? 1 : 0.75;
      g.fillRect(x - 3, y - 3, 6, 6);
      if (sel) { g.strokeStyle = g.fillStyle; g.lineWidth = 1.5; g.strokeRect(x - 7, y - 7, 14, 14); }
      if (aj.nombres || sel) g.fillText(r.nombre, x + 7, y);
    }
    g.globalAlpha = 1;
  }
  function dibujarEstrellas(t) {
    const lista = estrellasAzEl(t).sort((a, b) => a.mag - b.mag);
    const f = ft();
    const ocupados = []; // rectángulos de nombres ya escritos
    for (const e of lista) {
      const [x, y] = proyectar(e.az, e.el);
      const r = Math.max(0.8, 2.6 - e.mag * 0.55) * Math.max(1, f * 0.8);
      g.globalAlpha = Math.max(0.35, Math.min(0.9, 0.85 - e.mag * 0.15));
      g.fillStyle = aj.rojo ? '#b0281a' : '#c8d2dc';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (aj.estrellasNombres && e.nombre && e.mag <= Math.min(aj.estrellasMag, 1.6)) {
        g.globalAlpha = 0.55;
        g.font = `italic ${10 * f}px "Segoe UI", sans-serif`;
        g.textAlign = 'left'; g.textBaseline = 'middle';
        const w = g.measureText(e.nombre).width, h = 12 * f;
        const rect = [x + r + 4, y - h / 2, x + r + 4 + w, y + h / 2];
        if (!ocupados.some((o) => rect[0] < o[2] && rect[2] > o[0] && rect[1] < o[3] && rect[3] > o[1])) {
          ocupados.push(rect);
          g.fillText(e.nombre, rect[0], y);
        }
      }
    }
    g.globalAlpha = 1;
  }

  function dibujarTrayecto(it, t) {
    const sel = seleccion === it.id;
    const pts = it.pts;
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.el < 0 && b.el < 0) continue;
      const pasado = b.t <= t;
      let color;
      if (it.estado === 'terminado') color = C.terminado;
      else color = a.v && b.v ? C.visible : C.pendiente;
      g.strokeStyle = color;
      g.globalAlpha = pasado ? (sel ? 0.8 : 0.45) : sel ? 0.95 : 0.6;
      g.lineWidth = (sel ? 2 : 1.2) * gt();
      g.setLineDash(pasado ? [] : [4 * Math.max(1, gt()), 4 * Math.max(1, gt())]);
      const [x1, y1] = proyectar(a.az, Math.max(0, a.el));
      const [x2, y2] = proyectar(b.az, Math.max(0, b.el));
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  function dibujarSat(it) {
    const [x, y] = proyectar(it.az, it.el);
    const sel = seleccion === it.id;
    let r, color;
    if (it.estado === 'visible') {
      r = Math.max(2.8, Math.min(7.5, 6.5 - it.mag * 0.9));
      color = C.visible;
      g.shadowColor = color;
      g.shadowBlur = 10;
    } else if (it.estado === 'pendiente') {
      r = 3; color = C.pendiente;
    } else {
      r = 2.4; color = C.terminado;
    }
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    if (sel) {
      g.strokeStyle = C.acento; g.lineWidth = 1.5 * gt();
      g.beginPath(); g.arc(x, y, r + 6, 0, Math.PI * 2); g.stroke();
    }
    if (aj.nombres || sel) {
      g.font = (sel ? '600 ' : '') + 11 * ft() + 'px "Segoe UI", sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = it.estado === 'visible' ? color : C.tenue;
      g.globalAlpha = it.estado === 'terminado' && !sel ? 0.6 : 1;
      g.fillText(it.nombre, x + r + 5, y);
      g.globalAlpha = 1;
    }
  }

  function dibujarLuna() {
    const L = estado.luna;
    const [x, y] = proyectar(L.az, L.el);
    const r = 9;
    // Dirección hacia el Sol en la pantalla (aunque esté bajo el horizonte)
    const [sx, sy] = proyectar(estado.sol.az, Math.max(-80, estado.sol.el));
    const ang = Math.atan2(sy - y, sx - x);
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.fillStyle = aj.rojo ? '#1e0503' : '#1c1c1c';
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    // Parte iluminada: semicírculo hacia el Sol + elipse del terminador
    g.fillStyle = aj.rojo ? '#8a1a10' : '#b8b8b0';
    const k = 1 - 2 * L.ilum; // 1 = nueva, -1 = llena
    g.beginPath();
    g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    g.ellipse(0, 0, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k < 0);
    g.fill();
    g.restore();
  }

  // ---------- HUD ----------
  const fmt1 = (n) => (n >= 0 ? '+' : '') + n.toFixed(1);
  const fmtGrado = (n) => Math.round(n) + '°';
  function puntoCardinal(az) {
    const p = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return p[Math.round(((az % 360) + 360) % 360 / 45) % 8];
  }

  function actualizarHud() {
    if (!estado) return;
    const vis = estado.items.filter((i) => i.estado === 'visible').length;
    const pen = estado.items.filter((i) => i.estado === 'pendiente').length;
    const c = cieloElegido();
    const sol = estado.sol.el;
    let fase = 'de día';
    if (sol < -18) fase = 'noche cerrada';
    else if (sol < -12) fase = 'crepúsculo astronómico';
    else if (sol < -6) fase = 'crepúsculo náutico';
    else if (sol < 0) fase = 'crepúsculo civil';
    const lineas = [
      `Satélites cargados: ${estado.cargados.toLocaleString('es-AR')}   sobre el horizonte: ${estado.arriba}`,
      `<span class="amarillo">Visibles ahora: ${vis}</span>   <span class="alerta">por hacerse visibles: ${pen}</span>`,
      `Sol: elev ${fmtGrado(sol)} (${fase})`,
      `Luna: az ${fmtGrado(estado.luna.az)}, elev ${fmtGrado(estado.luna.el)}, ilum ${Math.round(estado.luna.ilum * 100)}%`,
      `Límite a ojo: mag ${estado.limite.toFixed(1)}  (cielo ${c.nombre.toLowerCase()}${c.auto ? ', por población' : ''})`,
    ];
    if (!aj.nubesOn) {
      // nubes apagadas: no se informa nada
    } else if (estado.penNubes > 0.05) {
      const h = aj.nubes === 'auto' ? nubesAhora(estado.t) : null;
      const txt = h ? `${Math.round(h[1])}% nublado (pronóstico)` : { finas: 'nubes finas', parcial: 'parcialmente nublado', nublado: 'nublado' }[aj.nubes] || 'nubes';
      lineas.push(`<span class="alerta">Nubes: ${txt} · se ven ${estado.penNubes.toFixed(1)} mag menos</span>`);
    } else if (aj.nubes === 'auto' && nubesAhora(estado.t)) {
      // pronóstico sin efecto apreciable
      lineas.push(`Nubes: ${Math.round(nubesAhora(estado.t)[1])}% (pronóstico)`);
    }
    if (!estado.oscuro) lineas.push('<span class="alerta">Todavía hay demasiada luz de día para ver satélites</span>');
    $('hud-arriba').innerHTML = lineas.join('\n');
    $('hud-abajo-izq').textContent = `${aj.ciudad}: ${(+aj.lat).toFixed(4)}°, ${(+aj.lon).toFixed(4)}°`;
    actualizarInfoDatos();
  }

  function edadTexto(ms) {
    const h = ms / 3600000;
    if (h < 1) return 'hace ' + Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return 'hace ' + Math.round(h) + ' h';
    return 'hace ' + Math.round(h / 24) + ' días';
  }

  function filaClima() {
    let est, clase;
    if (!aj.nubesOn) { est = 'Apagado (Ubicación y cielo → Nubes)'; clase = 'tenue'; }
    else if (aj.nubes !== 'auto') { est = 'No se usa: nubes elegidas a mano'; clase = 'tenue'; }
    else if (!clima) { est = 'Pendiente'; clase = 'tenue'; }
    else if (clima.error && !clima.fecha) { est = 'Sin datos: ' + clima.error; clase = 'alerta'; }
    else if (clima.fecha && clima.error) { est = `Falló la última vez (${clima.error}). Uso el pronóstico de ${edadTexto(Date.now() - clima.fecha)}`; clase = 'alerta'; }
    else if (clima.fecha) { est = `Pronóstico de 3 días · ${edadTexto(Date.now() - clima.fecha)}`; clase = 'ok'; }
    else { est = 'Pendiente'; clase = 'tenue'; }
    return `<div class="fuente"><span class="led ${clase}"></span><div><div>Open-Meteo · pronóstico de nubes</div><div class="nota">${esc(est)}</div></div></div>`;
  }

  function actualizarInfoDatos() {
    if (!datosInfo) return;
    let txt = 'Datos: sin descargar';
    let cls = 'alerta';
    if (datosInfo.fecha) {
      const edad = Date.now() - datosInfo.fecha;
      txt = 'Órbitas: ' + edadTexto(edad);
      cls = edad > 3 * 86400000 ? 'alerta' : 'ok';
      if (edad > 3 * 86400000) txt += ' · datos viejos, posiciones imprecisas';
    }
    if (descargando) txt = 'Descargando: ' + descargando + '…\n' + txt;
    $('hud-abajo-der').innerHTML = `<span class="${cls}">${esc(txt)}</span>`;
    const n = (datosInfo.orbitas || []).length;
    $('aj-datos').textContent = n ? `${n.toLocaleString('es-AR')} objetos con órbita, combinando todas las fuentes.` : 'Todavía no hay órbitas descargadas.';
    const cont = $('aj-fuentes');
    cont.innerHTML = (datosInfo.fuentes || []).map((f) => {
      let est, clase;
      if (f.cuenta && f.inactiva) { est = 'Necesita cuenta gratuita (abajo)'; clase = 'tenue'; }
      else if (f.error && f.fecha) { est = `Falló la última vez (${f.error}). Uso la copia de ${edadTexto(Date.now() - f.fecha)}`; clase = 'alerta'; }
      else if (f.error) { est = `Sin datos: ${f.error}`; clase = 'alerta'; }
      else if (f.fecha && !f.cantidad) { est = `Sin datos publicados por ahora · ${edadTexto(Date.now() - f.fecha)}`; clase = 'tenue'; }
      else if (f.fecha) { est = `${(f.cantidad || 0).toLocaleString('es-AR')} registros · ${edadTexto(Date.now() - f.fecha)}`; clase = 'ok'; }
      else { est = 'Pendiente'; clase = 'tenue'; }
      return `<div class="fuente"><span class="led ${clase}"></span><div><div>${esc(f.nombre)}</div><div class="nota">${esc(est)}</div></div></div>`;
    }).join('') + filaClima();
  }

  // ---------- Reloj ----------
  function actualizarReloj() {
    const t = new Date(ahoraSim());
    $('reloj-hora').textContent = t.toLocaleTimeString('es-AR', { hour12: false });
    $('reloj-fecha').textContent = t.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    $('hud-reloj').textContent = t.toLocaleTimeString('es-AR', { hour12: false }) + (enVivo() ? '' : '  ' + '(simulado)');
    const modo = $('reloj-modo');
    if (enVivo()) { modo.textContent = 'EN VIVO'; modo.classList.remove('sim'); }
    else {
      const dif = Math.round((ahoraSim() - Date.now()) / 60000);
      const partes = ['SIMULADO'];
      if (tiempo.pausa) partes.push('EN PAUSA');
      else if (tiempo.vel !== 1) partes.push('x' + tiempo.vel);
      if (dif !== 0) partes.push((dif > 0 ? '+' : '−') + duracion(Math.abs(dif)));
      modo.textContent = partes.join(' · ');
      modo.classList.add('sim');
    }
  }
  function duracion(min) {
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60), m = min % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  // ---------- Listas ----------
  function proximoVisible(it, t) {
    const p = it.pts.find((q) => q.v && q.t > t);
    return p ? p.t : null;
  }
  // Mejor magnitud (la más brillante) del tramo visible que queda
  function magMaxima(it) {
    let m = Infinity;
    for (const q of it.pts) if (q.v && q.m != null && q.t >= (estado ? estado.t : 0) - 10000) m = Math.min(m, q.m);
    return m === Infinity ? it.mag : m;
  }
  function mmss(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  const etiquetaFuente = {
    mccants: 'brillo medido (McCants)', familia: 'brillo de su familia de cohetes', gcat: 'brillo por tamaño real (GCAT)',
    radar: 'brillo por tamaño de radar', lista: 'lista de brillantes', estimado: 'brillo estimado',
  };
  const etiquetaOrbita = {
    'ct-activos': 'CelesTrak', 'ct-brillantes': 'CelesTrak', 'ct-sup-starlink': 'SupGP Starlink', 'ct-sup-oneweb': 'SupGP OneWeb',
    'ct-sup-kuiper': 'SupGP Kuiper', 'ct-sup-iss': 'SupGP ISS', 'ct-sup-css': 'SupGP Tiangong', spacetrack: 'Space-Track',
  };

  function actualizarListaAhora() {
    if (!estado) return;
    const t = estado.t;
    const cont = $('lista-ahora');
    const vis = estado.items.filter((i) => i.estado === 'visible').sort((a, b) => a.mag - b.mag);
    const pen = estado.items.filter((i) => i.estado === 'pendiente').sort((a, b) => proximoVisible(a, t) - proximoVisible(b, t));
    const ter = estado.items.filter((i) => i.estado === 'terminado');
    let html = '';
    const fila = (it, sub, der) =>
      `<div class="fila${seleccion === it.id ? ' sel' : ''}" data-id="${it.id}">
        <span class="punto" style="background:${C[it.estado === 'visible' ? 'visible' : it.estado]}"></span>
        <span class="nombre">${esc(it.nombre)}</span><span class="der">${der}</span>
        <span class="sub">${sub}</span></div>`;
    if (vis.length) {
      html += '<div class="titulo">VISIBLES AHORA</div>';
      for (const it of vis) html += fila(it, `az ${fmtGrado(it.az)} ${puntoCardinal(it.az)} · elev ${fmtGrado(it.el)} ${botonesObs(it)}`, 'mag ' + it.mag.toFixed(1));
    }
    if (pen.length) {
      html += '<div class="titulo">POR HACERSE VISIBLES</div>';
      for (const it of pen) html += fila(it, `az ${fmtGrado(it.az)} ${puntoCardinal(it.az)} · elev ${fmtGrado(it.el)}`, 'en ' + mmss(proximoVisible(it, t) - t) + ' · mag ' + magMaxima(it).toFixed(1));
    }
    if (ter.length) {
      html += '<div class="titulo">YA SE DEJARON DE VER</div>';
      for (const it of ter) html += fila(it, `¿Lo viste? ${botonesObs(it)}`, '');
    }
    if (!html) html = `<div class="vacio">${estado.oscuro ? 'No hay satélites visibles en este momento.' : 'Es de día: los satélites se ven después del atardecer y antes del amanecer.'}<br>Mirá la pestaña Próximos.</div>`;
    cont.innerHTML = html;
    actualizarDetalle();
  }

  function actualizarDetalle() {
    const d = $('detalle');
    const it = estado && seleccion != null ? estado.items.find((i) => i.id === seleccion) : null;
    if (!it) { d.hidden = true; return; }
    d.hidden = false;
    const estadoTxt = { visible: 'Visible a ojo desnudo', pendiente: 'Todavía no se ve', terminado: 'Ya se dejó de ver' }[it.estado];
    const pv = proximoVisible(it, estado.t);
    d.innerHTML = `<button class="cerrar" title="Cerrar">✕</button><div class="n">${esc(it.nombre)}</div>
      ${estadoTxt}${it.estado === 'pendiente' && pv ? ' (en ' + mmss(pv - estado.t) + ')' : ''}<br>
      Azimut ${fmtGrado(it.az)} ${puntoCardinal(it.az)} · Elevación ${fmtGrado(it.el)}<br>
      Brillo ahora: mag ${it.mag.toFixed(1)} ${it.iluminado ? '' : '(en sombra)'}<br>
      Distancia ${Math.round(it.range).toLocaleString('es-AR')} km · Altura ${Math.round(it.alt).toLocaleString('es-AR')} km<br>
      Pase: ${hora(it.ini)} → ${hora(it.fin)}<br>
      ${aj.mostrarGuia && paseVisibleDe(it) ? '<span class="guia">' + esc(guia(paseVisibleDe(it))) + '</span><br>' : ''}
      ${it.estado !== 'pendiente' ? '¿Lo viste? ' + botonesObs(it) + '<br>' : ''}
      NORAD ${it.id} · órbita: ${etiquetaOrbita[it.orb] || 'CelesTrak'}<br>
      ${etiquetaFuente[it.src] || ''} (mag a 1000 km: ${fmt1(it.std)})`;
    d.querySelector('.cerrar').onclick = () => { seleccion = null; actualizarListaAhora(); dibujar(); };
  }

  function horaSeg(t) {
    return new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function hora(t) {
    return new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- Guía con estrellas y planetas ----------
  function separacion(az1, el1, az2, el2) {
    const R = Math.PI / 180;
    const c = Math.sin(el1 * R) * Math.sin(el2 * R) + Math.cos(el1 * R) * Math.cos(el2 * R) * Math.cos((az1 - az2) * R);
    return Math.acos(Math.max(-1, Math.min(1, c))) / R;
  }
  function referenciaCercana(az, el, t) {
    const refs = estrellasAzEl(t, 2.0, 2).filter((e) => e.nombre).concat(planetasAzEl(t, 2));
    let mejor = null, dmin = 14;
    for (const e of refs) {
      const d = separacion(az, el, e.az, e.el);
      if (d < dmin) { dmin = d; mejor = e; }
    }
    return mejor ? mejor.nombre.replace(/ \(.*\)$/, '') : null;
  }
  const cacheGuia = new Map();
  // p: { ini, azIni, elIni, tMax, azMax, maxEl, fin, azFin, elFin }
  function guia(p) {
    const k = p.id + ':' + p.ini + ':' + aj.lat + ':' + aj.lon;
    if (cacheGuia.has(k)) return cacheGuia.get(k);
    const a = referenciaCercana(p.azIni, p.elIni ?? 20, p.ini);
    const m = p.tMax != null ? referenciaCercana(p.azMax, p.maxEl, p.tMax) : null;
    const f = referenciaCercana(p.azFin, p.elFin ?? 20, p.fin);
    const partes = [];
    partes.push(a ? `aparece cerca de ${a}` : `aparece al ${puntoCardinal(p.azIni)}, a ${Math.round(p.elIni ?? 0)}° de altura`);
    if (p.maxEl >= 75) partes.push('pasa casi por arriba de tu cabeza');
    else if (m && m !== a && m !== f) partes.push(`pasa cerca de ${m}`);
    partes.push(f && f !== a ? `se apaga cerca de ${f}` : `se apaga al ${puntoCardinal(p.azFin)}`);
    const txt = partes.join(' · ');
    if (cacheGuia.size > 3000) cacheGuia.clear();
    cacheGuia.set(k, txt);
    return txt;
  }
  // Tramo visible del pase actual de un satélite en el cielo
  function paseVisibleDe(it) {
    const v = it.pts.filter((q) => q.v);
    if (!v.length) return null;
    const max = v.reduce((a, b) => (b.el > a.el ? b : a));
    return { id: it.id, ini: v[0].t, azIni: v[0].az, elIni: v[0].el, tMax: max.t, azMax: max.az, maxEl: max.el,
      fin: v[v.length - 1].t, azFin: v[v.length - 1].az, elFin: v[v.length - 1].el };
  }

  // ---------- Trenes de Starlink: se agrupan en una sola fila ----------
  function agrupar(lista) {
    const out = [];
    for (const p of lista) {
      const u = out[out.length - 1];
      if (p.tren && u && u.tren && p.ini - u.ultimoIni <= 180000) {
        u.n++; u.ultimoIni = p.ini; u.fin = Math.max(u.fin, p.fin); u.mag = Math.min(u.mag, p.mag);
        if (p.maxEl > u.maxEl) { u.maxEl = p.maxEl; u.azMax = p.azMax; u.tMax = p.tMax; }
        u.azFin = p.azFin; u.elFin = p.elFin;
        continue;
      }
      out.push({ ...p, n: 1, ultimoIni: p.ini });
    }
    return out.map((x) => (x.n > 1 ? { ...x, nombre: `Tren de Starlink (${x.n} satélites)` } : x.tren ? { ...x, nombre: x.nombre + ' (tren)' } : x));
  }
  function filtrarStarlink(lista) {
    return aj.proxSinStarlink ? lista.filter((p) => !/^STARLINK/.test(p.nombre) || p.tren) : lista;
  }

  // ---------- Observaciones (Lo vi / No lo vi) y ajuste aprendido ----------
  function ajusteAprendido() {
    const obs = aj.observaciones || [];
    const n = obs.length;
    const vistos = obs.filter((o) => o.visto).length;
    if (n < 5) return { c: 0, n, vistos, usable: false };
    let mejor = { c: 0, err: Infinity };
    for (let c = -2.5; c <= 1.51; c += 0.1) {
      let err = 0;
      for (const o of obs) {
        const d = o.lim - o.mag + c; // >= 0: se tendría que ver
        if (o.visto ? d < 0 : d >= 0) err++;
      }
      if (err < mejor.err || (err === mejor.err && Math.abs(c) < Math.abs(mejor.c))) mejor = { c: Math.round(c * 10) / 10, err };
    }
    return { c: mejor.c, n, vistos, usable: true };
  }
  function registrarObs(it, visto) {
    const pv = it.pts ? paseVisibleDe(it) : it;
    const ini = pv ? pv.ini : it.ini;
    const k = it.id + ':' + Math.round(ini / 60000);
    const mag = it.pts ? Math.min(...it.pts.filter((q) => q.v && q.m != null).map((q) => q.m), it.mag) : it.mag;
    const lista = (aj.observaciones || []).filter((o) => o.k !== k);
    lista.push({ k, id: it.id, nombre: it.nombre, t: ini, mag: Math.round(mag * 10) / 10, lim: Math.round((estado ? estado.limite : 4) * 10) / 10, visto });
    aj.observaciones = lista.slice(-300);
    guardarAjustes();
    enviarConfig();
    actualizarObsUI();
    actualizarListaAhora();
  }
  function obsDe(it) {
    const pv = it.pts ? paseVisibleDe(it) : it;
    if (!pv) return null;
    const k = it.id + ':' + Math.round(pv.ini / 60000);
    return (aj.observaciones || []).find((o) => o.k === k) || null;
  }
  function botonesObs(it) {
    const o = obsDe(it);
    if (o) return `<span class="obs-hecha">${o.visto ? '✓ lo viste' : '✗ no lo viste'}</span>`;
    return `<span class="obs-btns"><button data-obs="1" data-id="${it.id}" title="Lo vi">✓</button><button data-obs="0" data-id="${it.id}" title="No lo vi">✗</button></span>`;
  }
  function actualizarObsUI() {
    const a = ajusteAprendido();
    const res = $('obs-resumen');
    if (!res) return;
    if (!a.n) res.textContent = 'Todavía no marcaste ningún pase.';
    else {
      res.innerHTML = `Marcaste <b>${a.n}</b> ${a.n === 1 ? 'pase' : 'pases'} y viste <b>${a.vistos}</b> (${Math.round((a.vistos / a.n) * 100)}% de acierto de la app).<br>` +
        (a.usable ? `Ajuste aprendido: <b>${a.c > 0 ? '+' : ''}${a.c.toFixed(1)} mag</b> ${a.c < 0 ? '(tu cielo se ve menos de lo calculado)' : a.c > 0 ? '(ves más de lo calculado)' : '(la app acierta)'}` :
          `Faltan ${5 - a.n} para calcular el ajuste.`);
    }
    $('obs-usar').checked = aj.usarAprendido;
    $('obs-lista').innerHTML = (aj.observaciones || []).slice(-12).reverse().map((o) =>
      `<div class="fila"><span class="punto" style="background:${o.visto ? C.visible : C.pendiente}"></span><span class="nombre">${esc(o.nombre)}</span>
       <span class="der">mag ${o.mag.toFixed(1)}</span><span class="sub">${new Date(o.t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} · ${o.visto ? 'lo viste' : 'no lo viste'} · límite ${o.lim.toFixed(1)}</span></div>`).join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-obs]');
    if (!b || !estado) return;
    e.stopPropagation();
    const it = estado.items.find((i) => i.id === +b.dataset.id);
    if (it) registrarObs(it, b.dataset.obs === '1');
  }, true);

  // ---------- Aviso antes de cada pase ----------
  const avisados = new Set();
  let ocultarAviso = null;
  function revisarAvisos() {
    if (!aj.avisoMin || !proximos || !estado || tiempo.pausa || tiempo.vel !== 1 || saltoReciente) return;
    const t = estado.t;
    const lim = aj.avisoMin * 60000;
    for (const p of agrupar(filtrarStarlink(proximos.lista))) {
      const falta = p.ini - t;
      if (falta > lim || falta < -20000) continue;
      const clave = p.id + ':' + p.ini;
      if (avisados.has(clave)) continue;
      avisados.add(clave);
      if (falta < lim - 90000) continue; // ya estaba dentro de la ventana al abrir la app o saltar el tiempo
      avisar(p, falta);
    }
  }
  function avisar(p, falta) {
    const min = Math.max(1, Math.round(falta / 60000));
    const titulo = `${p.nombre} en ${min} min · mag ${p.mag.toFixed(1)}`;
    const cuerpo = `${horaSeg(p.ini)} · por el ${puntoCardinal(p.azIni)}, sube hasta ${Math.round(p.maxEl)}°` + (aj.mostrarGuia ? ` · ${guia(p)}` : '');
    campana();
    if (!aj.avisoCartel) return; // solo sonido
    const el = $('aviso-pase');
    el.innerHTML = `<div class="t">${esc(titulo)}</div><div class="c">${esc(cuerpo)}</div>`;
    el.hidden = false;
    clearTimeout(ocultarAviso);
    ocultarAviso = setTimeout(() => (el.hidden = true), 25000);
    try { if (window.api) window.api.llamarAtencion(); } catch {}
    try {
      if ('Notification' in window && Notification.permission !== 'denied') new Notification('SatRadar · ' + titulo, { body: cuerpo, silent: true });
    } catch {}
  }
  function campana(probar) {
    if (!probar && (aj.silencio || !aj.sonidoAviso || aj.volAviso <= 0)) return;
    try {
      audio = audio || new AudioContext();
      const v = (aj.volAviso / 100) * 0.22;
      [[660, 0], [880, 0.18], [1100, 0.36]].forEach(([f, d]) => {
        const o = audio.createOscillator(), gn = audio.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        const t0 = audio.currentTime + d;
        gn.gain.setValueAtTime(0, t0);
        gn.gain.linearRampToValueAtTime(v, t0 + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
        o.connect(gn).connect(audio.destination);
        o.start(t0); o.stop(t0 + 0.65);
      });
    } catch {}
  }

  // ---------- Lista lateral (con el panel oculto) ----------
  function cuentaRegresiva(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    if (s < 3600) return Math.floor(s / 60) + ':' + pad(s % 60);
    return Math.floor(s / 3600) + 'h ' + pad(Math.floor((s % 3600) / 60)) + 'm';
  }

  function actualizarListaLateral() {
    const el = $('hud-proximos');
    if (geo.vertical) {
      if (!estado || (!aj.panelOculto && !modoObs)) { el.innerHTML = ''; return; }
      el.classList.add('abajo');
      el.style.top = Math.round(geo.cy + geo.R + 22 + 14 * ft()) + 'px';
      el.style.width = '';
      el.style.bottom = '6px';
    } else {
      el.classList.remove('abajo');
      el.style.top = '';
      el.style.bottom = '';
      const espacio = geo.w / 2 - geo.R - (12 + 9 * ft()) - 28;
      if ((!aj.panelOculto && !modoObs) || !estado || espacio < 170) { el.innerHTML = ''; return; }
      el.style.width = Math.min(espacio, 300 * (aj.textoLista / 100) + 60) + 'px';
      // Termina antes del texto de abajo a la derecha ("Órbitas: hace…")
      el.style.bottom = Math.round(30 + 12 * ft()) + 'px';
    }
    const t = estado.t;
    const filas = [];
    const finPorId = new Map();
    for (const it of estado.items) {
      finPorId.set(it.id, it.fin);
      if (it.estado === 'visible') {
        filas.push({ clase: 'vis', orden: -1, izq: 'AHORA', mag: it.mag, nombre: it.nombre,
          sub: `al ${puntoCardinal(it.az)} · ${Math.round(it.el)}° de altura` });
      } else if (it.estado === 'pendiente') {
        const pv = proximoVisible(it, t);
        const p = it.pts.find((q) => q.t === pv) || it;
        filas.push({ clase: 'pen', orden: pv, izq: 'en ' + cuentaRegresiva(pv - t), mag: magMaxima(it), nombre: it.nombre,
          sub: `ya está en el cielo · aparece al ${puntoCardinal(p.az)}` });
      }
    }
    if (proximos) {
      const futuros = proximos.lista.filter((p) => p.ini > t && !(finPorId.has(p.id) && p.ini <= finPorId.get(p.id)));
      for (const p of agrupar(filtrarStarlink(futuros))) {
        filas.push({ clase: 'prox' + (p.tren ? ' tren' : ''), orden: p.ini, izq: 'en ' + cuentaRegresiva(p.ini - t), mag: p.mag, nombre: p.nombre,
          sub: `${horaSeg(p.ini)} · ${puntoCardinal(p.azIni)} → ${puntoCardinal(p.azFin)} · hasta ${Math.round(p.maxEl)}°`, guia: aj.mostrarGuia ? guia(p) : '' });
      }
    }
    filas.sort((a, b) => a.orden - b.orden);
    const altoFila = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lista-px')) * 3.1 || 40;
    const alto = geo.vertical ? geo.h - parseFloat(el.style.top || 0) - 50 : geo.h - 160;
    const caben = geo.vertical ? 40 : Math.max(3, Math.floor(alto / (altoFila * 1.3)));
    let html = '<div class="titulo">PRÓXIMOS PASES VISIBLES</div>';
    if (!filas.length) html += `<div class="sub">${proximos ? 'Ninguno en las próximas 3 horas' : 'Calculando…'}</div>`;
    for (const f of filas.slice(0, caben)) {
      html += `<div class="pp ${f.clase}"><div class="l1"><span class="cuenta">${f.izq}</span><span class="mag">mag ${f.mag.toFixed(1)}</span><span class="nom">${esc(f.nombre)}</span></div><div class="sub">${esc(f.sub)}</div>${f.guia ? `<div class="sub guia">${esc(f.guia)}</div>` : ''}</div>`;
    }
    el.innerHTML = html;
    // Si no entra todo, se sacan filas enteras del final (nunca queda una cortada a la mitad)
    if (!geo.vertical) {
      const filasPP = el.querySelectorAll('.pp');
      for (let i = filasPP.length - 1; i > 0 && el.scrollHeight > el.clientHeight + 1; i--) filasPP[i].remove();
    }
  }

  function actualizarProximos() {
    const cont = $('lista-proximos');
    if (!proximos) {
      cont.innerHTML = '<div class="vacio">Calculando los pases visibles de las próximas 3 horas…</div>';
      return;
    }
    const lista = agrupar(filtrarStarlink(proximos.lista));
    if (!lista.length) {
      cont.innerHTML = '<div class="vacio">No hay pases visibles en las próximas 3 horas.</div>';
      return;
    }
    cont.innerHTML = lista.slice(0, 400).map((p) =>
      `<div class="fila" data-ini="${p.ini}" title="Tocá para ir a ese momento">
        <span class="punto${p.tren ? ' tren' : ''}" style="background:${C.visible}"></span>
        <span class="nombre">${horaSeg(p.ini)}  ${esc(p.nombre)}</span><span class="der">mag ${p.mag.toFixed(1)}</span>
        <span class="sub">${puntoCardinal(p.azIni)} → ${puntoCardinal(p.azFin)} · máx ${fmtGrado(p.maxEl)} · ${duracion(Math.max(1, Math.round((p.fin - p.ini) / 60000)))}</span>
        ${aj.mostrarGuia ? `<span class="sub guia">${esc(guia(p))}</span>` : ''}
      </div>`).join('');
  }

  // ---------- Noches (planificador) ----------
  let noches = null;
  let nocheAbierta = null;
  function claveNoche(t) {
    const d = new Date(t - 12 * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nubesNoche(clave) {
    if (!aj.nubesOn || !clima || !clima.horas || !clima.horas.length) return null;
    const vals = clima.horas.filter(([t]) => {
      const h = new Date(t).getHours();
      return (claveNoche(t) === clave) && (h >= 21 || h <= 2);
    }).map((x) => x[1]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function actualizarNoches() {
    const cont = $('lista-noches');
    if (!noches) { cont.innerHTML = '<div class="vacio">Calculando las próximas 7 noches…</div>'; return; }
    const grupos = new Map();
    for (const p of noches.lista) {
      const k = claveNoche(p.ini);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(p);
    }
    const filas = [...grupos.entries()].map(([k, ps]) => {
      const lista = agrupar(ps);
      const buenos = lista.filter((p) => p.mag <= 3).length;
      const mejor = lista.reduce((a, b) => (b.mag < a.mag ? b : a), lista[0]);
      return { k, lista, buenos, mejor, nubes: nubesNoche(k), trenes: lista.filter((p) => p.tren).length };
    }).filter((f) => f.lista.length);
    const top = filas.reduce((a, b) => (b.buenos > (a ? a.buenos : -1) ? b : a), null);
    cont.innerHTML = filas.map((f) => {
      const [y, m, d] = f.k.split('-').map(Number);
      const fecha = new Date(y, m - 1, d).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' });
      const estrellas = Math.max(1, Math.min(5, Math.round(f.buenos / 5) + 1));
      const abierta = nocheAbierta === f.k;
      const detalle = abierta ? f.lista.slice().sort((a, b) => a.mag - b.mag).slice(0, 8).sort((a, b) => a.ini - b.ini).map((p) =>
        `<div class="pase-noche" data-ini="${p.ini}" title="Tocá para ir a ese momento"><b>${hora(p.ini)}</b> ${esc(p.nombre)} · mag ${p.mag.toFixed(1)} · máx ${Math.round(p.maxEl)}°</div>`).join('') : '';
      return `<div class="noche${abierta ? ' abierta' : ''}${f === top ? ' mejor' : ''}" data-k="${f.k}">
        <div class="n1"><span class="fecha">${fecha}</span><span class="estrellitas">${'★'.repeat(estrellas)}${'☆'.repeat(5 - estrellas)}</span></div>
        <div class="sub">${f.lista.length} pases visibles · ${f.buenos} brillantes (mag ≤ 3)${f.trenes ? ` · ${f.trenes} tren${f.trenes > 1 ? 'es' : ''} de Starlink` : ''}</div>
        <div class="sub">Mejor: ${esc(f.mejor.nombre)} a las ${hora(f.mejor.ini)} (mag ${f.mejor.mag.toFixed(1)})${f.nubes != null ? ` · nubes ${Math.round(f.nubes)}%` : ''}${f === top ? ' · <b>la mejor noche</b>' : ''}</div>
        ${detalle}</div>`;
    }).join('') || '<div class="vacio">No hay pases visibles en las próximas 7 noches.</div>';
  }
  $('lista-noches').addEventListener('click', (e) => {
    const pase = e.target.closest('.pase-noche');
    if (pase) { fijarTiempo(+pase.dataset.ini - 60000); tic(); return; }
    const n = e.target.closest('.noche');
    if (!n) return;
    nocheAbierta = nocheAbierta === n.dataset.k ? null : n.dataset.k;
    actualizarNoches();
  });

  // ---------- Radio (SatNOGS + Doppler + rigctl) ----------
  let transmisores = {};
  let radioProx = null;
  let radioSel = null; // { id, f, nombre, d, m }
  const RANGOS = { fc0013: [22e6, 1100e6], rtl: [24e6, 1766e6], todo: [0, 1e12] };
  function txEnRango(id) {
    const [a, b] = RANGOS[aj.radRango] || RANGOS.todo;
    return (transmisores[id] || []).filter((x) => x.f >= a && x.f <= b);
  }
  const mhz = (hz) => (hz / 1e6).toFixed(4).replace('.', ',');
  function doppler(f, rr) { return f * (1 - rr / 299792.458); }
  function actualizarRadio() {
    const cont = $('lista-radio');
    if (!estado || !estado.radio) { cont.innerHTML = '<div class="vacio">Calculando…</div>'; return; }
    const lista = estado.radio.filter((r) => txEnRango(r.id).length).sort((a, b) => b.el - a.el);
    if (!lista.length) { cont.innerHTML = '<div class="vacio">Ningún satélite con radio en tu rango está sobre el horizonte ahora.</div>'; return; }
    const t = estado.t;
    cont.innerHTML = lista.slice(0, 40).map((r) => {
      const txs = txEnRango(r.id).slice(0, 5).map((x) => {
        const sel = radioSel && radioSel.id === r.id && radioSel.f === x.f;
        return `<div class="tx${sel ? ' sel' : ''}" data-id="${r.id}" data-f="${x.f}" title="Tocá para seguir esta frecuencia">
          <b>${mhz(doppler(x.f, r.rr))}</b> MHz <span class="tenue">(${mhz(x.f)})</span> ${esc(x.m)} · ${esc(x.d)}</div>`;
      }).join('');
      return `<div class="radio-sat"><div class="n1"><span>${esc(r.nombre)}</span><span class="der">${Math.round(r.el)}° ${puntoCardinal(r.az)} · queda ${cuentaRegresiva(r.fin - t)}</span></div>${txs}</div>`;
    }).join('');
  }
  function actualizarRadioProx() {
    const cont = $('lista-radio-prox');
    if (!radioProx) { cont.innerHTML = '<div class="vacio">Calculando…</div>'; return; }
    const lista = radioProx.lista.filter((p) => txEnRango(p.id).length && p.fin > (estado ? estado.t : 0));
    cont.innerHTML = lista.slice(0, 50).map((p) => {
      const tx = txEnRango(p.id)[0];
      return `<div class="fila" data-ini="${p.ini}"><span class="punto" style="background:#3fb6c8"></span><span class="nombre">${hora(p.ini)}  ${esc(p.nombre)}</span>
        <span class="der">máx ${Math.round(p.maxEl)}°</span><span class="sub">${mhz(tx.f)} MHz ${esc(tx.m)} · ${duracion(Math.max(1, Math.round((p.fin - p.ini) / 60000)))} · entra por el ${puntoCardinal(p.azIni)}</span></div>`;
    }).join('') || '<div class="vacio">No hay pases de radio en las próximas 3 horas.</div>';
  }
  let ultimoPedidoRadio = 0;
  function pedirRadioProx(forzar) {
    if (!cargado) return;
    if (!forzar && Date.now() - ultimoPedidoRadio < 300000 && radioProx) return;
    ultimoPedidoRadio = Date.now();
    motor.postMessage({ tipo: 'radio-proximos', t: ahoraSim(), minEl: 10 });
  }
  $('lista-radio').addEventListener('click', (e) => {
    const tx = e.target.closest('.tx');
    if (!tx) return;
    const id = +tx.dataset.id, f = +tx.dataset.f;
    if (radioSel && radioSel.id === id && radioSel.f === f) radioSel = null;
    else {
      const r = estado.radio.find((x) => x.id === id);
      const t = (transmisores[id] || []).find((x) => x.f === f) || {};
      radioSel = { id, f, nombre: r ? r.nombre : '', d: t.d, m: t.m };
    }
    actualizarRadio();
    dibujar();
  });
  $('lista-radio-prox').addEventListener('click', (e) => {
    const f = e.target.closest('.fila');
    if (f) { fijarTiempo(+f.dataset.ini - 60000); tic(); }
  });
  let ultimoRig = 0;
  async function seguirRig() {
    const est = $('rad-rig-estado');
    if (!aj.rigOn || !window.api || !window.api.rigFrecuencia) { if (est) est.textContent = ''; return; }
    if (!radioSel) { est.textContent = 'Elegí una frecuencia en la lista de abajo para que el SDR la siga.'; return; }
    const r = estado && estado.radio && estado.radio.find((x) => x.id === radioSel.id);
    if (!r) { est.textContent = `${radioSel.nombre} ya no está sobre el horizonte.`; return; }
    if (Date.now() - ultimoRig < 1000) return;
    ultimoRig = Date.now();
    const hz = doppler(radioSel.f, r.rr);
    const res = await window.api.rigFrecuencia(aj.rigHost, aj.rigPuerto, hz);
    est.textContent = res.ok ? `Siguiendo ${radioSel.nombre}: ${mhz(hz)} MHz (${radioSel.m || ''})` : 'No conecta con el SDR: ' + res.error;
  }

  // ---------- Celular y OBS ----------
  const FORMATOS = { horizontal: [1600, 1000], cuadrado: [1000, 1000], vertical: [1080, 1920] };
  let urlStream = '', urlCel = '';
  function armarUrlStream(base) {
    const q = new URLSearchParams({ modo: 'obs' });
    const lista = aj.streamFormato === 'cuadrado' ? false : aj.streamLista;
    q.set('lista', lista ? '1' : '0');
    q.set('reloj', aj.streamReloj ? '1' : '0');
    q.set('nombres', aj.streamNombres ? '1' : '0');
    q.set('letra', String(aj.streamLetra));
    return base.replace(/\?.*$/, '') + '?' + q.toString();
  }
  async function aplicarServidor() {
    $('cel-guia').hidden = !aj.servCelular;
    $('stream-guia').hidden = !aj.servObs;
    const [an, al] = FORMATOS[aj.streamFormato] || FORMATOS.horizontal;
    $('stream-ancho').textContent = an; $('stream-alto').textContent = al;
    $('stream-lista').disabled = aj.streamFormato === 'cuadrado';
    $('stream-letra-v').textContent = aj.streamLetra + '%';
    if (!window.api || !window.api.servidor) return;
    const st = await window.api.servidor({ servCelular: aj.servCelular, servObs: aj.servObs, servPuerto: aj.servPuerto });
    const ic = $('srv-celular-info'), io = $('srv-obs-info'), qr = $('srv-qr');
    if (st.error) {
      const msg = 'No se pudo iniciar el servidor local: ' + st.error + '. Probá otro puerto en "Conexión (avanzado)".';
      ic.textContent = msg; io.textContent = msg; qr.hidden = true; return;
    }
    io.textContent = '';
    urlCel = st.urlCelular || '';
    $('cel-url').textContent = urlCel || '—';
    if (aj.servCelular && st.urlCelular) {
      ic.innerHTML = st.otrasIps && st.otrasIps.length ? 'Si esa no abre, probá: ' + st.otrasIps.map(esc).join(' · ') : '';
      if (st.qr) { qr.src = st.qr; qr.hidden = false; } else qr.hidden = true;
    } else if (aj.servCelular) {
      ic.textContent = 'Esta computadora no está conectada a una red WiFi o cableada, así que el celular no la puede encontrar.';
      qr.hidden = true;
    } else { ic.textContent = ''; qr.hidden = true; }
    urlStream = st.urlObs ? armarUrlStream(st.urlObs) : '';
    $('stream-url').textContent = urlStream || '—';
  }
  async function copiarTexto(txt, boton) {
    if (!txt) return;
    try {
      if (window.api && window.api.copiar) await window.api.copiar(txt);
      else await navigator.clipboard.writeText(txt);
      const t = boton.textContent; boton.textContent = '¡Copiado!'; setTimeout(() => (boton.textContent = t), 1600);
    } catch {}
  }
  $('stream-copiar').onclick = (e) => copiarTexto(urlStream, e.target);
  $('cel-copiar').onclick = (e) => copiarTexto(urlCel, e.target);
  $('stream-ver').onclick = () => { if (urlStream && window.api && window.api.abrirLocal) window.api.abrirLocal(urlStream); };

  // ---------- Actualizaciones ----------
  // Las versiones se publican en GitHub; "latest" siempre apunta a la última
  const URL_ACT_DEFECTO = 'https://github.com/Chatran666/satradar/releases/latest/download/latest.json';
  const urlActualizaciones = () => aj.actUrl || URL_ACT_DEFECTO;
  async function buscarActualizacion(silencioso) {
    if (!window.api || !window.api.buscarActualizacion) return;
    const est = $('act-estado');
    if (!silencioso) est.textContent = 'Buscando…';
    const r = await window.api.buscarActualizacion(urlActualizaciones());
    if (r.error) { if (!silencioso) est.textContent = 'No se pudo consultar: ' + r.error; return; }
    if (!r.nueva) { est.textContent = `Tenés la última versión (${r.actual}).`; return; }
    est.textContent = `Hay una versión nueva: ${r.ultima}.`;
    const b = $('aviso-act');
    b.innerHTML = `<b>SatRadar ${esc(r.ultima)} disponible.</b> ${esc(r.notas || '')} <button id="act-instalar">Instalar ahora</button> <button id="act-luego">Más tarde</button>`;
    b.hidden = false;
    $('act-luego').onclick = () => (b.hidden = true);
    $('act-instalar').onclick = async () => {
      b.innerHTML = 'Descargando la actualización… <span id="act-pct">0%</span>';
      const res = await window.api.instalarActualizacion(r.url);
      if (!res.ok) b.innerHTML = 'No se pudo instalar: ' + esc(res.error) + ' <button id="act-luego2">Cerrar</button>';
      const c = $('act-luego2'); if (c) c.onclick = () => (b.hidden = true);
    };
  }
  if (window.api && window.api.alProgresoActualizacion) window.api.alProgresoActualizacion((v) => { const e = $('act-pct'); if (e) e.textContent = Math.round(v * 100) + '%'; });
  $('act-buscar').onclick = () => buscarActualizacion(false);

  // ---------- Fotos reales de satélites ----------
  let fotosLista = null, fotosClave = '', fotosCargando = false;
  let pasesFotosLista = null, ultimoPedidoPasesFotos = 0;
  const pedidosPos = new Map();
  let nPedido = 0;
  function posicionesDe(consultas) {
    return new Promise((res) => {
      const pedido = ++nPedido;
      pedidosPos.set(pedido, res);
      motor.postMessage({ tipo: 'posiciones', pedido, consultas });
      setTimeout(() => { if (pedidosPos.has(pedido)) { pedidosPos.delete(pedido); res(consultas.map(() => null)); } }, 8000);
    });
  }
  const fechaCorta = (t) => new Date(t).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  function claseNube(v) { return v == null ? '' : v <= 10 ? 'nube-ok' : v <= 50 ? 'nube-media' : 'nube-mal'; }
  function textoNubes(f) {
    if (f.nubesLocal != null) return `<span class="${claseNube(f.nubesLocal)}">nubes sobre tu zona: ${f.nubesLocal}%</span>`;
    if (f.nubesEscena != null) return `<span class="${claseNube(f.nubesEscena)}">nubes en la imagen: ${Math.round(f.nubesEscena)}%</span>`;
    return '';
  }
  function cuandoFalta(ms) {
    const h = ms / 3600000;
    if (h < 1) return 'en ' + Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 36) return 'en ' + Math.round(h) + ' h';
    return 'en ' + Math.round(h / 24) + ' días';
  }
  function actualizarProximoFoto() {
    const el = $('fotos-proximo');
    if (!pasesFotosLista) { el.innerHTML = 'Calculando cuándo pasa el próximo satélite de fotos…'; return; }
    const ahora = estado ? estado.t : Date.now();
    const futuros = pasesFotosLista.filter((p) => p.fin > ahora);
    if (!futuros.length) { el.innerHTML = 'Ningún satélite de fotos pasa sobre tu ubicación en los próximos 8 días.'; return; }
    const p = futuros[0];
    el.innerHTML = `Próximo satélite de fotos sobre tu casa:<br><b>${esc(p.nombre)}</b> · ${fechaCorta(p.tMax)} ${horaSeg(p.tMax)} (${cuandoFalta(p.tMax - ahora)}) · casi encima, a ${Math.round(p.maxEl)}°` +
      (futuros.length > 1 ? `<div class="sig">Después: ${futuros.slice(1, 4).map((x) => `${esc(x.nombre)} ${fechaCorta(x.tMax)} ${hora(x.tMax)}`).join(' · ')}</div>` : '');
  }
  function pedirPasesFotos() {
    if (!cargado || (pasesFotosLista && Date.now() - ultimoPedidoPasesFotos < 3600000)) return;
    ultimoPedidoPasesFotos = Date.now();
    motor.postMessage({ tipo: 'pases-fotos', t: Date.now(), dias: 8 });
  }
  async function cargarFotos(forzar) {
    const clave = [(+aj.lat).toFixed(3), (+aj.lon).toFixed(3), aj.fotosDias].join('|');
    if (!forzar && (fotosCargando || fotosClave === clave)) { mostrarFotos(); return; }
    if (!window.api || !window.api.fotos) {
      $('fotos-estado').textContent = 'Las fotos se buscan desde la app de Windows (o desde el celular conectado a ella).';
      return;
    }
    fotosCargando = true;
    $('fotos-estado').textContent = 'Buscando fotos de tu ubicación en los archivos de la ESA y la NASA…';
    $('lista-fotos').innerHTML = '';
    const r = await window.api.fotos(+aj.lat, +aj.lon, +aj.fotosDias);
    fotosCargando = false;
    if (r.error) { $('fotos-estado').textContent = 'No se pudieron buscar las fotos: ' + r.error + '. Revisá la conexión a internet.'; return; }
    fotosLista = r.lista || [];
    fotosClave = clave;
    // Datos del pase que sacó cada foto
    const pos = await posicionesDe(fotosLista.map((f) => ({ norad: f.norad, t: f.fecha })));
    fotosLista.forEach((f, i) => (f.pase = pos[i]));
    mostrarFotos();
  }
  function fotosVisibles() {
    return (fotosLista || []).filter((f) => !aj.fotosDespejadas || (f.nubesLocal != null ? f.nubesLocal <= 20 : (f.nubesEscena ?? 100) <= 20));
  }
  function mostrarFotos() {
    if (!fotosLista) return;
    const lista = fotosVisibles();
    $('fotos-estado').textContent = fotosLista.length
      ? `${fotosLista.length} fotos de tu ubicación en los últimos ${aj.fotosDias} días${lista.length < fotosLista.length ? ` (${lista.length} despejadas)` : ''}. Tocá una para verla grande.`
      : `No hay fotos de tu ubicación en los últimos ${aj.fotosDias} días.`;
    $('lista-fotos').innerHTML = lista.map((f, i) => {
      const pase = f.pase ? `Pasó a las ${horaSeg(f.pase.t)} a ${Math.round(f.pase.alt)} km de altura, ${f.pase.el > 75 ? 'casi encima tuyo' : 'al ' + puntoCardinal(f.pase.az)} (${Math.round(f.pase.el)}°)` : '';
      return `<div class="foto" data-i="${fotosLista.indexOf(f)}">
        <div class="mini"><div class="cargando">Cargando…</div><img alt="" data-foto="${fotosLista.indexOf(f)}"><span class="punto-yo"></span></div>
        <div class="datos"><div class="t1"><span>${esc(f.nombre)}</span><span>${fechaCorta(f.pase ? f.pase.t : f.fecha)} ${hora(f.pase ? f.pase.t : f.fecha)}</span></div>
        <div class="sub">${textoNubes(f)}</div>${pase ? `<div class="sub">${esc(pase)}</div>` : ''}</div></div>`;
    }).join('');
    cargarMiniaturas();
  }
  let colaMini = [];
  async function cargarMiniaturas() {
    colaMini = [...document.querySelectorAll('#lista-fotos img[data-foto]')];
    const trabajador = async () => {
      while (colaMini.length) {
        const img = colaMini.shift();
        const f = fotosLista[+img.dataset.foto];
        if (!f || !img.isConnected) continue;
        const src = await fuenteFoto(f, 2.5, 400, 300);
        if (!img.isConnected) continue;
        if (src) { img.src = src; img.onload = () => { const c = img.parentElement.querySelector('.cargando'); if (c) c.remove(); }; }
        else { const c = img.parentElement.querySelector('.cargando'); if (c) c.textContent = 'Sin imagen'; }
      }
    };
    await Promise.all([trabajador(), trabajador(), trabajador()]);
  }
  async function fuenteFoto(f, km, w, h) {
    try {
      const item = { id: f.id, coleccion: f.coleccion };
      if (modoWeb) return `/api/foto?id=${encodeURIComponent(f.id)}&col=${encodeURIComponent(f.coleccion)}&lat=${aj.lat}&lon=${aj.lon}&km=${km}&w=${w}&h=${h}`;
      const r = await window.api.fotoImagen(item, +aj.lat, +aj.lon, km, w, h);
      return typeof r === 'string' ? r : null;
    } catch { return null; }
  }
  // Visor a pantalla completa
  const ZOOMS = [0.75, 1.5, 3, 6, 12, 25];
  let visor = { f: null, z: 2 };
  async function abrirVisor(f) {
    visor = { f, z: visor.f ? visor.z : 2 };
    $('visor').hidden = false;
    const t = f.pase ? f.pase.t : f.fecha;
    const pase = f.pase ? ` · pasó a ${Math.round(f.pase.alt)} km de altura, ${f.pase.el > 75 ? 'casi encima tuyo' : 'al ' + puntoCardinal(f.pase.az)} (${Math.round(f.pase.el)}°)` : '';
    $('visor-info').innerHTML = `<b>${esc(f.nombre)}</b> · ${fechaCorta(t)} ${horaSeg(t)}${pase}<br>${textoNubes(f)} · el círculo amarillo es tu ubicación`;
    await cargarVisor();
  }
  async function cargarVisor() {
    const f = visor.f;
    const km = ZOOMS[visor.z];
    $('visor-cargando').hidden = false;
    $('visor-cargando').textContent = `Cargando foto (${(km * 2).toLocaleString('es-AR')} km de ancho)…`;
    const ancho = Math.min(1600, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
    const alto = Math.round(ancho * 0.75);
    const src = await fuenteFoto(f, km, ancho, alto);
    if (visor.f !== f || ZOOMS[visor.z] !== km) return;
    if (!src) { $('visor-cargando').textContent = 'No se pudo cargar la foto.'; return; }
    const img = $('visor-img');
    img.onload = () => ($('visor-cargando').hidden = true);
    img.src = src;
    $('visor-cerca').disabled = visor.z === 0;
    $('visor-lejos').disabled = visor.z === ZOOMS.length - 1;
  }
  $('visor-cerca').onclick = () => { if (visor.z > 0) { visor.z--; cargarVisor(); } };
  $('visor-lejos').onclick = () => { if (visor.z < ZOOMS.length - 1) { visor.z++; cargarVisor(); } };
  $('visor-cerrar').onclick = () => { $('visor').hidden = true; };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('visor').hidden) $('visor').hidden = true; });
  $('visor-guardar').onclick = () => {
    const src = $('visor-img').src;
    if (!src || !visor.f) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `SatRadar ${visor.f.nombre} ${new Date(visor.f.fecha).toISOString().slice(0, 10)}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('lista-fotos').addEventListener('click', (e) => {
    const c = e.target.closest('.foto');
    if (c && fotosLista) abrirVisor(fotosLista[+c.dataset.i]);
  });

  // ---------- Interacción ----------
  canvas.addEventListener('click', (e) => {
    if (!estado) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let mejor = null, dmin = 16;
    for (const it of estado.items) {
      const [x, y] = proyectar(it.az, it.el);
      const d = Math.hypot(x - mx, y - my);
      if (d < dmin) { dmin = d; mejor = it; }
    }
    seleccion = mejor ? mejor.id : null;
    if (mejor) mostrarTab('ahora');
    dibujar();
    actualizarListaAhora();
  });

  $('lista-ahora').addEventListener('click', (e) => {
    const f = e.target.closest('.fila');
    if (!f) return;
    seleccion = +f.dataset.id;
    dibujar();
    actualizarListaAhora();
  });

  $('lista-proximos').addEventListener('click', (e) => {
    const f = e.target.closest('.fila');
    if (!f) return;
    fijarTiempo(+f.dataset.ini - 60000);
    tic();
  });

  let tabActiva = 'ahora';
  function mostrarTab(n) {
    tabActiva = n;
    document.querySelectorAll('#pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === n));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('activa', s.id === 'tab-' + n));
    if (n === 'radio') { pedirRadioProx(); actualizarRadio(); actualizarRadioProx(); }
    if (n === 'noches') actualizarNoches();
    if (n === 'fotos') { pedirPasesFotos(); actualizarProximoFoto(); cargarFotos(false); }
    if (n === 'ajustes') actualizarObsUI();
  }
  document.querySelectorAll('#pestanas button').forEach((b) => (b.onclick = () => mostrarTab(b.dataset.tab)));

  document.querySelectorAll('#barra [data-salto]').forEach((b) =>
    (b.onclick = () => { fijarTiempo(ahoraSim() + +b.dataset.salto); tic(); }));
  $('b-ahora').onclick = () => {
    tiempo.vel = 1; tiempo.pausa = false; $('b-velocidad').value = '1';
    fijarTiempo(Date.now()); actualizarBotones(); tic();
  };
  $('b-pausa').onclick = () => {
    const t = ahoraSim();
    tiempo.pausa = !tiempo.pausa;
    fijarTiempo(t);
    actualizarBotones();
  };
  $('b-velocidad').onchange = (e) => {
    const t = ahoraSim();
    tiempo.vel = +e.target.value;
    fijarTiempo(t);
  };
  $('b-sonido').onclick = () => { aj.silencio = !aj.silencio; aplicarAjustesUI(); guardarAjustes(); };
  $('b-rojo').onclick = () => { aj.rojo = !aj.rojo; aplicarAjustesUI(); guardarAjustes(); };
  $('b-pantalla').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  function actualizarBotones() {
    $('b-pausa').textContent = tiempo.pausa ? '▶' : '❚❚';
    $('b-sonido').classList.toggle('on', !aj.silencio);
    $('b-sonido').textContent = aj.silencio ? '♪ Silenciado' : '♪ Sonido';
    $('b-rojo').classList.toggle('on', aj.rojo);
  }

  // ---------- Formulario de ajustes ----------
  function llenarSelects() {
    const sc = $('aj-ciudad');
    sc.innerHTML = Cielo.CIUDADES.map(([n]) => `<option>${esc(n)}</option>`).join('') + '<option value="__otra">Otra (coordenadas)</option>';
    $('aj-cielo').innerHTML = '<option value="auto">Automático según población</option>' +
      Cielo.TIPOS.map((t) => `<option value="${t.id}">${t.nombre} (estrellas hasta mag ${t.nelm})</option>`).join('');
  }

  function aplicarAjustesUI() {
    document.body.classList.toggle('rojo', aj.rojo);
    $('app').style.filter = aj.brillo < 100 ? `brightness(${aj.brillo / 100})` : '';
    C = colores();
    const enLista = Cielo.CIUDADES.some(([n]) => n === aj.ciudad);
    $('aj-ciudad').value = enLista ? aj.ciudad : '__otra';
    $('aj-lat').value = aj.lat; $('aj-lon').value = aj.lon;
    $('aj-cielo').value = aj.cielo;
    $('aj-minel').value = String(aj.minEl);
    $('aj-sol').value = String(aj.solMax);
    $('aj-terminar').value = aj.alTerminar;
    $('aj-starlink').checked = aj.starlink;
    $('aj-nombres').checked = aj.nombres;
    $('aj-rojo').checked = aj.rojo;
    $('aj-brillo').value = aj.brillo;
    $('aj-texto').value = aj.textoRadar;
    $('aj-grosor-c').value = aj.grosorCuadricula;
    $('aj-grosor-t').value = aj.grosorTrayectos;
    $('aj-texto-v').textContent = aj.textoRadar + '%';
    $('aj-grosor-c-v').textContent = aj.grosorCuadricula + '%';
    $('aj-grosor-t-v').textContent = aj.grosorTrayectos + '%';
    $('aj-texto-lista').value = aj.textoLista;
    $('aj-texto-lista-v').textContent = aj.textoLista + '%';
    document.documentElement.style.setProperty('--lista-px', (13 * aj.textoLista / 100).toFixed(1) + 'px');
    $('aj-nubes').value = aj.nubes;
    $('aj-aviso').value = String(aj.avisoMin);
    actualizarInfoNubes();
    document.documentElement.style.setProperty('--hud-px', (12 * (1 + (ft() - 1) * 0.4)).toFixed(1) + 'px');
    const oculto = !!aj.panelOculto;
    if ($('app').classList.contains('sin-panel') !== oculto) {
      $('app').classList.toggle('sin-panel', oculto);
      requestAnimationFrame(redimensionar);
    }
    const sinBarra = !!aj.barraOculta;
    if ($('app').classList.contains('sin-barra') !== sinBarra) {
      $('app').classList.toggle('sin-barra', sinBarra);
      requestAnimationFrame(redimensionar);
    }
    $('b-panel').classList.toggle('on', !oculto);
    $('b-panel').textContent = oculto ? '◧ Mostrar panel' : '◧ Ocultar panel';
    $('aj-son-visible').checked = aj.sonidoVisible;
    $('aj-vol-visible').value = aj.volVisible;
    $('aj-son-aviso').checked = aj.sonidoAviso;
    $('aj-vol-aviso').value = aj.volAviso;
    $('aj-nubes-on').checked = aj.nubesOn;
    $('aj-nubes').disabled = !aj.nubesOn;
    $('aj-maxpend').value = String(aj.maxPend);
    $('aj-estrellas').checked = aj.estrellas;
    $('aj-estrellas-mag').value = String(aj.estrellasMag);
    $('aj-estrellas-nombres').checked = aj.estrellasNombres;
    $('aj-vista').value = aj.vista;
    $('aj-planetas').checked = aj.planetas;
    $('rad-rango').value = aj.radRango;
    $('rad-radar').checked = aj.radRadar;
    $('rad-rig-on').checked = aj.rigOn;
    $('rad-host').value = aj.rigHost;
    $('rad-puerto').value = aj.rigPuerto;
    $('srv-celular').checked = aj.servCelular;
    $('srv-obs').checked = aj.servObs;
    $('srv-puerto').value = aj.servPuerto;
    $('act-url').value = aj.actUrl;
    $('stream-formato').value = aj.streamFormato;
    $('aj-aviso-cartel').checked = aj.avisoCartel;
    $('fotos-dias').value = String(aj.fotosDias);
    $('fotos-despejadas').checked = aj.fotosDespejadas;
    $('aj-guia').checked = aj.mostrarGuia;
    $('stream-lista').checked = aj.streamLista;
    $('stream-reloj').checked = aj.streamReloj;
    $('stream-nombres').checked = aj.streamNombres;
    $('stream-letra').value = aj.streamLetra;
    $('prox-sin-starlink').checked = aj.proxSinStarlink;
    const c = cieloElegido();
    const e = c.est;
    $('aj-cielo-info').textContent =
      `Estimado para tu ubicación: ${e.tipo.nombre.toLowerCase()} — cielo ≈ ${e.sqm.toFixed(1)} mag/arcsec², estrellas hasta mag ${e.nelm.toFixed(1)}. ` +
      `La que más ilumina: ${e.cercana.nombre} (${Math.round(e.cercana.d)} km). ` +
      (c.auto ? '' : `Usando: ${c.nombre.toLowerCase()} (mag ${c.nelm}).`);
    actualizarBotones();
    dibujar();
    actualizarHud();
    actualizarListaAhora();
    actualizarProximos();
  }

  function cambio(campo, conv, reconfig) {
    return (e) => {
      const el = e.target;
      aj[campo] = conv(el.type === 'checkbox' ? el.checked : el.value);
      guardarAjustes();
      aplicarAjustesUI();
      if (reconfig) enviarConfig();
    };
  }
  const id = (x) => x;
  $('aj-ciudad').onchange = (e) => {
    const c = Cielo.CIUDADES.find(([n]) => n === e.target.value);
    if (c) { $('aj-lat').value = c[1]; $('aj-lon').value = c[2]; }
  };
  $('aj-aplicar-ubic').onclick = () => {
    const lat = parseFloat($('aj-lat').value), lon = parseFloat($('aj-lon').value);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return;
    const sel = $('aj-ciudad').value;
    const c = Cielo.CIUDADES.find(([n]) => n === sel);
    aj.ciudad = c && Math.abs(c[1] - lat) < 0.01 && Math.abs(c[2] - lon) < 0.01 ? sel : 'Ubicación personalizada';
    aj.lat = lat; aj.lon = lon;
    guardarAjustes(); aplicarAjustesUI(); enviarConfig(); cargarClima();
    fotosClave = ''; pasesFotosLista = null; ultimoPedidoPasesFotos = 0;
    if (tabActiva === 'fotos') { pedirPasesFotos(); cargarFotos(true); }
  };
  $('aj-cielo').onchange = cambio('cielo', id, true);
  $('aj-minel').onchange = cambio('minEl', Number, true);
  $('aj-sol').onchange = cambio('solMax', Number, true);
  $('aj-terminar').onchange = cambio('alTerminar', id, true);
  $('aj-starlink').onchange = cambio('starlink', Boolean, true);
  $('aj-nombres').onchange = cambio('nombres', Boolean, false);
  $('aj-rojo').onchange = cambio('rojo', Boolean, false);
  $('aj-brillo').oninput = cambio('brillo', Number, false);
  const conRedim = (fn) => (e) => { fn(e); redimensionar(); };
  $('aj-texto').oninput = conRedim(cambio('textoRadar', Number, false));
  $('aj-grosor-c').oninput = cambio('grosorCuadricula', Number, false);
  $('aj-grosor-t').oninput = cambio('grosorTrayectos', Number, false);
  $('aj-texto-lista').oninput = (e) => { cambio('textoLista', Number, false)(e); actualizarListaLateral(); };
  $('aj-nubes').onchange = (e) => { cambio('nubes', id, true)(e); if (aj.nubes === 'auto') cargarClima(); };
  $('aj-aviso').onchange = cambio('avisoMin', Number, false);
  $('aviso-pase').onclick = () => ($('aviso-pase').hidden = true);
  $('aj-restablecer-vista').onclick = () => {
    aj.textoRadar = 100; aj.grosorCuadricula = 100; aj.grosorTrayectos = 100; aj.textoLista = 120;
    guardarAjustes(); aplicarAjustesUI(); redimensionar();
  };
  function alternarPanel() { aj.panelOculto = !aj.panelOculto; guardarAjustes(); aplicarAjustesUI(); actualizarListaLateral(); }
  function alternarBarra() { aj.barraOculta = !aj.barraOculta; guardarAjustes(); aplicarAjustesUI(); }
  $('b-panel').onclick = alternarPanel;
  $('b-cerrar-panel').onclick = alternarPanel;
  $('b-ocultar-barra').onclick = alternarBarra;
  $('b-mostrar-barra').onclick = alternarBarra;
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'p' || e.key === 'P') alternarPanel();
    if (e.key === 'b' || e.key === 'B') alternarBarra();
  });
  $('aj-son-visible').onchange = cambio('sonidoVisible', Boolean, false);
  $('aj-vol-visible').oninput = cambio('volVisible', Number, false);
  $('aj-son-aviso').onchange = cambio('sonidoAviso', Boolean, false);
  $('aj-vol-aviso').oninput = cambio('volAviso', Number, false);
  $('aj-probar-visible').onclick = () => { ultimoPing = 0; ping(true); };
  $('aj-probar-aviso').onclick = () => campana(true);
  $('aj-nubes-on').onchange = (e) => { cambio('nubesOn', Boolean, true)(e); if (aj.nubesOn && aj.nubes === 'auto') cargarClima(); };
  $('aj-maxpend').onchange = cambio('maxPend', Number, false);
  $('aj-estrellas').onchange = cambio('estrellas', Boolean, false);
  $('aj-estrellas-mag').onchange = cambio('estrellasMag', Number, false);
  $('aj-estrellas-nombres').onchange = cambio('estrellasNombres', Boolean, false);
  $('aj-vista').onchange = cambio('vista', id, false);
  $('aj-planetas').onchange = cambio('planetas', Boolean, false);
  $('obs-usar').onchange = cambio('usarAprendido', Boolean, true);
  $('obs-borrar').onclick = () => { aj.observaciones = []; guardarAjustes(); enviarConfig(); actualizarObsUI(); actualizarListaAhora(); };
  $('rad-rango').onchange = (e) => { cambio('radRango', id, false)(e); actualizarRadio(); actualizarRadioProx(); };
  $('rad-radar').onchange = cambio('radRadar', Boolean, false);
  $('rad-rig-on').onchange = (e) => { cambio('rigOn', Boolean, false)(e); if (!aj.rigOn && window.api && window.api.rigSoltar) window.api.rigSoltar(); };
  $('rad-host').onchange = cambio('rigHost', (v) => String(v).trim() || '127.0.0.1', false);
  $('rad-puerto').onchange = cambio('rigPuerto', (v) => +v || 4532, false);
  $('srv-celular').onchange = (e) => { cambio('servCelular', Boolean, false)(e); aplicarServidor(); };
  $('srv-obs').onchange = (e) => { cambio('servObs', Boolean, false)(e); aplicarServidor(); };
  $('srv-puerto').onchange = (e) => { cambio('servPuerto', (v) => Math.min(65535, Math.max(1024, +v || 8770)), false)(e); aplicarServidor(); };
  $('act-url').onchange = cambio('actUrl', (v) => String(v).trim(), false);
  $('aj-aviso-cartel').onchange = cambio('avisoCartel', Boolean, false);
  $('fotos-dias').onchange = (e) => { cambio('fotosDias', Number, false)(e); cargarFotos(true); };
  $('fotos-despejadas').onchange = (e) => { cambio('fotosDespejadas', Boolean, false)(e); mostrarFotos(); };
  $('aj-guia').onchange = (e) => { cambio('mostrarGuia', Boolean, false)(e); actualizarListaLateral(); };
  $('stream-formato').onchange = (e) => { cambio('streamFormato', id, false)(e); aplicarServidor(); };
  $('stream-lista').onchange = (e) => { cambio('streamLista', Boolean, false)(e); aplicarServidor(); };
  $('stream-reloj').onchange = (e) => { cambio('streamReloj', Boolean, false)(e); aplicarServidor(); };
  $('stream-nombres').onchange = (e) => { cambio('streamNombres', Boolean, false)(e); aplicarServidor(); };
  $('stream-letra').oninput = (e) => { cambio('streamLetra', Number, false)(e); aplicarServidor(); };
  $('aj-actualizar').onclick = () => cargarDatos(true);
  $('prox-sin-starlink').onchange = (e) => { aj.proxSinStarlink = e.target.checked; guardarAjustes(); actualizarProximos(); };

  // ---------- Cuenta Space-Track ----------
  async function refrescarCuenta() {
    if (!window.api) { $('st-estado').textContent = 'Disponible en la app de Windows.'; return; }
    const c = await window.api.cuentaEstado();
    const f = datosInfo && (datosInfo.fuentes || []).find((x) => x.id === 'spacetrack');
    const fallo = c && f && f.error && !f.fecha;
    $('st-desconectado').hidden = !!c && !fallo;
    $('st-conectado').hidden = !c || fallo;
    if (c) $('st-quien').textContent = 'Conectado como ' + c.usuario + (f && f.fecha ? ` · ${(f.cantidad || 0).toLocaleString('es-AR')} objetos, ${edadTexto(Date.now() - f.fecha)}` : '');
    if (fallo) { $('st-usuario').value = c.usuario; $('st-estado').textContent = 'No se pudo conectar: ' + f.error + '. Revisá el usuario y la contraseña.'; }
    else $('st-estado').textContent = c ? '' : 'Sin cuenta configurada.';
  }
  $('st-guardar').onclick = async () => {
    const usuario = $('st-usuario').value.trim(), clave = $('st-clave').value;
    if (!usuario || !clave || !window.api) return;
    await window.api.cuentaGuardar({ usuario, clave });
    $('st-clave').value = '';
    $('st-estado').textContent = 'Conectando y descargando el catálogo…';
    await cargarDatos(true);
    await refrescarCuenta();
  };
  $('st-borrar').onclick = async () => { if (window.api) await window.api.cuentaBorrar(); $('st-clave').value = ''; refrescarCuenta(); };

  // ---------- Bucle ----------
  let esperando = false;
  let enviadoEn = 0;
  function tic() {
    // No encolar pedidos si el motor todavía está calculando el anterior
    if (cargado && (!esperando || performance.now() - enviadoEn > 5000)) {
      esperando = true;
      enviadoEn = performance.now();
      motor.postMessage({ tipo: 'tic', t: ahoraSim(), radio: tabActiva === 'radio' || aj.radRadar || !!radioSel });
    }
    actualizarReloj();
  }

  // Abierto desde el celular u OBS: los datos vienen del servidor de la PC
  async function detectarWeb() {
    if (window.api || !/^https?:$/.test(location.protocol)) return;
    try {
      const j = await (await fetch('/api/ping')).json();
      if (!j || !j.satradar) return;
    } catch { return; }
    modoWeb = true;
    document.body.classList.add('web');
    let cache = null, cuando = 0;
    const datos = async () => {
      if (!cache || Date.now() - cuando > 10 * 60000) { cache = await (await fetch('/api/datos')).json(); cuando = Date.now(); }
      return cache;
    };
    window.api = {
      copiaDatos: datos,
      obtenerDatos: datos,
      leerAjustes: async () => {
        let srv = {}, loc = {};
        try { srv = await (await fetch('/api/ajustes')).json(); } catch {}
        if (!modoObs) try { loc = JSON.parse(localStorage.getItem('satradar-celular-2') || 'null') || { panelOculto: true, barraOculta: false }; } catch {}
        // Tamaños y paneles son de cada pantalla: el celular no hereda los de la PC
        if (!modoObs) for (const k of ['textoRadar', 'textoLista', 'grosorCuadricula', 'grosorTrayectos', 'panelOculto', 'barraOculta', 'brillo']) delete srv[k];
        return { ...srv, ...loc, observaciones: (loc.observaciones || srv.observaciones || []) };
      },
      guardarAjustes: async (a) => { if (!modoObs) try { localStorage.setItem('satradar-celular-2', JSON.stringify(a)); } catch {} },
      clima: async (lat, lon) => (await fetch(`/api/clima?lat=${lat}&lon=${lon}`)).json(),
      cuentaEstado: async () => null,
      fotos: async (lat, lon, dias) => (await fetch(`/api/fotos?lat=${lat}&lon=${lon}&dias=${dias}`)).json(),
    };
  }

  async function iniciar() {
    await detectarWeb();
    const guardados = (await leerAjustes()) || {};
    aj = { ...DEFECTO, ...guardados };
    // Ajustes de versiones anteriores
    if (guardados.sonidoVisible === undefined && guardados.sonido !== undefined) {
      aj.sonidoVisible = !!guardados.sonido;
      aj.volVisible = guardados.volumen ?? 40;
    }
    if (aj.nubes === 'despejado') { aj.nubes = 'auto'; aj.nubesOn = false; }
    llenarSelects();
    window.addEventListener('resize', redimensionar);
    redimensionar();
    aplicarAjustesUI();
    refrescarCuenta();
    cargarClima();
    if (modoObs) {
      aj.panelOculto = true; aj.barraOculta = true; aj.silencio = true; aj.avisoMin = 0; aj.rojo = false; aj.brillo = 100;
      if (params.get('lista') === '0') document.body.classList.add('sin-lista');
      if (params.get('reloj') === '0') document.body.classList.add('sin-reloj');
      if (params.get('nombres') === '0') aj.nombres = false;
      const letra = +params.get('letra');
      if (letra >= 50 && letra <= 300) { aj.textoRadar = letra; aj.textoLista = letra; }
      aplicarAjustesUI();
      redimensionar();
    }
    aplicarServidor();
    if (window.api && window.api.version) window.api.version().then((v) => ($('act-version').textContent = 'Versión instalada: ' + v));
    setTimeout(() => buscarActualizacion(true), 8000);
    actualizarObsUI();
    setInterval(tic, 250);
    cargarDatos(false);
    tic();
  }
  iniciar();
})();
