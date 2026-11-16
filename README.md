# Tutor de Entradas y Salidas

Replay de la sesión de NQ y MNQ vela por vela, con un tutor que marca niveles y eventos
(ORB, PDH/PDL, Londres, Asia, FVG, iFVG, falsos rompimientos, rechazos), indicadores,
perfil de volumen y operación manual simulada.

Es una sola página (`index.html`) que se publica con GitHub Pages. Los datos son velas de
1 minuto de Yahoo Finance que una tarea programada descarga y guarda en `data/`.

## Puesta en marcha (una sola vez)

1. **Publicar la página:** en el repositorio, *Settings → Pages → Build and deployment*,
   elige *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
2. **Primera carga de datos:** en *Actions → Actualizar datos de Yahoo → Run workflow*.
   Tarda cerca de un minuto y crea `data/index.json` y los archivos de cada día.
3. Abre la dirección que muestra *Settings → Pages*. Mientras no haya datos, la página
   muestra una sesión simulada marcada como "Ejemplo simulado".

Si la tarea falla al guardar, revisa *Settings → Actions → General → Workflow permissions*
y marca *Read and write permissions*.

## Cómo se actualiza

- `.github/workflows/actualizar-datos.yml` está programada cada 15 minutos de lunes a viernes.
  GitHub no garantiza las corridas programadas y se salta varias; por eso se piden tan seguidas.
- `scripts/update_data.py` pide a Yahoo la última semana de velas de 1 minuto de `NQ=F` y
  `MNQ=F`, y la mezcla con lo guardado. El historial crece con el tiempo.
- Para cambiar la frecuencia, edita la línea `cron` del flujo.

## Límites de los datos de Yahoo

- Velas de 1 minuto solo de la última semana por consulta y de un mes hacia atrás como
  máximo. El historial anterior al primer día de uso no se puede recuperar por esta vía.
- Es el contrato continuo, con retraso, y sin lado agresor de las operaciones.
- `yfinance` no es una vía oficial: de vez en cuando deja de funcionar hasta que lo
  actualizan. Si la tarea falla, GitHub avisa por correo.
- Los términos de Yahoo están pensados para uso personal. Revísalos si el sitio va a ser
  público o parte de un producto.

## Desarrollo

```
node build.js              # arma index.html a partir de src/
node test/engine.test.js   # pruebas del motor de detección
```

- `src/engine.js`: motor de detección (niveles, eventos, operaciones del tutor, perfil).
- `src/app.js`: gráfico, indicadores, reproducción, operación manual, carga de datos.
- `src/page.html`: estructura y estilos.

Las reglas del tutor son mecánicas y sirven para estudiar. No es una recomendación de operar.
