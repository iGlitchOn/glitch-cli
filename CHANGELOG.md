# Changelog — Glitch CLI

## v0.2.0

- **Autocompactación**: Compactación automática del historial de contexto al superar el umbral configurable (`10%–95%`, por defecto `70%`) preservando el resumen estructurado de la sesión.
- **Deshacer/Rehacer**: Soporte de `Ctrl+Z` (deshacer) y `Ctrl+Y` / `Ctrl+Shift+Z` (rehacer) en el editor de entrada con agrupación inteligente y sincronización de imágenes adjuntas.
- **Cola de espera**: Cola FIFO (`Queue`) para encolar múltiples mensajes mientras el agente responde, con navegación `↑`/`↓`, edición en su misma posición y confirmación antes de borrar.
- **Reintentos**: Reintentos automáticos con backoff exponencial ante cortes de red o errores transitorios en llamadas y streaming sin perder el conteo de tokens consumidos.
- **Layout**: Interfaz TUI a pantalla completa (`process.stdout.rows`) en alternate screen con encabezado fijo superior (oculto si `< 12` filas), historial central desplazable con rueda del mouse/`Re Pág`/`Av Pág` y barra inferior anclada al borde de la ventana.
- **Pegado**: Conservación de saltos de línea al pegar texto multilínea (`Ctrl+V` o click derecho) usando Bracketed Paste Mode (`\x1b[200~`..`\x1b[201~`) como un solo bloque y un único paso de deshacer sin enviar el mensaje accidentalmente.

## v0.1.0

- Versión inicial de Glitch CLI con soporte para Vertex AI, endpoints personalizados, estilos visuales `/tui`, herramientas nativas de agente, skills y servidores MCP.
