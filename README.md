# SatRadar

Radar de satélites visibles a ojo desnudo para Windows: muestra en un radar los satélites que se pueden ver desde tu ubicación, teniendo en cuenta el Sol, la sombra de la Tierra, la contaminación lumínica, la Luna y las nubes.

## Descargar

Bajá el instalador de la última versión en **[Releases](../../releases/latest)** (`SatRadar-Setup-X.Y.Z.exe`).
La app se actualiza sola: cuando hay una versión nueva aparece un cartel con el botón *Instalar ahora*.

> Windows puede mostrar "Windows protegió su PC" porque el instalador no está firmado: tocá **Más información → Ejecutar de todas formas**.

## Qué hace

- Radar con los satélites visibles a ojo desnudo desde tu ubicación (amarillo) y los que están por hacerse visibles (rojo).
- Próximos pases con hora exacta al segundo, guía con estrellas y planetas, y aviso antes de cada pase.
- Planificador de las próximas 7 noches, trenes de Starlink, pestaña de radio para SDR (con Doppler y rigctl).
- **Fotos reales**: las imágenes que Sentinel-2 y Landsat tomaron de tu ubicación, con las nubes sobre tu punto y el pase que las sacó.
- Ver en el celular (misma red WiFi) y vista con fondo transparente para OBS.

## Datos y créditos

- Órbitas: CelesTrak y Space-Track (opcional) · Brillo: McCants y GCAT · Radio: SatNOGS · Nubes: Open-Meteo · Estrellas: Hipparcos (vía d3-celestial, BSD-3).
- Imágenes: contienen datos modificados de Copernicus Sentinel-2 (ESA) y Landsat (USGS/NASA), obtenidos vía Microsoft Planetary Computer.
- La búsqueda exacta de pases y la idea de las fotos se basan en [Watched](https://github.com/dev-Armaan/satellites), de Armaan Gupta (licencia MIT).
