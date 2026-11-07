// Ciudades (también usadas como ubicaciones rápidas) y estimación de
// contaminación lumínica por población cercana (ley de Walker).
(function (root) {
  // [nombre, lat, lon, habitantes aprox. del aglomerado]
  const CIUDADES = [
    ['Buenos Aires (CABA)', -34.6037, -58.3816, 15600000],
    ['Córdoba', -31.4201, -64.1888, 1600000],
    ['Rosario', -32.9442, -60.6505, 1350000],
    ['Mendoza', -32.8895, -68.8458, 1100000],
    ['San Miguel de Tucumán', -26.8083, -65.2176, 950000],
    ['La Plata', -34.9214, -57.9545, 900000],
    ['Mar del Plata', -38.0055, -57.5426, 680000],
    ['Salta', -24.7821, -65.4232, 650000],
    ['Santa Fe', -31.6333, -60.7, 530000],
    ['San Juan', -31.5375, -68.5364, 500000],
    ['Resistencia', -27.4606, -58.9839, 430000],
    ['Neuquén', -38.9516, -68.0591, 400000],
    ['Santiago del Estero', -27.7951, -64.2615, 400000],
    ['Corrientes', -27.4692, -58.8306, 400000],
    ['Posadas', -27.3671, -55.8961, 370000],
    ['San Salvador de Jujuy', -24.1858, -65.2995, 330000],
    ['Bahía Blanca', -38.7183, -62.2663, 310000],
    ['Paraná', -31.7319, -60.5238, 280000],
    ['Formosa', -26.1775, -58.1781, 250000],
    ['Catamarca', -28.4696, -65.7795, 230000],
    ['San Luis', -33.3017, -66.3378, 200000],
    ['La Rioja', -29.4131, -66.8558, 200000],
    ['Comodoro Rivadavia', -45.8641, -67.4966, 200000],
    ['Zárate-Campana', -34.1, -59.03, 200000],
    ['Río Cuarto', -33.1307, -64.3499, 170000],
    ['Concordia', -31.3929, -58.0209, 170000],
    ['San Nicolás', -33.3343, -60.2253, 150000],
    ['Tandil', -37.3217, -59.1332, 130000],
    ['San Carlos de Bariloche', -41.1335, -71.3103, 130000],
    ['Santa Rosa', -36.6167, -64.2833, 120000],
    ['San Rafael', -34.6177, -68.3301, 120000],
    ['Pergamino', -33.8899, -60.5736, 100000],
    ['Rafaela', -31.2526, -61.4867, 100000],
    ['Villa María', -32.4075, -63.2402, 100000],
    ['Puerto Madryn', -42.7692, -65.0385, 100000],
    ['Trelew', -43.2532, -65.3094, 100000],
    ['Río Gallegos', -51.6226, -69.2181, 100000],
    ['Gualeguaychú', -33.0094, -58.5172, 100000],
    ['Luján', -34.5703, -59.105, 100000],
    ['Junín', -34.5838, -60.9433, 90000],
    ['Olavarría', -36.8927, -60.3225, 90000],
    ['Necochea', -38.5545, -58.7396, 90000],
    ['Ushuaia', -54.8019, -68.303, 80000],
    ['Venado Tuerto', -33.7456, -61.9688, 80000],
    ['Villa Carlos Paz', -31.4241, -64.4978, 70000],
    ['Viedma', -40.8135, -62.9967, 60000],
    ['Esquel', -42.9115, -71.3197, 35000],
    ['El Calafate', -50.3379, -72.2648, 25000],
    // Vecinos que iluminan el cielo argentino cerca de la frontera
    ['Montevideo (UY)', -34.9011, -56.1645, 1400000],
    ['Santiago (CL)', -33.4489, -70.6693, 7000000],
    ['Asunción (PY)', -25.2637, -57.5759, 2300000],
  ];

  function distKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a =
      Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  // Brillo del cielo en mag/arcsec² y magnitud límite a ojo desnudo
  function estimarCielo(lat, lon) {
    let ratio = 0;
    let cercana = null;
    for (const [nombre, la, lo, pob] of CIUDADES) {
      const radio = 0.28 * Math.sqrt(pob / 1000); // km, tamaño aprox. de la mancha urbana
      const d = Math.max(distKm(lat, lon, la, lo), radio);
      const aporte = 0.01 * pob * Math.pow(d, -2.5);
      ratio += aporte;
      if (!cercana || aporte > cercana.aporte) cercana = { nombre, aporte, d: distKm(lat, lon, la, lo) };
    }
    const sqm = 21.9 - 2.5 * Math.log10(1 + ratio);
    const nelm = sqmANelm(sqm);
    return { sqm, nelm, ratio, cercana, tipo: tipoPorNelm(nelm) };
  }

  function sqmANelm(sqm) {
    return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1);
  }

  const TIPOS = [
    { id: 'ciudad-grande', nombre: 'Centro de ciudad grande', nelm: 3.8 },
    { id: 'ciudad', nombre: 'Ciudad', nelm: 4.4 },
    { id: 'suburbio', nombre: 'Suburbio', nelm: 5.0 },
    { id: 'rural', nombre: 'Rural', nelm: 5.8 },
    { id: 'oscuro', nombre: 'Campo muy oscuro', nelm: 6.5 },
  ];

  function tipoPorNelm(n) {
    let mejor = TIPOS[0];
    for (const t of TIPOS) if (Math.abs(t.nelm - n) < Math.abs(mejor.nelm - n)) mejor = t;
    return mejor;
  }

  root.Cielo = { CIUDADES, TIPOS, estimarCielo, distKm };
})(typeof self !== 'undefined' ? self : this);
