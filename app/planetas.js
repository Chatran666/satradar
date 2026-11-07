// Posiciones aproximadas de los planetas (elementos keplerianos de JPL, 1800-2050)
(function (root) {
  const EL = {
    Mercurio: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
    Venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
    Tierra: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
    Marte: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
    'Júpiter': [5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
    Saturno: [9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  };
  const R = Math.PI / 180;
  function helio(nombre, T) {
    const e0 = EL[nombre];
    const a = e0[0] + e0[1] * T, e = e0[2] + e0[3] * T, I = (e0[4] + e0[5] * T) * R;
    const L = e0[6] + e0[7] * T, w = e0[8] + e0[9] * T, O = e0[10] + e0[11] * T;
    let M = (((L - w) % 360) + 540) % 360 - 180;
    const wp = (w - O) * R, Or = O * R;
    M *= R;
    let E = M + e * Math.sin(M);
    for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(wp), sw = Math.sin(wp), cO = Math.cos(Or), sO = Math.sin(Or), cI = Math.cos(I), sI = Math.sin(I);
    return {
      x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      z: sw * sI * xp + cw * sI * yp,
    };
  }
  const MAGS = {
    Mercurio: (i) => -0.42 + 0.038 * i - 0.000273 * i * i + 0.000002 * i * i * i,
    Venus: (i) => -4.4 + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i,
    Marte: (i) => -1.52 + 0.016 * i,
    'Júpiter': (i) => -9.4 + 0.005 * i,
    Saturno: () => -8.88,
  };
  // RA/Dec J2000 (grados) y magnitud de cada planeta
  function planetas(t) {
    const T = (t / 86400000 + 2440587.5 - 2451545.0) / 36525;
    const tierra = helio('Tierra', T);
    const eps = 23.43928 * R;
    const out = [];
    for (const n of Object.keys(MAGS)) {
      const p = helio(n, T);
      const gx = p.x - tierra.x, gy = p.y - tierra.y, gz = p.z - tierra.z;
      const xe = gx, ye = gy * Math.cos(eps) - gz * Math.sin(eps), ze = gy * Math.sin(eps) + gz * Math.cos(eps);
      const delta = Math.hypot(xe, ye, ze), r = Math.hypot(p.x, p.y, p.z), rt = Math.hypot(tierra.x, tierra.y, tierra.z);
      const ra = ((Math.atan2(ye, xe) / R) + 360) % 360, dec = Math.asin(ze / delta) / R;
      const cosi = (r * r + delta * delta - rt * rt) / (2 * r * delta);
      const i = Math.acos(Math.max(-1, Math.min(1, cosi))) / R;
      out.push({ nombre: n, ra, dec, mag: MAGS[n](i) + 5 * Math.log10(r * delta) });
    }
    return out;
  }
  root.Planetas = { planetas };
})(typeof self !== 'undefined' ? self : this);
