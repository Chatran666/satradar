const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  obtenerDatos: (forzar) => ipcRenderer.invoke('datos:obtener', forzar),
  copiaDatos: () => ipcRenderer.invoke('datos:copia'),
  alAvisoDatos: (fn) => ipcRenderer.on('datos:aviso', (_e, info) => fn(info)),
  leerAjustes: () => ipcRenderer.invoke('ajustes:leer'),
  guardarAjustes: (a) => ipcRenderer.invoke('ajustes:guardar', a),
  cuentaEstado: () => ipcRenderer.invoke('cuenta:estado'),
  cuentaGuardar: (c) => ipcRenderer.invoke('cuenta:guardar', c),
  cuentaBorrar: () => ipcRenderer.invoke('cuenta:borrar'),
  clima: (lat, lon) => ipcRenderer.invoke('clima:obtener', lat, lon),
  llamarAtencion: () => ipcRenderer.send('ventana:llamar'),
  servidor: (a) => ipcRenderer.invoke('servidor:config', a),
  rigFrecuencia: (host, puerto, hz) => ipcRenderer.invoke('rig:frecuencia', host, puerto, hz),
  rigSoltar: () => ipcRenderer.invoke('rig:soltar'),
  buscarActualizacion: (url) => ipcRenderer.invoke('act:buscar', url),
  instalarActualizacion: (url) => ipcRenderer.invoke('act:instalar', url),
  alProgresoActualizacion: (fn) => ipcRenderer.on('act:progreso', (_e, v) => fn(v)),
  version: () => ipcRenderer.invoke('app:version'),
  copiar: (txt) => ipcRenderer.invoke('portapapeles', txt),
  abrirLocal: (url) => ipcRenderer.invoke('abrir:local', url),
});
