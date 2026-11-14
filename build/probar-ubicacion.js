// Prueba en Windows (GitHub Actions) que el script de ubicación de main.js corre sin errores de sintaxis.
const fs = require('fs');
const { execFileSync } = require('child_process');
const s = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
const m = s.match(/const SCRIPT_UBICACION = `([\s\S]*?)`;\r?\n/);
const script = eval('`' + m[1] + '`');
const cod = Buffer.from(script, 'utf16le').toString('base64');
const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', cod], { timeout: 60000 }).toString();
console.log('Salida:', out);
const j = JSON.parse(out.trim().split(/\r?\n/).pop());
if (j.error1 && /parse|token|sintax|syntax/i.test(j.error1)) process.exit(1);
