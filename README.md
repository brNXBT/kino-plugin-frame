# Frame — plugin de Kino

Películas, series y anime desde frameXTV, con subtítulos en español. El audio suele venir en inglés.

Ofrece los mismos servidores que la página (Super Barbarian, Headhunter, Bowler, Miner, Valkyrie, Hog Rider, Lava Hound y Backup), otras copias del video y todos los idiomas de subtítulos que entrega frameXTV. Algunos servidores fallan según el día: prueba otro desde el menú de servidores.

- **Catálogo:** TMDB, a través de `kino.tmdb` (necesita Kino 0.9.53 o más nuevo; no lleva ninguna llave).
- **Video:** el servidor de frameXTV (`api.framextv.tech`), que responde por el número de TMDB. Los videos salen de servidores que cambian, por eso el plugin pide permiso para reproducir desde cualquier servidor (`streamHosts: "any"`).
- **No pide ajustes, usuario ni contraseña.**

## Instalar

En Kino: menú ☰ → Plugins → botón **+** (en el televisor: Ajustes → Plugins → Agregar), escribe `brNXBT/kino-plugin-frame`, toca **Agregar**, lee la hoja y toca **Instalar**.

## Probar en local

```
node sdk/validate.mjs .
node sdk/run.mjs . resolve movie:603
node sdk/run.mjs . resolve tv:1396:1:1
node --test test/plugin.test.mjs
```

Las pruebas corren sin conexión: `resolve` usa una grabación real de la API (`test/fixtures.json`) y el catálogo usa respuestas de TMDB escritas a mano.

## Referencias de títulos

`movie:<tmdb>` · `tv:<tmdb>` (una serie) · `tv:<tmdb>:<temporada>:<capítulo>` (un capítulo)
