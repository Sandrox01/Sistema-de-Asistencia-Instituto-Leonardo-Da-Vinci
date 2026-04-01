# Sistema de Asistencia Instituto Leonardo Da Vinci

Aplicación full-stack para marcar asistencia docente, registrar incidencias y administrar periodos académicos del Instituto Leonardo Da Vinci. El backend en Express expone todas las API REST y sirve el frontend estático (páginas en `pages/`). El sistema opera totalmente desde `http://localhost:3000`, realizando marcaciones en vivo y refrescando el panel administrativo mediante Server-Sent Events (SSE).

## Características principales
- **Marcación biométrica simulada**: los docentes ingresan su DNI y marcan entrada/salida desde la interfaz descrita en [pages/index.html](pages/index.html) con validaciones de tardanza, bloqueos automáticos y activaciones especiales.
- **Panel administrativo completo**: [pages/admin.html](pages/admin.html) + [scripts/admin-panel.js](scripts/admin-panel.js) permiten gestionar docentes, cursos, periodos, horarios, bloqueos, activaciones y reportes en Excel.
- **Automatizaciones en segundo plano**: [backend/server.js](backend/server.js) ejecuta cada minuto la tarea `ejecutarFaltasAutomaticasProgramadas()` y vigila la expiración de periodos con `limpiarPeriodosVencidos()` y `revisarGeneracionAutomatica()`.
 - **Automatizaciones en segundo plano**: [backend/server.js](backend/server.js) ejecuta cada minuto la tarea `ejecutarFaltasAutomaticasProgramadas()` y vigila la expiración de periodos con `limpiarPeriodosVencidos()` y `revisarGeneracionAutomatica()`.
- **Exportes y respaldos**: Generación de libros XLSX por docente/periodo usando ExcelJS, y rutas auxiliares en [backend/routes/backup.js](backend/routes/backup.js) para copias de seguridad.
- **Actualización en vivo**: el panel admin escucha `/api/admin/stream` para refrescar listas y métricas sin necesidad de recargar la página.

## Stack tecnológico
- **Runtime**: Node.js 18+ (recomendado) sobre Windows/macOS/Linux.
- **Backend**: Express 4, `mysql2/promise`, `cors`, `ExcelJS`, `pdfkit`, `multer`.
- **Frontend**: HTML/CSS (Inter + Outfit), SweetAlert2, FontAwesome, JavaScript vanilla.
- **Base de datos**: MySQL o MariaDB (configuración en [backend/db.js](backend/db.js)).

## Estructura del proyecto
```
├── backend/
│   ├── server.js            # API, lógica de negocio, tareas automáticas
│   ├── db.js                # Pool MySQL (ajusta host/credenciales aquí)
│   └── routes/backup.js     # Endpoints auxiliares de respaldo
├── pages/                   # Interfaces públicas (index, admin)
├── scripts/                 # JS de las vistas (app y admin)
├── style/                   # Hojas de estilo compartidas y del panel
├── reportes/                # Carpeta donde se generan XLSX automáticos
├── semestres/               # Exportes por periodo histórico
├── package.json             # Manifiesto y scripts de npm
└── README.md
```

## Requisitos previos
1. **Node.js 18 o superior** y npm.
2. **MySQL/MariaDB** en ejecución (por defecto se usa `localhost`, usuario `root`, contraseña vacía y base `asistencia_ldv`). Ajusta [backend/db.js](backend/db.js) o crea variables de entorno antes de iniciar.
3. Base de datos inicial con tablas de docentes, cursos, periodos, horarios, asistencias, bloqueados y activaciones. Importa tu script SQL antes de ejecutar el servidor.

## Instalación y ejecución
```bash
# 1. Instala dependencias
npm install

# 2. Asegúrate de tener MySQL encendido y con la base configurada
#    (actualiza backend/db.js si usas otras credenciales)

# 3. Inicia el servidor (sirve API + frontend)
npm start

```

- La aplicación completa estará disponible en `http://localhost:3000/`.
- El frontend ya no depende de "Go Live": Express expone `pages/`, `style/`, `scripts/` y `reportes` como contenido estático.

## Rutas de almacenamiento para exportes
- Las carpetas de salida de los Excel automáticos se configuran en [backend/server.js](backend/server.js) mediante `DEFAULT_REPORTS_PATH` (reportes mensuales) y `DEFAULT_SEMESTRES_PATH` (históricos por periodo). Por defecto apuntan a `reportes/` y `semestres/` dentro del proyecto.
- Si quieres fijar rutas absolutas, reemplaza esas constantes por el nuevo path, por ejemplo:
	```js
	const DEFAULT_REPORTS_PATH = "D:/Respaldos/reportes";
	const DEFAULT_SEMESTRES_PATH = "D:/Respaldos/semestres";
	```
	Toda la app consumirá esas nuevas rutas y `ensureDirectory()` creará la carpeta si no existe.
