# Baby Monitor — Diseño

Fecha: 2026-10-08 · Estado: pendiente de revisión

## Objetivo

Usar un iPad como cámara fija frente al bebé y un iPhone como monitor, ambos con Safari, sin app nativa de iOS.

**Criterio de éxito:** desde el iPhone, en la misma WiFi, se ve y se oye al bebé en directo (latencia < 1 s). Si el iPad deja de transmitir, el iPhone lo indica de forma inequívoca.

## Alcance

**Incluido:**
- Vídeo y audio en directo iPad → iPhone.
- Solo WiFi local.
- Web app (dos páginas).
- Estado de conexión visible y alarma si se pierde la señal.

**Excluido (YAGNI):**
- Acceso fuera de casa.
- Aviso de llanto.
- Audio bidireccional.
- Grabación o historial.
- Cuentas y login.
- Reproducción con el iPhone bloqueado.

## Arquitectura

```
iPad (Safari)   --/camara-->  ┐
                              ├─ NPM .65 (HTTPS) → contenedor "baby-monitor" (LXC 118)
iPhone (Safari) --/monitor--> ┘        └─ WebSocket de señalización (solo SDP/ICE)

Vídeo + audio: WebRTC directo iPad ↔ iPhone por la LAN. No pasa por el servidor.
```

### Componentes

1. **Servidor Node (sin framework, ~100 líneas)**
   - Sirve las páginas estáticas `/camara` y `/monitor`.
   - Endpoint WebSocket de señalización con una única sala fija: un rol `camara` y un rol `monitor`.
   - Reenvía mensajes SDP/ICE entre ambos roles.
   - Si entra un segundo cliente con el mismo rol, reemplaza al anterior.
2. **`/camara` (iPad)**: captura cámara y micrófono, mantiene Wake Lock, envía el stream al monitor.
3. **`/monitor` (iPhone)**: recibe y muestra el stream, controla el sonido, detecta señal perdida.
4. **HTTPS**: certificado de `bebe.lhomelab.casa` en NPM, con validación DNS-01 por Cloudflare. Registro DNS local en Pi-hole (.38) que apunta a NPM (.65). Safari solo concede cámara y micrófono en HTTPS.

### Seguridad

- Solo LAN: no se expone por Cloudflare Tunnel.
- Sin login en la v1, porque no hay acceso externo.
- Si más adelante se permite acceso por Tailscale, añadir un PIN antes de abrirlo.

## Pantallas

### `/camara` (iPad)
- Inicio: botón grande "Iniciar cámara". Es necesario por el gesto de usuario que exige Safari.
- En marcha: vista previa pequeña, fondo oscuro, indicador "Monitor conectado" o "Esperando monitor", texto fijo "Mantén el iPad enchufado".
- Wake Lock activo. Se vuelve a solicitar si Safari lo libera.

### `/monitor` (iPhone)
- Inicio: botón "Conectar" (gesto de usuario necesario para reproducir con sonido).
- En marcha: vídeo a pantalla completa, icono de sonido, punto de estado (verde conectado, ámbar reconectando, rojo sin señal).
- Limitación documentada: con la pantalla del iPhone bloqueada Safari corta el stream.

## Fallos y comportamiento

| Caso | Comportamiento |
|---|---|
| Monitor abierto antes que la cámara | "Esperando cámara…" y conexión automática al aparecer. |
| Caída breve del WiFi | Reintento periódico en ambos lados; punto ámbar. |
| iPad cerrado o bloqueado | Monitor en rojo con alarma visual (parpadeo) y sonora (pitido WebAudio, silenciable). Safari en iOS no soporta la API de vibración. |
| Stream parado con WebSocket vivo | Se detecta por frames que no cambian y se renegocia. |
| Permisos denegados | Mensaje claro en el iPad con instrucciones. |

Principio: el monitor nunca debe mostrar una imagen congelada como si fuera normal. Verifica que los frames avanzan, no solo que exista conexión.

## Riesgos y puntos a verificar

1. **HTTPS en LAN**: no hay certificado interno documentado; hay que montarlo (NPM DNS-01 + Pi-hole) y comprobar que Safari lo acepta sin avisos.
2. **Aislamiento de clientes o mDNS en la UDM**: puede impedir la conexión WebRTC directa. Se prueba pronto. Plan B: usar go2rtc como relé.
3. **Wake Lock en el iPad**: requiere iOS ≥ 16.4. Verificar la versión del iPad.
4. **Investigación pendiente**: `gh` no está autenticado. La búsqueda de bases existentes queda por hacer con búsqueda web.

## Pruebas

- **Automáticas:** servidor de señalización (sala única, reemplazo de rol, reenvío de mensajes, desconexión).
- **Manuales con dispositivos reales:**
  - Conexión directa en LAN.
  - Reconexión tras cortar el WiFi.
  - 30 minutos con el iPad enchufado sin que se duerma.
  - Detección de iPad bloqueado.

## Ubicación y despliegue

- Código en `/Downloads/Docker/baby-monitor/`. El mismo directorio se ve en LXC 118 como `/Data/Docker/baby-monitor/`.
- Despliegue con `docker compose up -d` en LXC 118, como el resto de stacks.
- Documentar en `info/stacks.md` y `CHANGELOG.md` tras desplegar.
