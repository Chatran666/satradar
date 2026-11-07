// Posición aproximada del Sol y la Luna (vectores ECI en km, ecuador de la fecha).
// Precisión de minutos de arco: alcanza de sobra para sombra y fase.
(function (root) {
  const AU = 149597870.7;
  const R_EARTH = 6378.137;
  const rad = (d) => (d * Math.PI) / 180;
  const sinD = (d) => Math.sin(rad(d));
  const cosD = (d) => Math.cos(rad(d));

  function julian(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }

  function sunEci(date) {
    const n = julian(date) - 2451545.0;
    const L = 280.46 + 0.9856474 * n;
    const g = rad(357.528 + 0.9856003 * n);
    const lam = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
    const eps = rad(23.439 - 0.0000004 * n);
    const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
    return {
      x: R * Math.cos(lam),
      y: R * Math.cos(eps) * Math.sin(lam),
      z: R * Math.sin(eps) * Math.sin(lam),
    };
  }

  function moonEci(date) {
    const T = (julian(date) - 2451545.0) / 36525;
    const lam =
      218.32 + 481267.881 * T +
      6.29 * sinD(135.0 + 477198.87 * T) -
      1.27 * sinD(259.3 - 413335.36 * T) +
      0.66 * sinD(235.7 + 890534.22 * T) +
      0.21 * sinD(269.9 + 954397.74 * T) -
      0.19 * sinD(357.5 + 35999.05 * T) -
      0.11 * sinD(186.5 + 966404.03 * T);
    const bet =
      5.13 * sinD(93.3 + 483202.02 * T) +
      0.28 * sinD(228.2 + 960400.89 * T) -
      0.28 * sinD(318.3 + 6003.15 * T) -
      0.17 * sinD(217.6 - 407332.21 * T);
    const par =
      0.9508 +
      0.0518 * cosD(135.0 + 477198.87 * T) +
      0.0095 * cosD(259.3 - 413335.36 * T) +
      0.0078 * cosD(235.7 + 890534.22 * T) +
      0.0028 * cosD(269.9 + 954397.74 * T);
    const r = R_EARTH / sinD(par);
    const l = cosD(bet) * cosD(lam);
    const m = 0.9175 * cosD(bet) * sinD(lam) - 0.3978 * sinD(bet);
    const n = 0.3978 * cosD(bet) * sinD(lam) + 0.9175 * sinD(bet);
    return { x: r * l, y: r * m, z: r * n, lon: ((lam % 360) + 360) % 360 };
  }

  function sunEclLon(date) {
    const n = julian(date) - 2451545.0;
    const g = rad(357.528 + 0.9856003 * n);
    const L = 280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
    return ((L % 360) + 360) % 360;
  }

  // Fracción iluminada de la Luna y si está creciente
  function moonPhase(date) {
    const s = sunEci(date), m = moonEci(date);
    const ns = Math.hypot(s.x, s.y, s.z), nm = Math.hypot(m.x, m.y, m.z);
    const cosE = (s.x * m.x + s.y * m.y + s.z * m.z) / (ns * nm);
    const illum = (1 - cosE) / 2;
    const d = (((m.lon - sunEclLon(date)) % 360) + 360) % 360;
    return { illum, waxing: d < 180 };
  }

  root.Astro = { sunEci, moonEci, moonPhase, julian, R_EARTH, AU };
})(typeof self !== 'undefined' ? self : this);