- También puedes definir variables de entorno `REPORTS_PATH` y/o `SEMESTRES_PATH` antes de ejecutar `npm start`; el servidor las resolverá automáticamente (acepta rutas absolutas o relativas al proyecto).
- Tanto los cierres mensuales como los exportes de periodo omiten docentes inactivos para simular eliminación lógica.

## Credenciales y accesos
| Rol / ruta | Cómo acceder | Credenciales por defecto |
| ---------- | ------------ | ------------------------ |
| **Panel docente** (`/`) | Ingresar DNI real del docente | No requiere contraseña; valida contra tabla `docentes` |
| **Panel administrativo** (`/admin.html`) | Desde la pantalla principal ingresa el DNI especial y luego la contraseña | DNI administrador: **-----** (constante `DNI_ADMIN` en [scripts/app.js](scripts/app.js)).<br>Contraseña del panel: **-----** (constante `ADMIN_PASSWORD` en [scripts/admin-panel.js](scripts/admin-panel.js)). |

> Cambia estos valores en los archivos mencionados o migra a variables de entorno antes de desplegar en producción.

## Principales endpoints
El backend expone numerosas rutas; estas son las más usadas por el frontend:

- **Docentes y catálogos**: `/api/docentes`, `/api/cursos`, `/api/periodos`, `/api/horarios`, `/api/admin/horarios-completos`.
- **Asistencias**: `/api/marcar-entrada`, `/api/marcar-salida`, `/api/asistencias-hoy/:dni`, `/api/asistencia-activa/:dni`, `/api/admin/asistencias` (CRUD).
- **Automatización**: `/api/registrar-faltas-automaticas`, `/api/limpiar-entradas-huerfanas`.
- **Bloqueos y activaciones**: `/api/crear-bloqueo`, `/api/bloqueados`, `/api/crear-activacion`, `/api/usar-activacion`, `/api/verificar-bloqueo/:dni`.
- **Reportes**: `/api/admin/reporte-preview/:dni`, `/api/admin/reporte-excel/:dni`.
- **Streaming**: `/api/admin/stream` (SSE) para que el panel admin reciba `full-refresh` cada vez que cambia algo.

Consulta [backend/server.js](backend/server.js) para revisar argumentos/validaciones específicos.

## Automatizaciones y tareas programadas
- `ejecutarFaltasAutomaticasProgramadas()` se dispara cada minuto para registrar faltas según horarios activos y grupos continuos.
- `revisarGeneracionAutomatica()` detecta el último día del mes (a partir de las 23:00) y genera reportes XLSX por docente en `reportes/<mes_año>/<docente>/`, filtrando únicamente las asistencias del mes corriente.
- `limpiarPeriodosVencidos()` desactiva periodos terminados, deshabilita horarios asociados y exporta asistencias del periodo a `semestres/<nombre_periodo>/`, limitando las fechas al rango del periodo y excluyendo docentes inactivos.

Estas tareas se inicializan cuando el servidor arranca (`app.listen`). Si MySQL no está disponible, se registrará `ECONNREFUSED`; asegúrate de que la base esté activa antes de iniciar.

## Flujo de uso
1. **Docente**: Ingresar DNI ➜ sistema verifica bloqueos/activaciones ➜ botón "Ingresar al Sistema" permite marcar entrada o salida con lógica de tolerancias, bloqueos después de 30 minutos y limpieza de registros huérfanos.
2. **Administrativo**: Ingresar DNI especial ➜ se abre `admin.html` ➜ ingresar contraseña ➜ gestionar catálogos, monitorear asistencias en vivo, exportar reportes o otorgar activaciones.
3. **Reportes**: descargar XLSX individuales desde el panel o dejar que la tarea automática genere carpetas por mes/período.

## Solución de problemas
- **`Cannot GET /` en el navegador**: ejecuta `npm start` en la raíz; Express sirve el frontend por defecto. Si ves ese error es porque el servidor no está levantado.
- **`ECONNREFUSED` al iniciar**: el pool MySQL configurado en [backend/db.js](backend/db.js) no puede conectarse. Verifica host/puerto, credenciales y que la base `asistencia_ldv` exista.
- **Recursos estáticos sin estilo**: asegúrate de que las rutas relativas en `index.html` apunten a `/style/` y `/scripts/` (ya configuradas en el servidor). Limpia caché si vienes de ejecutar Live Server.
- **Panel admin no refresca**: revisa la pestaña Network → `/api/admin/stream` debe estar conectada. Si el navegador bloquea SSE (por HTTPS/HTTP mixto), ajusta `BASE_URL` en [scripts/admin-panel.js](scripts/admin-panel.js).

## Próximos pasos sugeridos
- Externalizar credenciales (MySQL, DNI admin, contraseña) usando variables de entorno y `dotenv`.
- Añadir scripts SQL o migrations para inicializar la base automáticamente.
- Implementar autenticación real (JWT o sesiones) para el panel administrativo.
- Completar documentación de endpoints (OpenAPI) y pruebas automatizadas.

---
Con esta guía puedes desplegar y entender rápidamente el funcionamiento del sistema, modificar la configuración y presentar el proyecto en GitHub con toda la información esencial.
