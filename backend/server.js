const express = require("express");
const cors = require("cors");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const backupRoutes = require('./routes/backup');

const ROOT_PATH = path.join(__dirname, "..");
const PUBLIC_PAGES_PATH = path.join(ROOT_PATH, "pages");
const PUBLIC_STYLE_PATH = path.join(ROOT_PATH, "style");
const PUBLIC_SCRIPTS_PATH = path.join(ROOT_PATH, "scripts");
function resolveBasePath(envValue, fallback) {
  if (!envValue) return fallback;
  return path.isAbsolute(envValue) ? envValue : path.resolve(ROOT_PATH, envValue);
}

const DEFAULT_REPORTS_PATH = path.join(ROOT_PATH, "reportes");
const DEFAULT_SEMESTRES_PATH = path.join(ROOT_PATH, "semestres");
const REPORTS_BASE_PATH = resolveBasePath(process.env.REPORTS_PATH, DEFAULT_REPORTS_PATH);
const SEMESTRES_BASE_PATH = resolveBasePath(process.env.SEMESTRES_PATH, DEFAULT_SEMESTRES_PATH);
const PERIODO_JOIN = "LEFT JOIN periodos p ON h.id_periodo = p.id_periodo";
const PERIODO_ACTIVO_WHERE = "(h.id_periodo IS NULL OR (p.activacion = 1 AND p.fecha_inicio <= CURDATE() AND p.fecha_fin >= CURDATE()))";

function ensureDirectory(dir, label) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (label) {
      console.log(`🗂️ Carpeta creada para ${label}: ${dir}`);
    }
  }
}

ensureDirectory(REPORTS_BASE_PATH, "reportes");
ensureDirectory(SEMESTRES_BASE_PATH, "semestres");

const PUBLIC_REPORTS_PATH = REPORTS_BASE_PATH;

const app = express();
app.use(cors());
app.use(express.json());
// Sirve los archivos estáticos del frontend para que la UI viva en el mismo host del API.
app.use(express.static(PUBLIC_PAGES_PATH));
app.use("/style", express.static(PUBLIC_STYLE_PATH));
app.use("/scripts", express.static(PUBLIC_SCRIPTS_PATH));
app.use("/reportes", express.static(PUBLIC_REPORTS_PATH));

const ADMIN_STREAM_KEEP_ALIVE_MS = 30 * 1000;
const adminStreamClients = new Map();
let adminStreamClientSeq = 1;
const LIMPIEZA_PERIODOS_INTERVALO_MS = 60 * 1000; // Revisar periodos cada minuto
let limpiezaPeriodosEnCurso = false;
let ultimaGeneracionMensual = null;
const MARCADOR_REPORTES_MENSUALES = ".reportes_mensuales_generados";

function broadcastAdminRefresh(origin = "unknown", extra = {}) {
  if (!adminStreamClients.size) return;
  const payload = JSON.stringify({
    type: "full-refresh",
    origin,
    timestamp: Date.now(),
    ...extra,
  });
  const frame = `data: ${payload}\n\n`;

  for (const [clientId, client] of adminStreamClients.entries()) {
    try {
      client.res.write(frame);
    } catch (err) {
      console.warn("[SSE] Error enviando evento, removiendo cliente", err?.message);
      clearInterval(client.keepAlive);
      adminStreamClients.delete(clientId);
    }
  }
}

function respondWithAdminRefresh(res, origin, body) {
  broadcastAdminRefresh(origin);
  return res.json(body);
}

app.get("/api/admin/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`);

  const clientId = adminStreamClientSeq++;
  const keepAlive = setInterval(() => {
    if (res.writableEnded || res.writableFinished) {
      clearInterval(keepAlive);
      return;
    }
    res.write(":keep-alive\n\n");
  }, ADMIN_STREAM_KEEP_ALIVE_MS);

  adminStreamClients.set(clientId, { res, keepAlive });

  const removeClient = () => {
    clearInterval(keepAlive);
    adminStreamClients.delete(clientId);
  };

  req.on("close", removeClient);
  res.on("close", removeClient);
});

/* ================= UTILIDADES ================= */
function convertirAMin(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

function formatearMinutosAHora(totalMinutos) {
  const horas = Math.floor(totalMinutos / 60)
    .toString()
    .padStart(2, "0");
  const minutos = (totalMinutos % 60).toString().padStart(2, "0");
  return `${horas}:${minutos}`;
}

function agruparCursosContinuos(horarios) {
  if (!horarios.length) return [];

  horarios.sort((a, b) => convertirAMin(a.hora_inicio) - convertirAMin(b.hora_inicio));

  const grupos = [];
  let grupo = [horarios[0]];

  for (let i = 1; i < horarios.length; i++) {
    const finAnterior = convertirAMin(horarios[i - 1].hora_fin);
    const inicioActual = convertirAMin(horarios[i].hora_inicio);
    const diferencia = inicioActual - finAnterior;

    // Considera continuos si la diferencia es de 15 minutos o menos
    if (diferencia <= 15) {
      grupo.push(horarios[i]);
    } else {
      grupos.push(grupo);
      grupo = [horarios[i]];
    }
  }

  grupos.push(grupo);
  return grupos;
}

function incluirInactivos(req) {
  if (!req || !req.query) return false;
  const valor = String(req.query.incluirInactivos || '').toLowerCase();
  return valor === '1' || valor === 'true' || valor === 'todos';
}

function normalizarFechaSQL(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    return valor.toISOString().slice(0, 10);
  }
  const texto = String(valor);
  if (texto.includes('T')) {
    return texto.slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return texto;
  }
  const fecha = new Date(texto);
  if (!Number.isNaN(fecha.getTime())) {
    return fecha.toISOString().slice(0, 10);
  }
  return null;
}

function formatearFechaLocalSQL(fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) return null;
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

function parseFechaLocal(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    return new Date(valor.getFullYear(), valor.getMonth(), valor.getDate());
  }
  const texto = String(valor);
  const base = texto.includes("T") ? texto.slice(0, 10) : texto;
  const partes = base.split("-").map(Number);
  if (partes.length !== 3 || partes.some((n) => Number.isNaN(n))) return null;
  const [anio, mes, dia] = partes;
  return new Date(anio, mes - 1, dia);
}

function normalizarFechaLocalSQL(valor) {
  const fecha = parseFechaLocal(valor);
  return fecha ? formatearFechaLocalSQL(fecha) : null;
}

function parseActivacion(valor) {
  if (valor === null || typeof valor === "undefined") return undefined;
  if (typeof valor === "string" && valor.trim() === "") return undefined;
  return Number(valor) ? 1 : 0;
}

const CARRERAS_VALIDAS = new Set(["CAT", "INSTITUTO", "SECRETARIADO"]);
const TURNOS_VALIDOS = new Set(["M", "T", "N", "SIN"]);

function normalizarCodigo(valor) {
  if (valor === null || typeof valor === "undefined") return "";
  return String(valor).trim().toUpperCase();
}

function validarCarreraTurno(carrera, turno) {
  const carreraFinal = normalizarCodigo(carrera);
  const turnoFinal = normalizarCodigo(turno);
  if (!CARRERAS_VALIDAS.has(carreraFinal) || !TURNOS_VALIDOS.has(turnoFinal)) {
    return null;
  }
  return { carrera: carreraFinal, turno: turnoFinal };
}

async function obtenerFechaHoraServidor() {
  const [[row]] = await db.query("SELECT NOW() AS ahora");
  if (!row || !row.ahora) {
    throw new Error("Hora del servidor no disponible");
  }
  const fecha = row.ahora instanceof Date ? row.ahora : new Date(row.ahora);
  if (Number.isNaN(fecha.getTime())) {
    throw new Error("Hora del servidor inválida");
  }
  return fecha;
}

/* ================= HORA SERVIDOR ================= */
app.get("/api/hora-servidor", async (req, res) => {
  try {
    const fecha = await obtenerFechaHoraServidor();
    res.json({ iso: fecha.toISOString() });
  } catch (err) {
    console.error("Error obteniendo hora del servidor:", err);
    res.status(500).json({ error: "No se pudo obtener la hora del servidor" });
  }
});

/* ================= DOCENTES ================= */
app.get("/api/docentes", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condicion = mostrarTodos ? "" : "WHERE activacion = 1";
    const [rows] = await db.query(`
      SELECT id_docente, dni, nombre, activacion
      FROM docentes
      ${condicion}
      ORDER BY nombre
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en docentes" });
  }
});

/* ================= CURSOS ================= */
app.get("/api/cursos", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condicion = mostrarTodos ? "" : "WHERE activacion = 1";
    const [rows] = await db.query(`
      SELECT id_curso, nombre, carrera, turno, activacion
      FROM cursos
      ${condicion}
      ORDER BY nombre
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en cursos" });
  }
});

/* ================= PERIODOS ================= */
app.get("/api/periodos", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condicion = mostrarTodos ? "" : "WHERE activacion = 1";
    const [rows] = await db.query(`
      SELECT id_periodo, nombre, fecha_inicio, fecha_fin, activacion
      FROM periodos
      ${condicion}
      ORDER BY fecha_inicio
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en periodos" });
  }
});

/* ================= HORARIOS ================= */
app.get("/api/horarios", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condiciones = [];
    if (!mostrarTodos) {
      condiciones.push("h.activacion = 1");
      condiciones.push("d.activacion = 1");
      condiciones.push("c.activacion = 1");
      condiciones.push(PERIODO_ACTIVO_WHERE);
    }
    const whereClause = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const [rows] = await db.query(`
      SELECT 
        h.id_horario,
        h.id_docente,
        d.dni AS docente_dni,
        h.id_curso,
        c.nombre AS curso,
        c.carrera AS carrera,
        c.turno AS turno,
        h.dia,
        h.hora_inicio,
        h.hora_fin,
        h.es_recuperacion,
        h.activacion,
        d.activacion AS activacion_docente,
        c.activacion AS activacion_curso
      FROM horarios h
      ${PERIODO_JOIN}
      JOIN docentes d ON h.id_docente = d.id_docente
      JOIN cursos c ON h.id_curso = c.id_curso
      ${whereClause}
      ORDER BY h.dia, h.hora_inicio
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en horarios" });
  }
});


/* ================= EDITAR HORARIO ================= */
app.put("/api/admin/horarios/:id_horario", async (req, res) => {
  try {
    const { id_horario } = req.params;
    const { id_docente, id_curso, dia, hora_inicio, hora_fin, id_periodo, es_recuperacion, activacion } = req.body;

    if (!id_docente || !id_curso || !dia || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const [[actual]] = await db.query(
      "SELECT activacion FROM horarios WHERE id_horario = ?",
      [id_horario]
    );

    if (!actual) {
      return res.status(404).json({ error: "Horario no encontrado" });
    }

    let estadoFinal = parseActivacion(activacion);
    if (estadoFinal === undefined) {
      estadoFinal = Number(actual.activacion) ? 1 : 0;
    }

    const [result] = await db.query(
      `UPDATE horarios
       SET 
         id_docente = ?,
         id_curso = ?,
         dia = ?,
         hora_inicio = ?,
         hora_fin = ?,
         id_periodo = ?,
         es_recuperacion = ?,
         activacion = ?
       WHERE id_horario = ?`,
      [
        id_docente,
        id_curso,
        dia,
        hora_inicio,
        hora_fin,
        id_periodo || null,
        es_recuperacion ? 1 : 0,
        estadoFinal,
        id_horario,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Horario no encontrado" });
    }

    console.log("[Horarios] Actualizar", id_horario, { activacion: estadoFinal });
    return respondWithAdminRefresh(res, "horarios:update", { ok: true, filasAfectadas: result.affectedRows });
  } catch (err) {
    console.error("💥 ERROR editar horario:", err);
    res.status(500).json({ error: "Error al editar horario" });
  }
});


/* ================= ASISTENCIAS DEL DÍA ================= */
app.get("/api/asistencias-hoy/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    const [[doc]] = await db.query("SELECT id_docente FROM docentes WHERE dni=?", [dni]);
    if (!doc) return res.json([]);

    const [asistencias] = await db.query(`
      SELECT id_curso, hora_entrada, hora_salida
      FROM asistencias
      WHERE id_docente = ? AND fecha = CURDATE()
    `, [doc.id_docente]);

    res.json(asistencias);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error asistencias del día" });
  }
});

/* ================= ASISTENCIA ACTIVA ================= */
app.get("/api/asistencia-activa/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    const [[doc]] = await db.query("SELECT id_docente FROM docentes WHERE dni=?", [dni]);
    if (!doc) return res.json(null);

    // Buscar entrada activa VÁLIDA (con hora_entrada real, sin salida)
    // EXCLUYE faltas (donde hora_entrada = NULL y hora_salida = NULL)
    const [[asistencia]] = await db.query(`
      SELECT id_asistencia, id_curso, hora_entrada
      FROM asistencias
      WHERE id_docente = ? 
        AND fecha = CURDATE() 
        AND hora_salida IS NULL
        AND hora_entrada IS NOT NULL
      ORDER BY hora_entrada DESC
      LIMIT 1
    `, [doc.id_docente]);

    res.json(asistencia || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error asistencia activa" });
  }
});

async function registrarFaltasHastaAhora(id_docente, diaHoy, minActual) {
  // Obtener horarios del día
  const [horarios] = await db.query(`
    SELECT h.id_curso, h.hora_inicio, h.hora_fin, h.es_recuperacion
    FROM horarios h
    ${PERIODO_JOIN}
    WHERE h.id_docente = ? AND h.dia = ? AND h.activacion = 1
      AND ${PERIODO_ACTIVO_WHERE}
    ORDER BY h.hora_inicio
  `, [id_docente, diaHoy]);

  if (!horarios.length) return 0;

  // Obtener asistencias ya registradas (incluye faltas)
  const [asistencias] = await db.query(`
    SELECT id_curso
    FROM asistencias
    WHERE id_docente = ? AND fecha = CURDATE()
  `, [id_docente]);

  const cursosRegistrados = asistencias.map(a => a.id_curso);

  // 🔥 Obtener DNI del docente para limpiar bloqueos si es necesario
  const [[docente]] = await db.query(`
    SELECT dni FROM docentes WHERE id_docente = ?
  `, [id_docente]);

  let faltas = 0;

  for (const h of horarios) {
    const fin = convertirAMin(h.hora_fin);

    // 🔥 CRÍTICO: Si ya terminó el curso (sin tolerancia) y no tiene registro => FALTA
    if (minActual > fin && !cursosRegistrados.includes(h.id_curso)) {
      const minutosAusencia = fin - convertirAMin(h.hora_inicio);

      await db.query(`
        INSERT INTO asistencias
        (id_docente, id_curso, fecha, hora_entrada, hora_salida,
         hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
        VALUES (?, ?, CURDATE(), NULL, NULL, ?, ?, ?, ?)
      `, [
        id_docente,
        h.id_curso,
        h.hora_inicio,
        h.hora_fin,
        minutosAusencia,
        h.es_recuperacion ? 1 : 0,
      ]);

      faltas++;

      // 🔥 CRÍTICO: Si registró falta, limpiar bloqueos de entrada
      // Porque el profesor NUNCA llegó (faltó), no tiene sentido mantenerlo bloqueado
      if (docente) {
        await db.query(`
          UPDATE bloqueados
          SET activo = FALSE
          WHERE dni = ? AND tipo = 'entrada' AND activo = TRUE
        `, [docente.dni]);
      }
    }
  }

  return faltas;
}


async function registrarFaltasAntesDelCurso(id_docente, diaHoy, idCursoObjetivo) {
  // Obtener horarios del día
  const [horarios] = await db.query(`
    SELECT h.id_curso, h.hora_inicio, h.hora_fin, h.es_recuperacion
    FROM horarios h
    ${PERIODO_JOIN}
    WHERE h.id_docente = ? AND h.dia = ? AND h.activacion = 1
      AND ${PERIODO_ACTIVO_WHERE}
    ORDER BY h.hora_inicio
  `, [id_docente, diaHoy]);

  if (!horarios.length) return 0;

  // Obtener asistencias ya registradas (incluye faltas)
  const [asistencias] = await db.query(`
    SELECT id_curso
    FROM asistencias
    WHERE id_docente = ? AND fecha = CURDATE()
  `, [id_docente]);

  const cursosRegistrados = asistencias.map(a => a.id_curso);

  // Encontrar el curso objetivo
  const idxObjetivo = horarios.findIndex(h => h.id_curso === idCursoObjetivo);
  if (idxObjetivo === -1) return 0;

  let faltas = 0;

  // Todos los cursos ANTES del objetivo, si no tienen registro => falta
  for (let i = 0; i < idxObjetivo; i++) {
    const h = horarios[i];

    if (!cursosRegistrados.includes(h.id_curso)) {
      const fin = convertirAMin(h.hora_fin);
      const inicio = convertirAMin(h.hora_inicio);
      const minutosAusencia = fin - inicio;

      await db.query(`
        INSERT INTO asistencias
        (id_docente, id_curso, fecha, hora_entrada, hora_salida,
         hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
        VALUES (?, ?, CURDATE(), NULL, NULL, ?, ?, ?, ?)
      `, [
        id_docente,
        h.id_curso,
        h.hora_inicio,
        h.hora_fin,
        minutosAusencia,
        h.es_recuperacion ? 1 : 0,
      ]);

      faltas++;
    }
  }

  return faltas;
}

// Procesa las faltas automáticas de un docente puntual para reutilizar la lógica
async function registrarFaltasAutomaticasDocente(id_docente, diaHoy, minActual) {
  const [horarios] = await db.query(`
    SELECT h.id_curso, h.hora_inicio, h.hora_fin, h.es_recuperacion
    FROM horarios h
    ${PERIODO_JOIN}
    WHERE h.id_docente = ? AND h.dia = ? AND h.activacion = 1
      AND ${PERIODO_ACTIVO_WHERE}
    ORDER BY h.hora_inicio
  `, [id_docente, diaHoy]);

  if (!horarios.length) {
    return { faltasRegistradas: 0, teniaHorarios: false };
  }

  const [[docenteInfo]] = await db.query(`
    SELECT nombre, dni
    FROM docentes
    WHERE id_docente = ?
  `, [id_docente]);
  const etiquetaDocente = docenteInfo
    ? `${docenteInfo.nombre} (${docenteInfo.dni})`
    : `Docente #${id_docente}`;
  const horaReferencia = formatearMinutosAHora(minActual);
  const faltasDetalle = [];

  const grupos = agruparCursosContinuos(horarios);
  const categoriasFaltas = {
    cursoIndividual: 0,
    inicioBloque: 0,
    cursoIntermedio: 0,
    finBloque: 0,
  };
  const etiquetasCategorias = {
    cursoIndividual: "curso individual",
    inicioBloque: "inicio de bloque",
    cursoIntermedio: "curso intermedio",
    finBloque: "fin de bloque",
  };

  const [asistenciasHoy] = await db.query(`
    SELECT id_curso
    FROM asistencias
    WHERE id_docente = ? AND fecha = CURDATE()
  `, [id_docente]);

  const cursosConAsistencia = asistenciasHoy.map(a => a.id_curso);

  const [asistenciasActivas] = await db.query(`
    SELECT id_curso
    FROM asistencias
    WHERE id_docente = ? AND fecha = CURDATE()
      AND hora_entrada IS NOT NULL
      AND hora_salida IS NULL
  `, [id_docente]);

  const cursosConAsistenciaActiva = asistenciasActivas.map(a => a.id_curso);
  let faltasRegistradas = 0;

  for (const grupo of grupos) {
    const ultimoCurso = grupo[grupo.length - 1];
    const finUltimo = convertirAMin(ultimoCurso.hora_fin);
    const esGrupoIndividual = grupo.length === 1;
    const grupoSinRegistro = grupo.every(h => !cursosConAsistencia.includes(h.id_curso));
    const grupoConAlgunaAsistencia = grupo.some(h => cursosConAsistencia.includes(h.id_curso));
    const ultimoSinRegistro = !cursosConAsistencia.includes(ultimoCurso.id_curso);

    let toleranciaGrupo = 15;
    if (grupoSinRegistro) {
      toleranciaGrupo = 0;
    } else if (!esGrupoIndividual && grupoConAlgunaAsistencia && ultimoSinRegistro) {
      toleranciaGrupo = 0;
    }

    // Registrar solo cuando finalizó el bloque (sin tolerancia para cursos individuales sin registro)
    if (minActual <= finUltimo + toleranciaGrupo) {
      continue;
    }

    // Si hay una asistencia activa en el bloque, la salida manual resolverá la situación
    const tieneActivaEnGrupo = grupo.some(h =>
      cursosConAsistenciaActiva.includes(h.id_curso)
    );

    if (tieneActivaEnGrupo) {
      continue;
    }

    for (let idx = 0; idx < grupo.length; idx++) {
      const horario = grupo[idx];
      if (cursosConAsistencia.includes(horario.id_curso)) continue;

      const finCurso = convertirAMin(horario.hora_fin);
      const minutosAusencia = finCurso - convertirAMin(horario.hora_inicio);

      await db.query(`
        INSERT INTO asistencias
        (id_docente, id_curso, fecha, hora_entrada, hora_salida,
         hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
        VALUES (?, ?, CURDATE(), NULL, NULL, ?, ?, ?, ?)
      `, [
        id_docente,
        horario.id_curso,
        horario.hora_inicio,
        horario.hora_fin,
        minutosAusencia,
        horario.es_recuperacion ? 1 : 0,
      ]);

      faltasRegistradas++;

      const posicionDescripcion = esGrupoIndividual
        ? "curso individual"
        : idx === 0
          ? "inicio del bloque"
          : idx === grupo.length - 1
            ? "fin del bloque"
            : "curso intermedio";
      const categoriaClave = esGrupoIndividual
        ? "cursoIndividual"
        : idx === 0
          ? "inicioBloque"
          : idx === grupo.length - 1
            ? "finBloque"
            : "cursoIntermedio";
      categoriasFaltas[categoriaClave]++;
      const bloqueDescripcion = esGrupoIndividual
        ? "sin continuidad"
        : `bloque de ${grupo.length} curso(s) continuos`;
      let motivoDetalle = "bloque finalizado sin asistencia en este curso";
      if (grupoSinRegistro) {
        motivoDetalle = esGrupoIndividual
          ? "sin tolerancia (curso individual sin registros previos)"
          : "bloque sin asistencias previas (sin tolerancia adicional)";
      } else if (!esGrupoIndividual && grupoConAlgunaAsistencia && ultimoSinRegistro && idx === grupo.length - 1) {
        motivoDetalle = "último curso del bloque sin registro; tolerancia omitida tras el fin del bloque";
      }

      faltasDetalle.push(`• ${posicionDescripcion} en ${bloqueDescripcion} (${horario.hora_inicio}-${horario.hora_fin}) ${motivoDetalle}. Curso ID: ${horario.id_curso}.`);
    }
  }

  if (faltasDetalle.length) {
    console.log(`🤖 [${etiquetaDocente}] ${faltasDetalle.length} falta(s) automáticas registradas a las ${horaReferencia}`);
    faltasDetalle.forEach(linea => console.log(`   ${linea}`));
    const resumenCategorias = Object.entries(categoriasFaltas)
      .filter(([, total]) => total > 0)
      .map(([clave, total]) => `${etiquetasCategorias[clave]}: ${total}`)
      .join(" | ");
    if (resumenCategorias) {
      console.log(`   📊 Distribución: ${resumenCategorias}`);
    }
  }

  if (faltasRegistradas > 0 && docenteInfo?.dni) {
    await db.query(`
      UPDATE bloqueados
      SET activo = FALSE
      WHERE dni = ? AND tipo = 'entrada' AND activo = TRUE
    `, [docenteInfo.dni]);
  }

  return { faltasRegistradas, teniaHorarios: true, categorias: categoriasFaltas, etiquetaDocente };
}

let ultimaFechaFaltasHistoricas = null;

async function registrarFaltasHistoricasDocente(id_docente, fechaHoyLocal, fechaAyerLocal) {
  const fechaHoyStr = formatearFechaLocalSQL(fechaHoyLocal);
  const fechaAyerStr = formatearFechaLocalSQL(fechaAyerLocal);
  if (!fechaHoyStr || !fechaAyerStr) {
    return { faltasRegistradas: 0, teniaHorarios: false };
  }

  const [horarios] = await db.query(`
    SELECT h.id_curso, h.dia, h.hora_inicio, h.hora_fin, h.es_recuperacion,
           p.fecha_inicio, p.fecha_fin
    FROM horarios h
    INNER JOIN periodos p ON h.id_periodo = p.id_periodo
    WHERE h.id_docente = ?
      AND h.activacion = 1
      AND p.activacion = 1
      AND p.fecha_inicio <= ?
  `, [id_docente, fechaHoyStr]);

  if (!horarios.length) {
    return { faltasRegistradas: 0, teniaHorarios: false };
  }

  let rangoInicio = null;
  let rangoFin = null;

  for (const horario of horarios) {
    const inicioPeriodo = parseFechaLocal(horario.fecha_inicio);
    const finPeriodo = parseFechaLocal(horario.fecha_fin);
    if (!inicioPeriodo || !finPeriodo) continue;

    if (!rangoInicio || inicioPeriodo < rangoInicio) {
      rangoInicio = inicioPeriodo;
    }

    const finAjustado = finPeriodo < fechaAyerLocal ? finPeriodo : fechaAyerLocal;
    if (!rangoFin || finAjustado > rangoFin) {
      rangoFin = finAjustado;
    }
  }

  if (!rangoInicio || !rangoFin || rangoFin < rangoInicio) {
    return { faltasRegistradas: 0, teniaHorarios: true };
  }

  const rangoInicioStr = formatearFechaLocalSQL(rangoInicio);
  const rangoFinStr = formatearFechaLocalSQL(rangoFin);
  if (!rangoInicioStr || !rangoFinStr) {
    return { faltasRegistradas: 0, teniaHorarios: true };
  }

  const [asistencias] = await db.query(`
    SELECT id_curso, fecha
    FROM asistencias
    WHERE id_docente = ? AND fecha BETWEEN ? AND ?
  `, [id_docente, rangoInicioStr, rangoFinStr]);

  const asistenciasSet = new Set();
  for (const asistencia of asistencias) {
    const fechaStr = normalizarFechaLocalSQL(asistencia.fecha);
    if (!fechaStr) continue;
    asistenciasSet.add(`${fechaStr}|${asistencia.id_curso}`);
  }

  const diasSemana = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  let faltasRegistradas = 0;

  for (const horario of horarios) {
    const inicioPeriodo = parseFechaLocal(horario.fecha_inicio);
    const finPeriodo = parseFechaLocal(horario.fecha_fin);
    if (!inicioPeriodo || !finPeriodo) continue;

    const inicioIter = inicioPeriodo > rangoInicio ? inicioPeriodo : rangoInicio;
    const finIter = finPeriodo < rangoFin ? finPeriodo : rangoFin;
    if (finIter < inicioIter) continue;

    for (let fecha = new Date(inicioIter); fecha <= finIter; fecha.setDate(fecha.getDate() + 1)) {
      if (diasSemana[fecha.getDay()] !== horario.dia) continue;
      const fechaStr = formatearFechaLocalSQL(fecha);
      const clave = `${fechaStr}|${horario.id_curso}`;
      if (asistenciasSet.has(clave)) continue;

      const minutosAusencia = convertirAMin(horario.hora_fin) - convertirAMin(horario.hora_inicio);

      await db.query(`
        INSERT INTO asistencias
        (id_docente, id_curso, fecha, hora_entrada, hora_salida,
         hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      `, [
        id_docente,
        horario.id_curso,
        fechaStr,
        horario.hora_inicio,
        horario.hora_fin,
        minutosAusencia,
        horario.es_recuperacion ? 1 : 0,
      ]);

      asistenciasSet.add(clave);
      faltasRegistradas++;
    }
  }

  return { faltasRegistradas, teniaHorarios: true };
}

async function ejecutarFaltasHistoricasSiCorresponde(ahora) {
  const fechaHoyLocal = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const fechaHoyStr = formatearFechaLocalSQL(fechaHoyLocal);
  if (!fechaHoyStr || ultimaFechaFaltasHistoricas === fechaHoyStr) {
    return;
  }

  const fechaAyerLocal = new Date(fechaHoyLocal);
  fechaAyerLocal.setDate(fechaAyerLocal.getDate() - 1);
  ultimaFechaFaltasHistoricas = fechaHoyStr;

  try {
    const [docentesConHorario] = await db.query(`
      SELECT DISTINCT h.id_docente
      FROM horarios h
      INNER JOIN periodos p ON h.id_periodo = p.id_periodo
      WHERE h.activacion = 1
        AND p.activacion = 1
        AND p.fecha_inicio <= ?
    `, [fechaHoyStr]);

    if (!docentesConHorario.length) {
      return;
    }

    let totalFaltas = 0;

    for (const docente of docentesConHorario) {
      const resultado = await registrarFaltasHistoricasDocente(
        docente.id_docente,
        fechaHoyLocal,
        fechaAyerLocal
      );
      totalFaltas += resultado.faltasRegistradas || 0;
    }

    if (totalFaltas > 0) {
      console.log(`🤖 Tarea histórica: ${totalFaltas} falta(s) registradas en días anteriores.`);
      broadcastAdminRefresh("faltas:historicas", { total: totalFaltas });
    }
  } catch (err) {
    console.error("💥 ERROR en faltas históricas:", err);
  }
}


/* ================= MARCAR ENTRADA ================= */
app.post("/api/marcar-entrada", async (req, res) => {
  try {
    const { dni } = req.body;

    const [[doc]] = await db.query("SELECT id_docente, nombre FROM docentes WHERE dni=?", [dni]);
    if (!doc) return res.status(404).json({ error: "Docente no existe" });

    // Verificar si ya existe entrada sin salida (EXCLUYENDO FALTAS)
    const [[existeActiva]] = await db.query(`
      SELECT id_asistencia FROM asistencias
      WHERE id_docente = ? 
        AND fecha = CURDATE() 
        AND hora_salida IS NULL
        AND hora_entrada IS NOT NULL
      LIMIT 1
    `, [doc.id_docente]);

    if (existeActiva) {
      return res.status(400).json({ error: "Ya tiene entrada activa" });
    }

    const ahora = await obtenerFechaHoraServidor();
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const diaHoy = dias[ahora.getDay()];

    const [horarios] = await db.query(`
      SELECT h.id_curso, h.hora_inicio, h.hora_fin, h.es_recuperacion
      FROM horarios h
      ${PERIODO_JOIN}
      WHERE h.id_docente = ? AND h.dia = ? AND h.activacion = 1
        AND ${PERIODO_ACTIVO_WHERE}
      ORDER BY h.hora_inicio
    `, [doc.id_docente, diaHoy]);

    if (!horarios.length) {
      return res.status(404).json({ error: "No tiene horarios hoy" });
    }

    const minActual = ahora.getHours() * 60 + ahora.getMinutes();
    const grupos = agruparCursosContinuos(horarios);

    // Registrar faltas automáticamente antes de buscar curso disponible
    await registrarFaltasHastaAhora(doc.id_docente, diaHoy, minActual);

    // Buscar cursos completados (con hora_salida)
    const [asistenciasHoy] = await db.query(`
      SELECT id_curso FROM asistencias
      WHERE id_docente = ? AND fecha = CURDATE() AND hora_salida IS NOT NULL
    `, [doc.id_docente]);

    const cursosCompletados = asistenciasHoy.map(a => a.id_curso);

    let cursoParaEntrada = null;
    let grupoCompleto = null;

    // Obtener asistencias del día (incluyendo faltas)
    const [todasAsistencias] = await db.query(`
      SELECT id_curso, hora_entrada, hora_salida FROM asistencias
      WHERE id_docente = ? AND fecha = CURDATE()
    `, [doc.id_docente]);

    const cursosConAsistencia = todasAsistencias.map(a => a.id_curso);

    // Buscar el SIGUIENTE bloque/curso disponible
    for (const grupo of grupos) {
      let cursoDisponibleEncontrado = null;
      
      for (const curso of grupo) {
        const yaRegistrado = cursosConAsistencia.includes(curso.id_curso);
        
        if (!yaRegistrado) {
          const inicioCurso = convertirAMin(curso.hora_inicio);
          const finCurso = convertirAMin(curso.hora_fin);
          
          // 🔥 CRÍTICO: Verificar si estamos en ventana de entrada para ESTE curso
          // Permite entrada desde 10 min ANTES hasta el FIN del curso
          if (minActual >= inicioCurso - 10 && minActual <= finCurso + 15) {
            cursoDisponibleEncontrado = curso;
            break;
          }
        }
      }
      
      if (cursoDisponibleEncontrado) {
        cursoParaEntrada = cursoDisponibleEncontrado;
        grupoCompleto = grupo;
        break;
      }
    }

    if (!cursoParaEntrada) {
      return res.status(400).json({ error: "No tiene curso disponible en este momento" });
    }

    // Marcar como FALTA todos los cursos anteriores al curso donde está entrando
    await registrarFaltasAntesDelCurso(doc.id_docente, diaHoy, cursoParaEntrada.id_curso);

    const inicioProg = convertirAMin(cursoParaEntrada.hora_inicio);
    const horaActual = ahora.toTimeString().slice(0, 8);
    const tardanzaExcesiva = minActual > inicioProg + 30;

    const [[bloqueo]] = await db.query(`
      SELECT id_bloqueo, motivo FROM bloqueados
      WHERE dni = ? AND tipo = 'entrada' AND activo = TRUE
      LIMIT 1
    `, [dni]);

    // Si hay un bloqueo viejo pero el curso actual esta dentro de tolerancia, desbloquear.
    if (bloqueo && !tardanzaExcesiva) {
      await db.query(`
        UPDATE bloqueados
        SET activo = FALSE
        WHERE id_bloqueo = ?
      `, [bloqueo.id_bloqueo]);
      console.log(`Bloqueo de entrada limpiado para ${dni} (${doc.nombre}) - curso dentro de tolerancia`);
    }

    // 🔥 VALIDACION CRITICA: Tardanza mayor a 30 minutos
    let usoActivacionPorTardanza = false;

    if (tardanzaExcesiva) {
      // Verificar si tiene activacion especial para tardanza
      const [[activacionTardanza]] = await db.query(`
        SELECT id_activacion FROM activaciones_especiales
        WHERE dni = ? AND tipo = 'entrada' AND usado = FALSE
        ORDER BY fecha_creacion DESC
        LIMIT 1
      `, [dni]);

      if (activacionTardanza) {
        // Tiene permiso especial - marcar como usado y continuar
        await db.query(`
          UPDATE activaciones_especiales
          SET usado = TRUE, fecha_uso = NOW()
          WHERE id_activacion = ?
        `, [activacionTardanza.id_activacion]);

        if (bloqueo) {
          await db.query(`
            UPDATE bloqueados
            SET activo = FALSE
            WHERE id_bloqueo = ?
          `, [bloqueo.id_bloqueo]);
        }

        usoActivacionPorTardanza = true;
        console.log(`Permiso de tardanza usado para ${dni} (${doc.nombre})`);
        // NO hacer return - continuar con el flujo normal de registro
      } else {
        // No tiene permiso - crear bloqueo si no existe uno activo
        if (!bloqueo) {
          await db.query(`
            INSERT INTO bloqueados (dni, nombre, tipo, motivo)
            VALUES (?, ?, 'entrada', ?)
          `, [
            dni,
            doc.nombre,
            `Tardanza excesiva: ${minActual - inicioProg} minutos. Hora programada: ${cursoParaEntrada.hora_inicio}, Hora de intento: ${horaActual}`
          ]);
        }

        return res.status(403).json({
          error: "Tardanza excesiva (más de 30 minutos). Ha sido bloqueado. Debe acudir a administración para solicitar una activación especial.",
          bloqueado: true
        });
      }
    }

    // 🔥 NUEVA LÓGICA: Determinar qué cursos del bloque ya pasaron y marcar entrada
    const idxCursoEntrada = grupoCompleto.findIndex(c => c.id_curso === cursoParaEntrada.id_curso);
    let cursosYaPasados = [];
    
    // Identificar cursos que ya pasaron (incluyendo el actual si llegó tarde)
    for (let i = idxCursoEntrada; i < grupoCompleto.length; i++) {
      const curso = grupoCompleto[i];
      const inicioCurso = convertirAMin(curso.hora_inicio);
      const finCurso = convertirAMin(curso.hora_fin);
      
      // Si el curso ya pasó su hora de inicio O es el primero y estamos en ventana
      if (minActual > inicioCurso || (i === idxCursoEntrada && minActual >= inicioCurso - 10)) {
        // 🔥 CRÍTICO: Verificar si NO tiene asistencia registrada Y NO está completado
        const tieneAsistencia = cursosConAsistencia.includes(curso.id_curso);
        const estaCompletado = cursosCompletados.includes(curso.id_curso);
        
        if (!tieneAsistencia && !estaCompletado) {
          cursosYaPasados.push(curso);
        }
      } else {
        // Cursos futuros - no incluir
        break;
      }
    }

    // 🔥 Registrar entrada en TODOS los cursos que ya pasaron
    let primeraEntrada = true;
    let cursosRegistrados = 0;
    
    for (const curso of cursosYaPasados) {
      const inicioCurso = convertirAMin(curso.hora_inicio);
      const finCurso = convertirAMin(curso.hora_fin);
      
      let horaEntrada;
      let minutosObs = 0;
      
      if (primeraEntrada) {
        // ✅ CORREGIDO: Primer curso - determinar hora de entrada
        if (minActual < inicioCurso) {
          // Llegó ANTES de la hora (10min de tolerancia) - guardar hora PROGRAMADA
          horaEntrada = curso.hora_inicio;
        } else if (minActual >= finCurso) {
          // Ya pasó el curso completo - marcar entrada programada
          horaEntrada = curso.hora_inicio;
        } else {
          // Llegó tarde durante el curso - guardar hora REAL
          horaEntrada = horaActual;
          minutosObs = minActual - inicioCurso;
        }
        
        const esRec = curso.es_recuperacion ? 1 : 0;

        await db.query(`
          INSERT INTO asistencias 
          (id_docente, id_curso, fecha, hora_entrada, 
           hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
          VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?)
        `, [
          doc.id_docente,
          curso.id_curso,
          horaEntrada,
          curso.hora_inicio,
          curso.hora_fin,
          minutosObs,
          esRec,
        ]);
        
        cursosRegistrados++;
        primeraEntrada = false;
      } else {
        // Cursos posteriores en el bloque - entrada programada
        const esRecPosterior = curso.es_recuperacion ? 1 : 0;

        await db.query(`
          INSERT INTO asistencias 
          (id_docente, id_curso, fecha, hora_entrada, 
           hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
          VALUES (?, ?, CURDATE(), ?, ?, ?, 0, ?)
        `, [
          doc.id_docente,
          curso.id_curso,
          curso.hora_inicio, // Entrada programada
          curso.hora_inicio,
          curso.hora_fin,
          esRecPosterior,
        ]);
        
        cursosRegistrados++;
      }
    }

    // Contar cuántos cursos disponibles quedan desde este curso
    const cursosRestantesGrupo = grupoCompleto.slice(idxCursoEntrada);
    const cursosDisponibles = cursosRestantesGrupo.filter(c => !cursosCompletados.includes(c.id_curso));

    return respondWithAdminRefresh(res, "asistencias:entrada", {
      ok: true,
      cursos_bloque: cursosDisponibles.length,
      cursos_registrados: cursosRegistrados,
      id_curso: cursoParaEntrada.id_curso,
      uso_activacion: usoActivacionPorTardanza,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error marcar entrada" });
  }
});

/* ================= MARCAR SALIDA (MODO HÍBRIDO) ================= */
app.post("/api/marcar-salida", async (req, res) => {
  try {
    const { dni } = req.body;

    const [[doc]] = await db.query("SELECT id_docente, nombre FROM docentes WHERE dni = ?", [dni]);
    if (!doc) return res.status(404).json({ error: "Docente no existe" });

    // 🔥 PASO 1: VERIFICAR SI ESTÁ BLOQUEADO
    const [[bloqueo]] = await db.query(`
      SELECT id_bloqueo, motivo FROM bloqueados
      WHERE dni = ? AND tipo = 'salida' AND activo = TRUE
      LIMIT 1
    `, [dni]);
    
    if (bloqueo) {
      // Verificar si tiene activación especial
      const [[activacion]] = await db.query(`
        SELECT id_activacion FROM activaciones_especiales
        WHERE dni = ? AND tipo = 'salida' AND usado = FALSE
        ORDER BY fecha_creacion DESC
        LIMIT 1
      `, [dni]);
      
      if (activacion) {
        // ✅ Tiene activación - marcar como usada, desbloquear y registrar con hora PROGRAMADA
        await db.query(`
          UPDATE activaciones_especiales
          SET usado = TRUE, fecha_uso = NOW()
          WHERE id_activacion = ?
        `, [activacion.id_activacion]);
        
        // Desbloquear
        await db.query(`
          UPDATE bloqueados
          SET activo = FALSE
          WHERE id_bloqueo = ?
        `, [bloqueo.id_bloqueo]);
        
        console.log(`✅ Activación especial (salida) usada y bloqueo eliminado para ${dni} (${doc.nombre})`);

        // Obtener asistencia activa y cerrarla con hora PROGRAMADA
        const [[asistenciaActiva]] = await db.query(`
          SELECT a.id_asistencia, a.id_curso, a.hora_entrada, 
                a.hora_entrada_prog, a.hora_salida_prog, a.minutos_observacion
          FROM asistencias a
          WHERE a.id_docente = ? 
            AND a.fecha = CURDATE() 
            AND a.hora_salida IS NULL
            AND a.hora_entrada IS NOT NULL
          ORDER BY a.hora_entrada DESC
          LIMIT 1
        `, [doc.id_docente]);
        
        if (asistenciaActiva) {
          // 🔥 Usar hora PROGRAMADA, no la hora actual
          const horaSalidaProgramada = asistenciaActiva.hora_salida_prog;
          
          await db.query(`
            UPDATE asistencias
            SET hora_salida = ?
            WHERE id_asistencia = ?
          `, [horaSalidaProgramada, asistenciaActiva.id_asistencia]);

          return respondWithAdminRefresh(res, "asistencias:salida", {
            ok: true,
            hora_salida: horaSalidaProgramada,
            modo: 'activacion_especial',
            cursos_completados: 1,
            mensaje: 'Salida registrada con activación especial (hora programada)'
          });
        } else {
          return res.status(400).json({ error: "No hay entrada activa para cerrar" });
        }
      } else {
        // ❌ No tiene activación - rechazar
        return res.status(403).json({ 
          error: "Acceso bloqueado por salida fuera de tolerancia. Debe solicitar una activación especial en administración.",
          bloqueado: true
        });
      }
    }

    // 🔥 OBTENER TODAS LAS ASISTENCIAS ACTIVAS DEL BLOQUE (sin salida)
    const [asistenciasActivas] = await db.query(`
      SELECT a.id_asistencia, a.id_curso, a.hora_entrada, 
            a.hora_entrada_prog, a.minutos_observacion, a.hora_salida_prog
      FROM asistencias a
      WHERE a.id_docente = ? 
        AND a.fecha = CURDATE() 
        AND a.hora_salida IS NULL
        AND a.hora_entrada IS NOT NULL
      ORDER BY a.hora_entrada ASC
    `, [doc.id_docente]);

    if (!asistenciasActivas.length) {
      return res.status(400).json({ error: "No hay entrada activa" });
    }

    const ahora = await obtenerFechaHoraServidor();
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const diaHoy = dias[ahora.getDay()];

    const minActual = ahora.getHours() * 60 + ahora.getMinutes();
    
    const [horarios] = await db.query(`
      SELECT h.id_curso, h.hora_inicio, h.hora_fin, h.es_recuperacion
      FROM horarios h
      ${PERIODO_JOIN}
      WHERE h.id_docente = ? AND h.dia = ? AND h.activacion = 1
        AND ${PERIODO_ACTIVO_WHERE}
      ORDER BY h.hora_inicio
    `, [doc.id_docente, diaHoy]);

    const grupos = agruparCursosContinuos(horarios);
    
    // 🔥 Encontrar el grupo que contiene CUALQUIERA de las asistencias activas
    let grupoActual = null;
    for (const grupo of grupos) {
      const tieneAsistenciaActiva = grupo.some(c => 
        asistenciasActivas.some(a => a.id_curso === c.id_curso)
      );
      
      if (tieneAsistenciaActiva) {
        grupoActual = grupo;
        break;
      }
    }

    if (!grupoActual) {
      return res.status(500).json({ error: "No se encontró grupo de cursos" });
    }

    const horaSalida = ahora.toTimeString().slice(0, 8);
    const salidaReal = convertirAMin(horaSalida.slice(0, 5));

    // 🔥 Usar la PRIMERA asistencia activa para determinar el índice del curso actual
    const primeraAsistenciaActiva = asistenciasActivas[0];
    const idxCursoActual = grupoActual.findIndex(c => c.id_curso === primeraAsistenciaActiva.id_curso);
    const cursoActual = grupoActual[idxCursoActual];
    const finCursoActual = convertirAMin(cursoActual.hora_fin);

    const ultimoCurso = grupoActual[grupoActual.length - 1];
    const finUltimoCurso = convertirAMin(ultimoCurso.hora_fin);

    // ✅ CORREGIDO: VALIDACIÓN: BLOQUEO si sale MÁS DE 15 minutos después del último curso
    if (salidaReal > finUltimoCurso + 15) {
      // Verificar si tiene activación especial para salida tardía
      const [[activacionSalidaTardia]] = await db.query(`
        SELECT id_activacion FROM activaciones_especiales
        WHERE dni = ? AND tipo = 'salida' AND usado = FALSE
        ORDER BY fecha_creacion DESC
        LIMIT 1
      `, [dni]);
      
      if (activacionSalidaTardia) {
        // ✅ Tiene permiso - marcar como usado
        await db.query(`
          UPDATE activaciones_especiales
          SET usado = TRUE, fecha_uso = NOW()
          WHERE id_activacion = ?
        `, [activacionSalidaTardia.id_activacion]);

        // ==========================
        // COMPLETAR SOLO ASISTENCIAS
        // ==========================
        // Objetivo: para TODOS los cursos del grupo continuo:
        // - Si hay asistencia ACTIVA -> cerrar con hora de salida programada.
        // - Si hay una FALTA (entrada/salida NULL) -> mantenerla como falta.
        // - NO crear nuevas asistencias donde no hay ningún registro.

        let cursosActualizados = 0;

        for (const curso of grupoActual) {
          // ¿Tiene una asistencia activa en memoria?
          const asistenciaActiva = asistenciasActivas.find(a => a.id_curso === curso.id_curso);

          if (asistenciaActiva) {
            // Cerrar asistencia activa con hora de salida programada
            await db.query(`
              UPDATE asistencias
              SET hora_salida = ?
              WHERE id_asistencia = ?
            `, [asistenciaActiva.hora_salida_prog, asistenciaActiva.id_asistencia]);
            cursosActualizados++;
            continue;
          }

          // Buscar cualquier registro de asistencia existente (incluye faltas)
          const [[asisExistente]] = await db.query(`
            SELECT id_asistencia, hora_entrada, hora_salida
            FROM asistencias
            WHERE id_docente = ? AND fecha = CURDATE() AND id_curso = ?
            LIMIT 1
          `, [doc.id_docente, curso.id_curso]);

          if (!asisExistente) {
            // No hay ningún registro: asumimos que asistió al bloque completo
            // y creamos una asistencia perfecta a horas programadas
            const esRec = curso.es_recuperacion ? 1 : 0;

            await db.query(`
              INSERT INTO asistencias
              (id_docente, id_curso, fecha, hora_entrada, hora_salida,
               hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
              VALUES (?, ?, CURDATE(), ?, ?, ?, ?, 0, ?)
            `, [
              doc.id_docente,
              curso.id_curso,
              curso.hora_inicio,
              curso.hora_fin,
              curso.hora_inicio,
              curso.hora_fin,
              esRec,
            ]);
            cursosActualizados++;
            continue;
          }

          // Si es falta (entrada y salida NULL) o ya está completa, la dejamos tal cual
          if (asisExistente.hora_entrada !== null && asisExistente.hora_salida === null) {
            // Asistencia existente sin salida (no incluida en asistenciasActivas por algún motivo)
            // la cerramos con la hora de salida programada
            await db.query(`
              UPDATE asistencias
              SET hora_salida = hora_salida_prog
              WHERE id_asistencia = ?
            `, [asisExistente.id_asistencia]);
            cursosActualizados++;
          }
        }

        // ✅ Si este bloque contenía horarios de recuperación, eliminarlos
        const cursosRecuperacion = grupoActual.filter(c => c.es_recuperacion).map(c => c.id_curso);
        if (cursosRecuperacion.length > 0) {
          const placeholders = cursosRecuperacion.map(() => "?").join(",");
          await db.query(
            `DELETE FROM horarios
             WHERE id_docente = ? AND dia = ? AND es_recuperacion = 1
               AND id_curso IN (${placeholders})`,
            [doc.id_docente, diaHoy, ...cursosRecuperacion]
          );
        }

        return respondWithAdminRefresh(res, "asistencias:salida", {
          ok: true,
          hora_salida: ultimoCurso.hora_fin,
          modo: 'activacion_especial',
          cursos_completados: cursosActualizados || grupoActual.length,
          mensaje: 'Salida registrada con activación especial (bloque completo a hora programada)'
        });
      } else {
        // ❌ NO tiene permiso - verificar si ya está bloqueado
        const [[bloqueoExistente]] = await db.query(`
          SELECT id_bloqueo FROM bloqueados
          WHERE dni = ? AND tipo = 'salida' AND activo = TRUE
        `, [dni]);
        
        // Solo crear bloqueo si NO existe uno activo
        if (!bloqueoExistente) {
          await db.query(`
            INSERT INTO bloqueados (dni, nombre, tipo, motivo)
            VALUES (?, ?, 'salida', ?)
          `, [
            dni,
            doc.nombre,
            `Salida fuera de tolerancia: ${salidaReal - finUltimoCurso} minutos después del límite. Hora límite: ${ultimoCurso.hora_fin} + 15min, Hora de intento: ${horaSalida}`
          ]);
        }
        
        return res.status(403).json({
          error: "Salida fuera de tolerancia (más de 15 minutos después del último curso). Ha sido bloqueado. Debe acudir a administración para solicitar una activación especial.",
          bloqueado: true
        });
      }
    }

    // NO permitir salida ANTES de que termine el curso actual (emergencia)
    if (salidaReal < finCursoActual - 5) {
      // Salida de emergencia - solo cerrar la PRIMERA asistencia activa
      await db.query(`
        UPDATE asistencias
        SET hora_salida = ?, 
            minutos_observacion = ?
        WHERE id_asistencia = ?
      `, [
        horaSalida, 
        (primeraAsistenciaActiva.minutos_observacion || 0) + (finCursoActual - salidaReal),
        primeraAsistenciaActiva.id_asistencia
      ]);

      return res.json({ 
        ok: true, 
        hora_salida: horaSalida,
        modo: 'emergencia',
        cursos_completados: 1,
        mensaje: 'Salida anticipada registrada. Los demás cursos quedan disponibles.'
      });
    }

    // Determinar hasta qué curso llegó según la hora de salida
    let cursosACompletar = [];
    
    for (let i = idxCursoActual; i < grupoActual.length; i++) {
      const curso = grupoActual[i];
      const inicioCurso = convertirAMin(curso.hora_inicio);
      const finCurso = convertirAMin(curso.hora_fin);
      
      if (salidaReal < inicioCurso) {
        break;
      }
      
      // ✅ CORREGIDO: Permitir completar curso si:
      // 1. Llegó al menos 5min antes del fin (normal), O
      // 2. Está en ventana de 15min DESPUÉS del fin (para CUALQUIER curso)
      
      if (salidaReal >= finCurso - 5) {
        // Caso normal: llegó a tiempo o casi a tiempo
        cursosACompletar.push({ ...curso, index: i });
      } else if (salidaReal >= finCurso && salidaReal <= finCurso + 15) {
        // ✅ NUEVO: Ventana de tolerancia de 15min DESPUÉS del fin de CUALQUIER curso
        cursosACompletar.push({ ...curso, index: i });
      } else {
        // Sale mucho antes del fin - no completó este curso
        break;
      }
    }

    if (cursosACompletar.length === 0) {
      return res.status(400).json({ 
        error: "Debe completar al menos el curso actual antes de marcar salida"
      });
    }

    // Crear un mapa de asistencias activas por id_curso
    const mapaAsistencias = {};
    asistenciasActivas.forEach(asist => {
      mapaAsistencias[asist.id_curso] = asist;
    });

    let cursosRegistrados = 0;

    // Procesar cada curso a completar
    for (let i = 0; i < cursosACompletar.length; i++) {
      const cursoData = cursosACompletar[i];
      const curso = grupoActual[cursoData.index];
      const finCurso = convertirAMin(curso.hora_fin);
      const esUltimoCursoACompletar = (i === cursosACompletar.length - 1);
      
      // Verificar si este curso tiene asistencia activa
      const asistenciaCurso = mapaAsistencias[curso.id_curso];

      if (asistenciaCurso) {
        // Ya tiene entrada registrada - solo actualizar salida
        let horaSalidaCurso;
        let minutosObs = asistenciaCurso.minutos_observacion || 0;

        if (esUltimoCursoACompletar) {
          // Es el último curso del bloque a completar
          if (salidaReal > finCurso && salidaReal <= finCurso + 15) {
            // ✅ CORREGIDO: Sale DESPUÉS del fin pero DENTRO de ventana (15min) - hora PROGRAMADA
            horaSalidaCurso = curso.hora_fin;
          } else if (salidaReal < finCurso) {
            // Sale ANTES del fin - hora REAL
            horaSalidaCurso = horaSalida;
            minutosObs += (finCurso - salidaReal);
          } else {
            // Sale EXACTAMENTE a tiempo - hora PROGRAMADA
            horaSalidaCurso = curso.hora_fin;
          }
        } else {
          // No es el último - siempre hora programada
          horaSalidaCurso = curso.hora_fin;
        }

        await db.query(`
          UPDATE asistencias
          SET hora_salida = ?, minutos_observacion = ?
          WHERE id_asistencia = ?
        `, [horaSalidaCurso, minutosObs, asistenciaCurso.id_asistencia]);
        
        cursosRegistrados++;
      } else {
        // No tiene entrada activa - verificar si ya existe un registro para evitar duplicados
        let horaSalidaCurso;
        let minutosObs = 0;

        if (esUltimoCursoACompletar) {
          // Es el ultimo curso del bloque a completar
          if (salidaReal > finCurso && salidaReal <= finCurso + 15) {
            // Sale despues del fin pero dentro de ventana - hora programada
            horaSalidaCurso = curso.hora_fin;
          } else if (salidaReal < finCurso) {
            // Sale antes del fin - hora real
            horaSalidaCurso = horaSalida;
            minutosObs = finCurso - salidaReal;
          } else {
            // Sale a tiempo - hora programada
            horaSalidaCurso = curso.hora_fin;
          }
        } else {
          // No es el ultimo - siempre hora programada
          horaSalidaCurso = curso.hora_fin;
        }

        const [[asisExistente]] = await db.query(`
          SELECT id_asistencia, hora_entrada, hora_salida, minutos_observacion
          FROM asistencias
          WHERE id_docente = ? AND fecha = CURDATE() AND id_curso = ?
          LIMIT 1
        `, [doc.id_docente, curso.id_curso]);

        if (asisExistente) {
          if (asisExistente.hora_entrada !== null && asisExistente.hora_salida === null) {
            const minutosPrevios = Number(asisExistente.minutos_observacion) || 0;
            await db.query(`
              UPDATE asistencias
              SET hora_salida = ?, minutos_observacion = ?
              WHERE id_asistencia = ?
            `, [horaSalidaCurso, minutosPrevios + minutosObs, asisExistente.id_asistencia]);
            cursosRegistrados++;
          } else if (asisExistente.hora_entrada !== null || asisExistente.hora_salida !== null) {
            // Ya existe una asistencia completa (o parcial) para este curso
            cursosRegistrados++;
          }
          continue;
        }

        const esRec = curso.es_recuperacion ? 1 : 0;

        await db.query(`
          INSERT INTO asistencias
          (id_docente, id_curso, fecha, hora_entrada, hora_salida,
           hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion)
          VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?)
        `, [
          doc.id_docente,
          curso.id_curso,
          curso.hora_inicio,
          horaSalidaCurso,
          curso.hora_inicio,
          curso.hora_fin,
          minutosObs,
          esRec,
        ]);
        
        cursosRegistrados++;
      }
    }

    let modo = 'curso_individual';
    let mensaje = 'Curso(s) completado(s). Los siguientes quedan disponibles.';
    
    if (cursosRegistrados === grupoActual.length) {
      modo = 'bloque_completo';
      mensaje = `Bloque completo de ${cursosRegistrados} curso(s) registrado(s)`;
    }

    // ✅ Si en este bloque hay horarios de recuperación, eliminarlos al culminar
    const cursosRecuperacion = grupoActual.filter(c => c.es_recuperacion).map(c => c.id_curso);
    if (cursosRecuperacion.length > 0) {
      const placeholders = cursosRecuperacion.map(() => "?").join(",");
      await db.query(
        `DELETE FROM horarios
         WHERE id_docente = ? AND dia = ? AND es_recuperacion = 1
           AND id_curso IN (${placeholders})`,
        [doc.id_docente, diaHoy, ...cursosRecuperacion]
      );
    }

    return respondWithAdminRefresh(res, "asistencias:salida", {
      ok: true,
      hora_salida: horaSalida,
      modo,
      cursos_completados: cursosRegistrados,
      mensaje
    });

  } catch (err) {
    console.error("💥 ERROR marcar-salida:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ================= LIMPIAR ENTRADAS HUÉRFANAS ================= */
app.post("/api/limpiar-entradas-huerfanas", async (req, res) => {
  try {
    const { dni } = req.body;

    const [[doc]] = await db.query("SELECT id_docente FROM docentes WHERE dni = ?", [dni]);
    if (!doc) return res.status(404).json({ error: "Docente no existe" });

    // IMPORTANTE:
    // Para respetar completamente la lógica de bloqueos de salida
    // y la tolerancia de 15 minutos, ya NO modificamos las
    // asistencias del día actual aquí. La validación de salida
    // tardía y los bloqueos se manejan únicamente desde
    // /api/marcar-salida y el sistema de faltas automáticas.

    // Esta ruta queda como "no-op" para hoy, de modo que
    // nunca cierre automáticamente cursos continuos ni
    // impida que se dispare el bloqueo cuando el docente
    // intenta marcar salida fuera de la tolerancia.

    return res.json({
      ok: true,
      limpiezas: 0,
      mensaje: "Limpieza de entradas huérfanas deshabilitada para el día actual"
    });

  } catch (err) {
    console.error("💥 ERROR limpiar-entradas-huerfanas:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ================= REGISTRAR FALTAS AUTOMÁTICAS ================= */
app.post("/api/registrar-faltas-automaticas", async (req, res) => {
  try {
    const { dni } = req.body;

    const [[doc]] = await db.query("SELECT id_docente FROM docentes WHERE dni = ?", [dni]);
    if (!doc) return res.status(404).json({ error: "Docente no existe" });

    const ahora = await obtenerFechaHoraServidor();
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const diaHoy = dias[ahora.getDay()];
    const minActual = ahora.getHours() * 60 + ahora.getMinutes();
    const resultado = await registrarFaltasAutomaticasDocente(doc.id_docente, diaHoy, minActual);

    if (!resultado.teniaHorarios) {
      return res.json({ faltas_registradas: 0, mensaje: "No tiene horarios hoy" });
    }

    const payload = {
      ok: true,
      faltas_registradas: resultado.faltasRegistradas,
      mensaje: resultado.faltasRegistradas > 0
        ? `Se registraron ${resultado.faltasRegistradas} falta(s) automáticamente`
        : "No hay faltas pendientes",
    };

    if (resultado.faltasRegistradas > 0) {
      broadcastAdminRefresh("faltas:manual");
    }

    return res.json(payload);

  } catch (err) {
    console.error("💥 ERROR registrar-faltas-automaticas:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

const INTERVALO_FALTAS_AUTOMATICAS_MS = 60 * 1000;
let tareaFaltasEnEjecucion = false;

async function ejecutarFaltasAutomaticasProgramadas() {
  if (tareaFaltasEnEjecucion) return;
  tareaFaltasEnEjecucion = true;

  try {
    const ahora = await obtenerFechaHoraServidor();
    await ejecutarFaltasHistoricasSiCorresponde(ahora);
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const diaHoy = dias[ahora.getDay()];
    const minActual = ahora.getHours() * 60 + ahora.getMinutes();

    const [docentesConHorario] = await db.query(`
      SELECT DISTINCT h.id_docente
      FROM horarios h
      ${PERIODO_JOIN}
      WHERE h.dia = ? AND h.activacion = 1
        AND ${PERIODO_ACTIVO_WHERE}
    `, [diaHoy]);

    if (!docentesConHorario.length) {
      return;
    }

    let totalFaltas = 0;
    const detalleDocentes = [];
    const acumuladoCategorias = {
      cursoIndividual: 0,
      inicioBloque: 0,
      cursoIntermedio: 0,
      finBloque: 0,
    };

    for (const docente of docentesConHorario) {
      const resultado = await registrarFaltasAutomaticasDocente(docente.id_docente, diaHoy, minActual);
      const faltasRegistradas = resultado.faltasRegistradas || 0;
      totalFaltas += faltasRegistradas;
      if (faltasRegistradas > 0) {
        const etiqueta = resultado.etiquetaDocente || `Docente #${docente.id_docente}`;
        detalleDocentes.push(`• ${etiqueta}: ${faltasRegistradas} falta(s)`);
      }
      const categorias = resultado.categorias || {};
      acumuladoCategorias.cursoIndividual += categorias.cursoIndividual || 0;
      acumuladoCategorias.inicioBloque += categorias.inicioBloque || 0;
      acumuladoCategorias.cursoIntermedio += categorias.cursoIntermedio || 0;
      acumuladoCategorias.finBloque += categorias.finBloque || 0;
    }

    if (totalFaltas > 0) {
      console.log(`🤖 Tarea automática: ${totalFaltas} falta(s) nuevas registradas en total.`);
      detalleDocentes.forEach(linea => console.log(`   ${linea}`));
      const resumenGlobal = Object.entries(acumuladoCategorias)
        .filter(([, total]) => total > 0)
        .map(([clave, total]) => {
          switch (clave) {
            case "cursoIndividual":
              return `curso individual: ${total}`;
            case "inicioBloque":
              return `inicio de bloque: ${total}`;
            case "cursoIntermedio":
              return `curso intermedio: ${total}`;
            case "finBloque":
              return `fin de bloque: ${total}`;
            default:
              return `${clave}: ${total}`;
          }
        })
        .join(" | ");
      if (resumenGlobal) {
        console.log(`   📊 Distribución total: ${resumenGlobal}`);
      }
      broadcastAdminRefresh("faltas:automaticas", { total: totalFaltas });
    }
  } catch (err) {
    console.error("💥 ERROR en tarea automática de faltas:", err);
  } finally {
    tareaFaltasEnEjecucion = false;
  }
}

setInterval(ejecutarFaltasAutomaticasProgramadas, INTERVALO_FALTAS_AUTOMATICAS_MS);
ejecutarFaltasAutomaticasProgramadas();

/* ================= BLOQUEOS Y ACTIVACIONES ================= */

// Verificar si un docente está bloqueado
app.get("/api/verificar-bloqueo/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    
    const [[bloqueo]] = await db.query(`
      SELECT id_bloqueo, tipo, motivo, fecha_bloqueo
      FROM bloqueados
      WHERE dni = ? AND activo = TRUE
      LIMIT 1
    `, [dni]);
    
    res.json(bloqueo || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error verificando bloqueo" });
  }
});

// Crear bloqueo
app.post("/api/crear-bloqueo", async (req, res) => {
  try {
    const { dni, nombre, tipo, motivo } = req.body;
    
    // Verificar si ya existe un bloqueo activo
    const [[existente]] = await db.query(`
      SELECT id_bloqueo FROM bloqueados
      WHERE dni = ? AND activo = TRUE
    `, [dni]);
    
    if (existente) {
      return res.status(400).json({ error: "Ya existe un bloqueo activo para este docente" });
    }
    
    await db.query(`
      INSERT INTO bloqueados (dni, nombre, tipo, motivo)
      VALUES (?, ?, ?, ?)
    `, [dni, nombre, tipo, motivo]);
    
    return respondWithAdminRefresh(res, "bloqueos:create", { ok: true, mensaje: "Docente bloqueado exitosamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando bloqueo" });
  }
});

// Listar bloqueados
app.get("/api/bloqueados", async (req, res) => {
  try {
    const [bloqueados] = await db.query(`
      SELECT 
        b.id_bloqueo,
        b.dni,
        b.nombre,
        b.tipo,
        b.fecha_bloqueo,
        b.motivo,
        b.activo
      FROM bloqueados b
      WHERE b.activo = TRUE
      ORDER BY b.fecha_bloqueo DESC
    `);
    
    res.json(bloqueados);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error listando bloqueados" });
  }
});

// Crear activación especial (permiso)
app.post("/api/crear-activacion", async (req, res) => {
  try {
    const { dni, nombre, tipo, observaciones } = req.body;
    
    // PRIMERO: Desbloquear al docente
    await db.query(`
      UPDATE bloqueados
      SET activo = FALSE
      WHERE dni = ? AND tipo = ? AND activo = TRUE
    `, [dni, tipo]);
    
    // SEGUNDO: Crear la activación especial
    await db.query(`
      INSERT INTO activaciones_especiales (dni, nombre, tipo, observaciones)
      VALUES (?, ?, ?, ?)
    `, [dni, nombre, tipo, observaciones]);
    console.log(`⚡ Activación especial creada (${tipo}) para ${dni} (${nombre}). Obs: ${observaciones || "sin observaciones"}`);

    return respondWithAdminRefresh(res, "activaciones:create", { ok: true, mensaje: "Activación especial creada exitosamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando activación" });
  }
});

// Verificar si tiene activación disponible
app.get("/api/verificar-activacion/:dni/:tipo", async (req, res) => {
  try {
    const { dni, tipo } = req.params;
    
    const [[activacion]] = await db.query(`
      SELECT id_activacion, observaciones
      FROM activaciones_especiales
      WHERE dni = ? AND tipo = ? AND usado = FALSE
      ORDER BY fecha_creacion DESC
      LIMIT 1
    `, [dni, tipo]);
    
    res.json(activacion || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error verificando activación" });
  }
});

// Usar activación
app.post("/api/usar-activacion", async (req, res) => {
  try {
    const { dni, tipo } = req.body;
    
    const [[activacion]] = await db.query(`
      SELECT id_activacion
      FROM activaciones_especiales
      WHERE dni = ? AND tipo = ? AND usado = FALSE
      ORDER BY fecha_creacion DESC
      LIMIT 1
    `, [dni, tipo]);
    
    if (!activacion) {
      return res.status(404).json({ error: "No hay activación disponible" });
    }
    
    await db.query(`
      UPDATE activaciones_especiales
      SET usado = TRUE, fecha_uso = NOW()
      WHERE id_activacion = ?
    `, [activacion.id_activacion]);

    console.log(`⚡ Activación especial (${tipo}) usada manualmente para ${dni}. ID: ${activacion.id_activacion}`);
    
    return respondWithAdminRefresh(res, "activaciones:usar", { ok: true, id_activacion: activacion.id_activacion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error usando activación" });
  }
});

// Listar activaciones (usadas y no usadas)
app.get("/api/activaciones", async (req, res) => {
  try {
    const [activaciones] = await db.query(`
      SELECT 
        id_activacion,
        dni,
        nombre,
        tipo,
        fecha_creacion,
        usado,
        fecha_uso,
        observaciones
      FROM activaciones_especiales
      ORDER BY fecha_creacion DESC
      LIMIT 100
    `);
    
    res.json(activaciones);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error listando activaciones" });
  }
});

/* ================= ADMIN - CRUD BÁSICO ================= */

// Docentes
app.post("/api/admin/docentes", async (req, res) => {
  try {
    const { dni, nombre } = req.body;
    await db.query("INSERT INTO docentes (dni, nombre) VALUES (?, ?)", [dni, nombre]);
    return respondWithAdminRefresh(res, "docentes:create", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando docente" });
  }
});

app.put("/api/admin/docentes/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    const { nombre, activacion } = req.body;

    const [[docenteExiste]] = await db.query(
      "SELECT id_docente FROM docentes WHERE dni = ? LIMIT 1",
      [dni]
    );

    if (!docenteExiste) {
      return res.status(404).json({ error: "Docente no encontrado" });
    }

    const campos = [];
    const valores = [];

    if (typeof nombre === "string" && nombre.trim()) {
      campos.push("nombre = ?");
      valores.push(nombre.trim());
    }

    const estado = parseActivacion(activacion);
    if (estado !== undefined) {
      campos.push("activacion = ?");
      valores.push(estado);
    }

    if (!campos.length) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    valores.push(dni);
    const [result] = await db.query(`UPDATE docentes SET ${campos.join(", ")} WHERE dni = ?`, valores);

    console.log("[Docentes] Actualizar", dni, { nombre: campos.includes("nombre = ?") ? nombre?.trim() : undefined, activacion: estado });
    return respondWithAdminRefresh(res, "docentes:update", { ok: true, filasAfectadas: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error actualizando docente" });
  }
});

app.delete("/api/admin/docentes/:dni", async (req, res) => {
  try {
    const { dni } = req.params;
    await db.query("UPDATE docentes SET activacion = 0 WHERE dni = ?", [dni]);
    return respondWithAdminRefresh(res, "docentes:delete", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error desactivando docente" });
  }
});

// Cursos
app.post("/api/admin/cursos", async (req, res) => {
  try {
    const { nombre, carrera, turno } = req.body;
    const valores = validarCarreraTurno(carrera, turno);
    const nombreFinal = typeof nombre === "string" ? nombre.trim() : "";

    if (!nombreFinal || !valores) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const [[cursoExistente]] = await db.query(
      "SELECT id_curso, activacion FROM cursos WHERE nombre = ? AND carrera = ? AND turno = ? LIMIT 1",
      [nombreFinal, valores.carrera, valores.turno]
    );

    if (cursoExistente) {
      if (Number(cursoExistente.activacion) === 0) {
        await db.query("UPDATE cursos SET activacion = 1 WHERE id_curso = ?", [
          cursoExistente.id_curso,
        ]);
        return respondWithAdminRefresh(res, "cursos:reactivate", {
          ok: true,
          existing: true,
          reactivated: true,
          id_curso: cursoExistente.id_curso,
        });
      }

      return respondWithAdminRefresh(res, "cursos:exists", {
        ok: true,
        existing: true,
        id_curso: cursoExistente.id_curso,
      });
    }

    await db.query("INSERT INTO cursos (nombre, carrera, turno) VALUES (?, ?, ?)", [
      nombreFinal,
      valores.carrera,
      valores.turno,
    ]);
    return respondWithAdminRefresh(res, "cursos:create", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando curso" });
  }
});

app.put("/api/admin/cursos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, carrera, turno, activacion } = req.body;

    const [[cursoExiste]] = await db.query(
      "SELECT id_curso FROM cursos WHERE id_curso = ? LIMIT 1",
      [id]
    );

    if (!cursoExiste) {
      return res.status(404).json({ error: "Curso no encontrado" });
    }

    const campos = [];
    const valores = [];

    if (typeof nombre === "string" && nombre.trim()) {
      campos.push("nombre = ?");
      valores.push(nombre.trim());
    }

    if (typeof carrera !== "undefined") {
      const carreraFinal = normalizarCodigo(carrera);
      if (!carreraFinal || !CARRERAS_VALIDAS.has(carreraFinal)) {
        return res.status(400).json({ error: "Carrera inválida" });
      }
      campos.push("carrera = ?");
      valores.push(carreraFinal);
    }

    if (typeof turno !== "undefined") {
      const turnoFinal = normalizarCodigo(turno);
      if (!turnoFinal || !TURNOS_VALIDOS.has(turnoFinal)) {
        return res.status(400).json({ error: "Turno inválido" });
      }
      campos.push("turno = ?");
      valores.push(turnoFinal);
    }

    const estado = parseActivacion(activacion);
    if (estado !== undefined) {
      campos.push("activacion = ?");
      valores.push(estado);
    }

    if (!campos.length) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    valores.push(id);
    const [result] = await db.query(`UPDATE cursos SET ${campos.join(", ")} WHERE id_curso = ?`, valores);

    console.log("[Cursos] Actualizar", id, { nombre: campos.includes("nombre = ?") ? nombre?.trim() : undefined, activacion: estado });
    return respondWithAdminRefresh(res, "cursos:update", { ok: true, filasAfectadas: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error actualizando curso" });
  }
});

app.delete("/api/admin/cursos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE cursos SET activacion = 0 WHERE id_curso = ?", [id]);
    return respondWithAdminRefresh(res, "cursos:delete", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error desactivando curso" });
  }
});

// Periodos
app.post("/api/admin/periodos", async (req, res) => {
  try {
    const { nombre, fecha_inicio, fecha_fin } = req.body;
    const nombreFinal = typeof nombre === "string" ? nombre.trim() : "";

    if (!nombreFinal || !fecha_inicio || !fecha_fin) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const [[periodoExistente]] = await db.query(
      "SELECT id_periodo, activacion FROM periodos WHERE nombre = ? AND fecha_inicio = ? AND fecha_fin = ? LIMIT 1",
      [nombreFinal, fecha_inicio, fecha_fin]
    );

    if (periodoExistente) {
      if (Number(periodoExistente.activacion) === 0) {
        await db.query("UPDATE periodos SET activacion = 1 WHERE id_periodo = ?", [
          periodoExistente.id_periodo,
        ]);
        return respondWithAdminRefresh(res, "periodos:reactivate", {
          ok: true,
          existing: true,
          reactivated: true,
          id_periodo: periodoExistente.id_periodo,
        });
      }

      return respondWithAdminRefresh(res, "periodos:exists", {
        ok: true,
        existing: true,
        id_periodo: periodoExistente.id_periodo,
      });
    }

    await db.query(
      "INSERT INTO periodos (nombre, fecha_inicio, fecha_fin) VALUES (?, ?, ?)",
      [nombreFinal, fecha_inicio, fecha_fin]
    );

    return respondWithAdminRefresh(res, "periodos:create", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando periodo" });
  }
});

app.put("/api/admin/periodos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, fecha_inicio, fecha_fin, activacion } = req.body;

    if (!nombre || !fecha_inicio || !fecha_fin) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const [[periodoExiste]] = await db.query(
      "SELECT id_periodo FROM periodos WHERE id_periodo = ? LIMIT 1",
      [id]
    );

    if (!periodoExiste) {
      return res.status(404).json({ error: "Periodo no encontrado" });
    }

    const campos = ["nombre = ?", "fecha_inicio = ?", "fecha_fin = ?"];
    const valores = [nombre, fecha_inicio, fecha_fin];

    const estado = parseActivacion(activacion);
    if (estado !== undefined) {
      campos.push("activacion = ?");
      valores.push(estado);
    }

    valores.push(id);

    const [result] = await db.query(`UPDATE periodos SET ${campos.join(", ")} WHERE id_periodo = ?`, valores);

    if (estado !== undefined) {
      await db.query("UPDATE horarios SET activacion = ? WHERE id_periodo = ?", [estado, id]);
    }

    console.log("[Periodos] Actualizar", id, { activacion: estado });
    return respondWithAdminRefresh(res, "periodos:update", { ok: true, filasAfectadas: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error actualizando periodo" });
  }
});

app.delete("/api/admin/periodos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // 1. Desactivar horarios vinculados al periodo
    await db.query("UPDATE horarios SET activacion = 0 WHERE id_periodo = ?", [id]);

    // 2. Desactivar el periodo
    await db.query("UPDATE periodos SET activacion = 0 WHERE id_periodo = ?", [id]);
    return respondWithAdminRefresh(res, "periodos:delete", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error desactivando periodo" });
  }
});

// Horarios
app.post("/api/admin/horarios", async (req, res) => {
  try {
    const { id_docente, id_curso, dia, hora_inicio, hora_fin, id_periodo, es_recuperacion } = req.body;

    if (!id_docente || !id_curso || !dia || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    await db.query(
      `INSERT INTO horarios (id_docente, id_curso, dia, hora_inicio, hora_fin, id_periodo, es_recuperacion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id_docente,
        id_curso,
        dia,
        hora_inicio,
        hora_fin,
        id_periodo || null,
        es_recuperacion ? 1 : 0,
      ]
    );

    return respondWithAdminRefresh(res, "horarios:create", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creando horario" });
  }
});

app.get("/api/admin/horarios-completos", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condiciones = [];
    if (!mostrarTodos) {
      condiciones.push("h.activacion = 1");
      condiciones.push("d.activacion = 1");
      condiciones.push("c.activacion = 1");
    }
    const whereClause = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const [rows] = await db.query(`
      SELECT 
        h.id_horario,
        h.id_docente,
        d.nombre AS docente,
        d.dni AS docente_dni,
        h.id_curso,
        c.nombre AS curso,
        c.carrera AS carrera,
        c.turno AS turno,
        h.dia,
        h.hora_inicio,
        h.hora_fin,
        h.id_periodo,
        h.es_recuperacion,
        h.activacion,
        p.fecha_inicio AS periodo_inicio,
        p.fecha_fin AS periodo_fin,
        p.activacion AS activacion_periodo,
        d.activacion AS activacion_docente,
        c.activacion AS activacion_curso,
        CASE
          WHEN h.id_periodo IS NULL OR p.id_periodo IS NULL THEN 'sin_periodo'
          WHEN p.activacion = 0 THEN 'inactivo'
          WHEN p.fecha_inicio > CURDATE() THEN 'futuro'
          WHEN p.fecha_fin < CURDATE() THEN 'vencido'
          ELSE 'vigente'
        END AS estado_periodo,
        CASE
          WHEN h.id_periodo IS NULL OR p.id_periodo IS NULL THEN 1
          WHEN p.activacion = 1 AND p.fecha_inicio <= CURDATE() AND p.fecha_fin >= CURDATE() THEN 1
          ELSE 0
        END AS periodo_activo
      FROM horarios h
      ${PERIODO_JOIN}
      JOIN docentes d ON h.id_docente = d.id_docente
      JOIN cursos c ON h.id_curso = c.id_curso
      ${whereClause}
      ORDER BY d.nombre, h.dia, h.hora_inicio
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en horarios" });
  }
});

app.delete("/api/admin/horarios/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE horarios SET activacion = 0 WHERE id_horario = ?", [id]);
    return respondWithAdminRefresh(res, "horarios:delete", { ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error desactivando horario" });
  }
});

// Limpiar historial de asistencias
app.post("/api/admin/limpiar-historial", async (req, res) => {
  try {
    await db.query("DELETE FROM asistencias");
    await db.query("DELETE FROM bloqueados");
    await db.query("DELETE FROM activaciones_especiales");
    return respondWithAdminRefresh(res, "historial:limpiar", { ok: true, mensaje: "Historial limpiado exitosamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error limpiando historial" });
  }
});

/* ================= REPORTES - EXCEL Y AUTOMATIZACIÓN ================= */

// Función auxiliar: parsear tiempo a minutos
const parseTimeToMinutes = (timeStr) => {
  if (!timeStr) return null;
  const parts = timeStr.toString().split(":");
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

// Función auxiliar: calcular estado y observación
const calcularDetalleAsistencia = (row) => {
  const iniProg = parseTimeToMinutes(row.hora_entrada_prog);
  const finProg = parseTimeToMinutes(row.hora_salida_prog);
  const iniReal = parseTimeToMinutes(row.hora_entrada);
  const finReal = parseTimeToMinutes(row.hora_salida);
  const faltaRecuperada = Number(row.falta_recuperada) === 1;

  let estado = "ASISTIÓ";
  let minutosExcedentes = 0;
  const partes = [];
  let llegoTarde = false;
  let salioAntes = false;

  if (iniReal == null && finReal == null) {
    estado = faltaRecuperada ? "RECUPERADO" : "FALTA";
    let duracion = 0;
    if (iniProg != null && finProg != null && finProg > iniProg) {
      duracion = finProg - iniProg;
    }
    const minObs = row.minutos_observacion != null && !Number.isNaN(row.minutos_observacion) ? row.minutos_observacion : duracion;

    minutosExcedentes = faltaRecuperada ? 0 : minObs;

    if (faltaRecuperada) {
      partes.push("RECUPERADO: Falta compensada sin descuento de minutos");
    } else {
      // Texto mejorado de falta
      partes.push("Ausencia injustificada: No se registraron marcas biométricas de entrada ni salida");
      if (minutosExcedentes > 0) partes.push(`Total de minutos a descontar por inasistencia: ${minutosExcedentes}`);
    }
  } else {
    let minAtraso = 0;
    let minSalidaAntes = 0;
    
    // Cálculo tardanza
    if (iniProg != null && iniReal != null && iniReal > iniProg) {
      minAtraso = iniReal - iniProg;
      llegoTarde = true;
      partes.push(`Ingreso registrado con ${minAtraso} minutos de retraso`);
    }

    // Cálculo salida anticipada
    if (finProg != null && finReal != null && finReal < finProg) {
      minSalidaAntes = finProg - finReal;
      salioAntes = true;
      partes.push(`Salida anticipada registrada ${minSalidaAntes} minutos antes del cierre`);
    }

    const totalNoTrabajados = minAtraso + minSalidaAntes;
    minutosExcedentes = totalNoTrabajados;

    if (totalNoTrabajados === 0) {
      partes.push("Asistencia conforme al horario establecido");
    } else {
      partes.push(`Total acumulado de minutos no laborados: ${totalNoTrabajados}`);
    }
  }

  if (row.es_recuperacion) partes.unshift("SESIÓN DE RECUPERACIÓN");
  return { estado, minutosExcedentes, observacion: partes.join(". "), llegoTarde, salioAntes };
};

async function obtenerAsistenciaAdmin(idAsistencia) {
  const [[row]] = await db.query(
    `SELECT 
       a.id_asistencia,
       a.id_docente,
       a.id_curso,
       a.fecha,
       a.hora_entrada_prog,
       a.hora_entrada,
       a.hora_salida_prog,
       a.hora_salida,
       a.minutos_observacion,
      a.es_recuperacion,
      a.falta_recuperada,
       COALESCE(a.activacion, 1) AS activacion,
       d.nombre AS docente,
       d.dni,
       d.activacion AS activacion_docente,
       c.nombre AS curso,
       c.activacion AS activacion_curso
     FROM asistencias a
     JOIN docentes d ON a.id_docente = d.id_docente
     JOIN cursos c ON a.id_curso = c.id_curso
     WHERE a.id_asistencia = ?`,
    [idAsistencia]
  );

  if (!row) return null;

  const detalle = calcularDetalleAsistencia(row);
  const fechaISO = row.fecha instanceof Date ? row.fecha.toISOString().slice(0, 10) : row.fecha;

  return {
    id: row.id_asistencia,
    idDocente: row.id_docente,
    idCurso: row.id_curso,
    fecha: fechaISO,
    docente: row.docente,
    dni: row.dni,
    curso: row.curso,
    horaEntradaProg: row.hora_entrada_prog,
    horaEntradaReal: row.hora_entrada,
    horaSalidaProg: row.hora_salida_prog,
    horaSalidaReal: row.hora_salida,
    minutosObservacion: row.minutos_observacion,
    esRecuperacion: !!row.es_recuperacion,
    faltaRecuperada: !!row.falta_recuperada,
    activacion: row.activacion,
    activacionDocente: row.activacion_docente,
    activacionCurso: row.activacion_curso,
    estado: detalle.estado,
    minutosNoTrabajados: detalle.minutosExcedentes,
    observacion: detalle.observacion,
  };
}

// Función CORE para generar el Workbook (reutilizable)
async function crearWorkbookDocente(id_docente, nombreDocente, dni, opciones = {}) {
  const filtros = ["a.id_docente = ?", "COALESCE(a.activacion, 1) = 1"];
  const parametros = [id_docente];

  const fechaInicioSQL = normalizarFechaSQL(opciones.fechaInicio);
  const fechaFinSQL = normalizarFechaSQL(opciones.fechaFin);

  if (fechaInicioSQL) {
    filtros.push("a.fecha >= ?");
    parametros.push(fechaInicioSQL);
  }

  if (fechaFinSQL) {
    filtros.push("a.fecha <= ?");
    parametros.push(fechaFinSQL);
  }

  const whereClause = `WHERE ${filtros.join(" AND ")}`;

  const [asistencias] = await db.query(
    `SELECT 
       a.fecha,
       c.nombre AS curso,
       a.hora_entrada_prog,
       a.hora_entrada,
       a.hora_salida_prog,
       a.hora_salida,
       a.minutos_observacion,
       a.es_recuperacion,
       a.falta_recuperada
     FROM asistencias a
     JOIN cursos c ON a.id_curso = c.id_curso
     ${whereClause}
     ORDER BY a.fecha, a.hora_entrada_prog`,
    parametros
  );

  const workbook = new ExcelJS.Workbook();
  // Vista limpia sin gridlines
  const sheet = workbook.addWorksheet("Asistencias", {
    views: [{ showGridLines: false }]
  });

  // Configurar anchos de columna
  sheet.columns = [
    { key: "fecha", width: 15 },
    { key: "curso", width: 35 },
    { key: "hora_entrada_prog", width: 15 },
    { key: "hora_entrada", width: 15 },
    { key: "hora_salida_prog", width: 15 },
    { key: "hora_salida", width: 15 },
    { key: "estado", width: 15 },
    { key: "min_excedentes", width: 18 },
    { key: "observacion", width: 70 }, // Más ancha para texto explicativo
  ];

  // --- ESTILOS DEFINIDOS ---
  const borderStyle = {
    top: { style: "thin", color: { argb: "FF888888" } },
    left: { style: "thin", color: { argb: "FF888888" } },
    bottom: { style: "thin", color: { argb: "FF888888" } },
    right: { style: "thin", color: { argb: "FF888888" } }
  };

  const styles = {
    title: {
      font: { name: "Arial", bold: true, size: 18, color: { argb: "FFFFFFFF" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF203764" } }, // Azul oscuro profundo
      alignment: { horizontal: "center", vertical: "middle" }
    },
    label: {
      font: { name: "Arial", bold: true, size: 11, color: { argb: "FF44546A" } }, // Gris azulado
      alignment: { vertical: "middle", horizontal: "left", indent: 1 }
    },
    value: {
      font: { name: "Arial", size: 11, color: { argb: "FF000000" } },
      alignment: { vertical: "middle", horizontal: "left" }
    },
    header: {
      font: { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } }, // Azul corporativo
      alignment: { horizontal: "center", vertical: "middle" },
      border: { bottom: { style: "medium", color: { argb: "FFFFFFFF" } } }
    },
    cellBase: {
      font: { name: "Arial", size: 10 },
      alignment: { vertical: "middle", horizontal: "center", wrapText: true },
      border: borderStyle
    },
    // Badges
    badgeSuccess: {
      font: { name: "Arial", bold: true, color: { argb: "FF385723" } }, 
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } } // Verde pastel
    },
    badgeError: {
      font: { name: "Arial", bold: true, color: { argb: "FF9C0006" } }, 
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } } // Rojo pastel
    },
    badgeWarning: {
      font: { name: "Arial", bold: true, color: { argb: "FF9C5700" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEB9C" } } // Amarillo pastel
    },
    badgeRecuperacion: {
      font: { name: "Arial", bold: true, color: { argb: "FF002060" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } } // Azul claro
    }
  };

  // 1. Título
  sheet.mergeCells("A1:I2");
  const titleCell = sheet.getCell("A1");
  titleCell.value = "REPORTE DE ASISTENCIAS";
  titleCell.style = styles.title;

  // 2. Información del Docente (Estilo Tarjeta con fondo gris)
  for (let r = 3; r <= 4; r++) {
    for (let c = 1; c <= 9; c++) {
      sheet.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    }
  }

  sheet.mergeCells("A3:B3");
  sheet.getCell("A3").value = "DOCENTE:";
  sheet.getCell("A3").style = styles.label;
  
  sheet.mergeCells("C3:I3");
  sheet.getCell("C3").value = nombreDocente;
  sheet.getCell("C3").style = styles.value;
  sheet.getCell("C3").font = { ...styles.value.font, size: 12, bold: true };

  sheet.mergeCells("A4:B4");
  sheet.getCell("A4").value = "DNI:";
  sheet.getCell("A4").style = styles.label;

  sheet.mergeCells("C4:I4");
  sheet.getCell("C4").value = dni;
  sheet.getCell("C4").style = styles.value;

  // Espacio
  sheet.addRow([]);
  sheet.getRow(5).height = 10;

  // 3. Encabezados Tabla
  const headerRow = sheet.addRow([
    "Fecha", "Curso", "Entrada Prog.", "Entrada Real", 
    "Salida Prog.", "Salida Real", "Estado", "Min. Exc.", "Observaciones"
  ]);
  headerRow.height = 30;
  headerRow.eachCell((cell) => { cell.style = styles.header; });

  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toISOString().split('T')[0];
  };

  const formatHora = (horaStr) => horaStr ? horaStr.slice(0, 5) : "--:--";

  let totalMinutosExcedentes = 0;

  if (asistencias.length === 0) {
    const row = sheet.addRow(["SIN REGISTROS DE ASISTENCIA", "", "", "", "", "", "", "", ""]);
    sheet.mergeCells(`A${row.number}:I${row.number}`);
    row.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    row.height = 40;
  } else {
    asistencias.forEach((row, index) => {
      const detalle = calcularDetalleAsistencia(row);
      totalMinutosExcedentes += Number(detalle.minutosExcedentes) || 0;
      const dataRow = sheet.addRow([
        formatDate(row.fecha),
        row.curso,
        formatHora(row.hora_entrada_prog),
        formatHora(row.hora_entrada),
        formatHora(row.hora_salida_prog),
        formatHora(row.hora_salida),
        detalle.estado,
        detalle.minutosExcedentes > 0 ? detalle.minutosExcedentes : "-",
        detalle.observacion,
      ]);
      dataRow.height = 25;

      // Zebra Striping (Filas alternas)
      const isEven = index % 2 === 0;
      const rowFill = isEven ? null : { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };

      dataRow.eachCell((cell, colNumber) => {
        cell.style = styles.cellBase;
        if (rowFill) cell.fill = rowFill;
        
        // Alineación izquierda para textos largos
        if (colNumber === 2) cell.alignment = { ...styles.cellBase.alignment, horizontal: "left", indent: 1 };
        if (colNumber === 9) cell.alignment = { ...styles.cellBase.alignment, horizontal: "left", wrapText: true };
      });

      // --- Badges y Alertas ---
      if (detalle.llegoTarde && row.hora_entrada) {
        dataRow.getCell(4).style = { ...styles.cellBase, ...styles.badgeWarning };
      }
      if (detalle.salioAntes && row.hora_salida) {
        dataRow.getCell(6).style = { ...styles.cellBase, ...styles.badgeWarning };
      }

      const estadoCell = dataRow.getCell(7);
      if (detalle.estado === "FALTA") {
        estadoCell.style = { ...styles.cellBase, ...styles.badgeError };
      } else if (detalle.estado === "RECUPERADO") {
        estadoCell.style = { ...styles.cellBase, ...styles.badgeRecuperacion };
      } else {
        estadoCell.style = { ...styles.cellBase, ...styles.badgeSuccess };
      }

      if (row.es_recuperacion) {
        dataRow.getCell(9).style = { ...styles.cellBase, ...styles.badgeRecuperacion, horizontal: "left", wrapText: true };
      }
    });
  }

  const totalRow = sheet.addRow([
    "", "", "", "", "", "", "Total min. excedentes", totalMinutosExcedentes > 0 ? totalMinutosExcedentes : "-", ""
  ]);
  totalRow.eachCell((cell, colNumber) => {
    cell.style = { ...styles.cellBase, font: { ...styles.cellBase.font, bold: true } };
    if (colNumber === 7 || colNumber === 8) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
    }
    if (colNumber === 7) cell.alignment = { ...styles.cellBase.alignment, horizontal: "right" };
    if (colNumber === 8) cell.alignment = { ...styles.cellBase.alignment, horizontal: "center" };
  });

  return workbook;
}

/* ================= ADMINISTRACIÓN DE ASISTENCIAS ================= */
app.get("/api/admin/asistencias", async (req, res) => {
  try {
    const mostrarTodos = incluirInactivos(req);
    const condiciones = [];
    if (!mostrarTodos) {
      condiciones.push("COALESCE(a.activacion, 1) = 1");
      condiciones.push("d.activacion = 1");
      condiciones.push("c.activacion = 1");
    }
    const whereClause = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const [rows] = await db.query(
      `SELECT 
         a.id_asistencia,
         a.id_docente,
         a.id_curso,
         a.fecha,
         a.hora_entrada_prog,
         a.hora_entrada,
         a.hora_salida_prog,
         a.hora_salida,
         a.minutos_observacion,
         a.es_recuperacion,
         a.falta_recuperada,
         COALESCE(a.activacion, 1) AS activacion,
         d.nombre AS docente,
         d.dni,
         d.activacion AS activacion_docente,
         c.nombre AS curso,
         c.activacion AS activacion_curso
       FROM asistencias a
       JOIN docentes d ON a.id_docente = d.id_docente
       JOIN cursos c ON a.id_curso = c.id_curso
       ${whereClause}
       ORDER BY a.fecha DESC, a.hora_entrada_prog DESC
       LIMIT 500`
    );

    const registros = rows.map((row) => {
      const detalle = calcularDetalleAsistencia(row);
      const fechaISO = row.fecha instanceof Date ? row.fecha.toISOString().slice(0, 10) : row.fecha;

      return {
        id: row.id_asistencia,
        idDocente: row.id_docente,
        idCurso: row.id_curso,
        fecha: fechaISO,
        docente: row.docente,
        dni: row.dni,
        curso: row.curso,
        horaEntradaProg: row.hora_entrada_prog,
        horaEntradaReal: row.hora_entrada,
        horaSalidaProg: row.hora_salida_prog,
        horaSalidaReal: row.hora_salida,
        minutosObservacion: row.minutos_observacion,
        esRecuperacion: !!row.es_recuperacion,
        faltaRecuperada: !!row.falta_recuperada,
        activacion: row.activacion,
        activacionDocente: row.activacion_docente,
        activacionCurso: row.activacion_curso,
        estado: detalle.estado,
        minutosNoTrabajados: detalle.minutosExcedentes,
        observacion: detalle.observacion,
      };
    });

    res.json(registros);
  } catch (err) {
    console.error("Error listando asistencias admin:", err);
    res.status(500).json({ error: "Error al listar asistencias." });
  }
});

app.post("/api/admin/asistencias", async (req, res) => {
  try {
    const {
      idDocente,
      idCurso,
      fecha,
      horaEntradaProg,
      horaEntradaReal,
      horaSalidaProg,
      horaSalidaReal,
      esRecuperacion,
      faltaRecuperada,
      activacion,
    } = req.body;

    const esFalta = !horaEntradaReal && !horaSalidaReal;
    const faltaRecuperadaFinal = esFalta && faltaRecuperada ? 1 : 0;

    if (!idDocente || !idCurso || !fecha || !horaEntradaProg || !horaSalidaProg) {
      return res.status(400).json({ error: "Datos incompletos." });
    }

    const detalle = calcularDetalleAsistencia({
      hora_entrada_prog: horaEntradaProg,
      hora_entrada: horaEntradaReal,
      hora_salida_prog: horaSalidaProg,
      hora_salida: horaSalidaReal,
      minutos_observacion: null,
      es_recuperacion: esRecuperacion ? 1 : 0,
      falta_recuperada: faltaRecuperadaFinal,
    });

    const [result] = await db.query(
      `INSERT INTO asistencias
       (id_docente, id_curso, fecha, hora_entrada, hora_salida, hora_entrada_prog, hora_salida_prog, minutos_observacion, es_recuperacion, falta_recuperada, activacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      , [
        idDocente,
        idCurso,
        fecha,
        horaEntradaReal || null,
        horaSalidaReal || null,
        horaEntradaProg,
        horaSalidaProg,
        detalle.minutosExcedentes,
        esRecuperacion ? 1 : 0,
        faltaRecuperadaFinal,
        activacion === 0 ? 0 : 1,
      ]
    );

    const registro = await obtenerAsistenciaAdmin(result.insertId);
    broadcastAdminRefresh("asistencias:create");
    res.status(201).json(registro);
  } catch (err) {
    console.error("Error creando asistencia manual:", err);
    res.status(500).json({ error: "No se pudo crear la asistencia." });
  }
});

app.put("/api/admin/asistencias/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      idDocente,
      idCurso,
      fecha,
      horaEntradaProg,
      horaEntradaReal,
      horaSalidaProg,
      horaSalidaReal,
      esRecuperacion,
      faltaRecuperada,
      activacion,
    } = req.body;

    const esFalta = !horaEntradaReal && !horaSalidaReal;
    const faltaRecuperadaFinal = esFalta && faltaRecuperada ? 1 : 0;

    if (!idDocente || !idCurso || !fecha || !horaEntradaProg || !horaSalidaProg) {
      return res.status(400).json({ error: "Datos incompletos." });
    }

    const detalle = calcularDetalleAsistencia({
      hora_entrada_prog: horaEntradaProg,
      hora_entrada: horaEntradaReal,
      hora_salida_prog: horaSalidaProg,
      hora_salida: horaSalidaReal,
      minutos_observacion: null,
      es_recuperacion: esRecuperacion ? 1 : 0,
      falta_recuperada: faltaRecuperadaFinal,
    });

    const activacionFinal = activacion === 0 ? 0 : 1;

    const [result] = await db.query(
      `UPDATE asistencias
       SET id_docente = ?,
           id_curso = ?,
           fecha = ?,
           hora_entrada = ?,
           hora_salida = ?,
           hora_entrada_prog = ?,
           hora_salida_prog = ?,
           minutos_observacion = ?,
           es_recuperacion = ?,
           falta_recuperada = ?,
           activacion = ?
       WHERE id_asistencia = ?`,
      [
        idDocente,
        idCurso,
        fecha,
        horaEntradaReal || null,
        horaSalidaReal || null,
        horaEntradaProg,
        horaSalidaProg,
        detalle.minutosExcedentes,
        esRecuperacion ? 1 : 0,
        faltaRecuperadaFinal,
        activacionFinal,
        id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Asistencia no encontrada." });
    }

    console.log("[Asistencias] Actualizar", id, {
      idDocente,
      idCurso,
      fecha,
      activacion: activacionFinal,
    });

    const registro = await obtenerAsistenciaAdmin(id);
    broadcastAdminRefresh("asistencias:update");
    res.json(registro);
  } catch (err) {
    console.error("Error actualizando asistencia manual:", err);
    res.status(500).json({ error: "No se pudo actualizar la asistencia." });
  }
});

app.patch("/api/admin/asistencias/:id/desactivar", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query(
      "UPDATE asistencias SET activacion = 0 WHERE id_asistencia = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Asistencia no encontrada." });
    }

    return respondWithAdminRefresh(res, "asistencias:desactivar", { ok: true });
  } catch (err) {
    console.error("Error desactivando asistencia:", err);
    res.status(500).json({ error: "No se pudo desactivar la asistencia." });
  }
});

app.delete("/api/admin/asistencias/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // Para mantener integridad histórica NUNCA eliminar registros físicamente.
    // Convertimos la petición DELETE en una desactivación (soft-delete).
    const [result] = await db.query(
      "UPDATE asistencias SET activacion = 0 WHERE id_asistencia = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Asistencia no encontrada." });
    }

    return respondWithAdminRefresh(res, "asistencias:delete", { ok: true, message: 'Registro desactivado (simulación de eliminación).' });
  } catch (err) {
    console.error("Error eliminando asistencia:", err);
    res.status(500).json({ error: "No se pudo eliminar la asistencia." });
  }
});

app.get("/api/admin/reporte-preview/:dni", async (req, res) => {
  try {
    const { dni } = req.params;

    const [[docente]] = await db.query(
      "SELECT id_docente, nombre FROM docentes WHERE dni = ?",
      [dni]
    );

    if (!docente) {
      return res.status(404).json({ error: "Docente no encontrado" });
    }

    const [asistencias] = await db.query(
      `SELECT 
         a.fecha,
         c.nombre AS curso,
         a.hora_entrada_prog,
         a.hora_entrada,
         a.hora_salida_prog,
         a.hora_salida,
         a.minutos_observacion,
         a.es_recuperacion,
         a.falta_recuperada
       FROM asistencias a
       JOIN cursos c ON a.id_curso = c.id_curso
       WHERE a.id_docente = ?
       ORDER BY a.fecha, a.hora_entrada_prog`,
      [docente.id_docente]
    );

    let totalMinutosExcedentes = 0;

    const registros = asistencias.map((row) => {
      const detalle = calcularDetalleAsistencia(row);
      totalMinutosExcedentes += Number(detalle.minutosExcedentes) || 0;
      return {
        fecha: row.fecha,
        curso: row.curso,
        horaEntradaProgramada: row.hora_entrada_prog,
        horaEntradaReal: row.hora_entrada,
        horaSalidaProgramada: row.hora_salida_prog,
        horaSalidaReal: row.hora_salida,
        estado: detalle.estado,
        minutosExcedentes: detalle.minutosExcedentes,
        observacion: detalle.observacion,
        esRecuperacion: !!row.es_recuperacion,
        faltaRecuperada: !!row.falta_recuperada,
      };
    });

    const generadoEn = await obtenerFechaHoraServidor();

    res.json({
      docente: {
        nombre: docente.nombre,
        dni,
      },
      registros,
      totalMinutosExcedentes,
      generadoEn: generadoEn.toISOString(),
    });
  } catch (err) {
    console.error("Error generando vista previa:", err);
    res.status(500).json({ error: "Error generando vista previa" });
  }
});

app.get("/api/admin/reporte-excel/:dni", async (req, res) => {
  try {
    const { dni } = req.params;

    const [[docente]] = await db.query(
      "SELECT id_docente, nombre FROM docentes WHERE dni = ?",
      [dni]
    );

    if (!docente) {
      return res.status(404).send("Docente no encontrado");
    }

    // Generar nombre de archivo dinámico: reporte_Nombre_MesAño.xlsx
    const now = await obtenerFechaHoraServidor();
    // Usamos el mes actual para el reporte inmediato
    const mes = now.toLocaleString("es-ES", { month: "long" });
    const anio = now.getFullYear();
    const nombreLimpio = docente.nombre.replace(/[^a-zA-Z0-9]/g, "_");
    const filename = `reporte_${nombreLimpio}_${mes}${anio}.xlsx`;

    const workbook = await crearWorkbookDocente(docente.id_docente, docente.nombre, dni);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${filename}`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generando reporte Excel:", err);
    res.status(500).send("Error generando reporte");
  }
});

function obtenerNombreMes(anio, mes) {
  const fechaReferencia = new Date(anio, mes - 1, 1);
  return fechaReferencia.toLocaleString("es-ES", { month: "long" });
}

function obtenerCarpetaMensual(nombreMes, anio) {
  return path.join(REPORTS_BASE_PATH, `${nombreMes}_${anio}`);
}

function obtenerMarcadorMensual(carpetaMensual) {
  return path.join(carpetaMensual, MARCADOR_REPORTES_MENSUALES);
}

function escribirMarcadorMensual(rutaMarcador, motivo, tuvoErrores) {
  const estado = tuvoErrores ? "con_errores" : "ok";
  const contenido = [
    `generado=${new Date().toISOString()}`,
    `motivo=${motivo}`,
    `estado=${estado}`,
  ].join("\n");
  fs.writeFileSync(rutaMarcador, contenido, "utf8");
}

async function generarReportesMensualesDelMes(anio, mes, motivo, opciones = {}) {
  const { modo = "activos" } = opciones;
  const anioNum = Number(anio);
  const mesNum = Number(mes);
  if (!Number.isFinite(anioNum) || !Number.isFinite(mesNum) || mesNum < 1 || mesNum > 12) {
    return;
  }

  const nombreMes = obtenerNombreMes(anioNum, mesNum);
  const etiquetaMes = `${nombreMes} ${anioNum}`;
  const carpetaMensual = obtenerCarpetaMensual(nombreMes, anioNum);
  const marcador = obtenerMarcadorMensual(carpetaMensual);

  if (fs.existsSync(marcador)) {
    console.log(`Reportes mensuales '${etiquetaMes}' ya generados. Se omite (${motivo}).`);
    return;
  }

  if (!fs.existsSync(carpetaMensual)) {
    fs.mkdirSync(carpetaMensual, { recursive: true });
    console.log(`🆕 Carpeta mensual creada (${etiquetaMes}): ${carpetaMensual}`);
  } else {
    console.log(`ℹ️ Carpeta mensual existente (${etiquetaMes}): ${carpetaMensual}`);
  }
  const carpetaMensualRelativa = path.relative(ROOT_PATH, carpetaMensual);

  const fechaInicioMes = new Date(anioNum, mesNum - 1, 1).toISOString().slice(0, 10);
  const fechaFinMes = new Date(anioNum, mesNum, 0).toISOString().slice(0, 10);

  let docentesMes = [];
  if (modo === "asistencias") {
    const [rows] = await db.query(`
      SELECT DISTINCT a.id_docente, d.nombre, d.dni
      FROM asistencias a
      JOIN docentes d ON a.id_docente = d.id_docente
      WHERE a.fecha >= ? AND a.fecha <= ?
        AND COALESCE(a.activacion, 1) = 1
    `, [fechaInicioMes, fechaFinMes]);
    docentesMes = rows;
  } else {
    const [rows] = await db.query(
      "SELECT id_docente, nombre, dni FROM docentes WHERE activacion = 1"
    );
    docentesMes = rows;
  }

  if (!docentesMes.length) {
    const etiquetaVacia = modo === "asistencias" ? "sin-asistencias" : "sin-docentes";
    console.log(`   - No se encontraron docentes para ${etiquetaMes} (${modo}).`);
    escribirMarcadorMensual(marcador, `${motivo}-${etiquetaVacia}`, false);
    return;
  }

  console.log(`   - Generando reportes mensuales para ${docentesMes.length} docentes en '${carpetaMensualRelativa}'.`);

  let tuvoErrores = false;

  for (const docente of docentesMes) {
    try {
      const nombreLimpio = String(docente.nombre || "").replace(/[^a-zA-Z0-9]/g, "_");
      const slugDocente = nombreLimpio || docente.dni || `docente_${docente.id_docente}`;
      const carpetaDocente = path.join(carpetaMensual, slugDocente);
      if (!fs.existsSync(carpetaDocente)) {
        fs.mkdirSync(carpetaDocente, { recursive: true });
      }
      const filename = `reporte_${slugDocente}.xlsx`;
      const filePath = path.join(carpetaDocente, filename);

      if (fs.existsSync(filePath)) {
        continue;
      }

      const workbook = await crearWorkbookDocente(docente.id_docente, docente.nombre, docente.dni, {
        fechaInicio: fechaInicioMes,
        fechaFin: fechaFinMes,
      });
      await workbook.xlsx.writeFile(filePath);
      console.log(`      • Reporte mensual guardado (${etiquetaMes}): ${path.relative(ROOT_PATH, filePath)}`);
    } catch (errDoc) {
      tuvoErrores = true;
      console.error(`   ❌ Error generando reporte mensual para ${docente.nombre}:`, errDoc);
    }
  }

  escribirMarcadorMensual(marcador, motivo, tuvoErrores);
  if (tuvoErrores) {
    console.log(`   - Reportes mensuales '${etiquetaMes}' generados con errores. Revisar logs.`);
  }
}

async function sincronizarReportesMensualesPendientes({ motivo = "inicio-servidor" } = {}) {
  try {
    const ahora = await obtenerFechaHoraServidor();
    const anioActual = ahora.getFullYear();
    const mesActual = ahora.getMonth() + 1;

    const [mesesPendientes] = await db.query(`
      SELECT DISTINCT YEAR(a.fecha) AS anio, MONTH(a.fecha) AS mes
      FROM asistencias a
      WHERE COALESCE(a.activacion, 1) = 1
      ORDER BY anio, mes
    `);

    if (!mesesPendientes.length) {
      return;
    }

    const mesesAProcesar = mesesPendientes.filter((registro) => (
      registro.anio < anioActual || (registro.anio === anioActual && registro.mes < mesActual)
    ));
    const tieneMesActualOFuturo = mesesPendientes.some((registro) => (
      registro.anio > anioActual || (registro.anio === anioActual && registro.mes >= mesActual)
    ));

    if (!mesesAProcesar.length) {
      if (tieneMesActualOFuturo) {
        console.log("ℹ️ Mes actual detectado: se generara al cierre de mes.");
      }
      return;
    }

    console.log(`📆 Sincronizando reportes mensuales pendientes (${mesesAProcesar.length} meses)...`);

    for (const registro of mesesAProcesar) {
      await generarReportesMensualesDelMes(registro.anio, registro.mes, motivo, { modo: "asistencias" });
    }
  } catch (err) {
    console.error("Error sincronizando reportes mensuales pendientes:", err);
  }
}

/* ================= AUTOMATIZACIÓN DE REPORTES (FIN DE MES) ================= */
async function revisarGeneracionAutomatica() {
  try {
    const now = await obtenerFechaHoraServidor();
    // Estrategia: Revisamos si mañana es día 1. Si mañana es día 1, hoy es fin de mes.
    const manana = new Date(now);
    manana.setDate(manana.getDate() + 1);

    const esUltimoDia = manana.getDate() === 1;
    const horaLimiteAlcanzada = now.getHours() >= 23; // toleramos 23:00 en adelante
    const claveMes = `${now.getFullYear()}-${now.getMonth() + 1}`;

    if (!esUltimoDia || !horaLimiteAlcanzada) {
      return;
    }

    if (ultimaGeneracionMensual === claveMes) {
      return; // ya se ejecutó por este mes
    }

    ultimaGeneracionMensual = claveMes;
    console.log("🚀 Iniciando generación automática de reportes de fin de mes...");
    await generarReportesMensualesDelMes(now.getFullYear(), now.getMonth() + 1, "fin-de-mes", { modo: "activos" });
    console.log("🏁 Generación automática completada.");
  } catch (err) {
    console.error("Error en el proceso automático de reportes:", err);
  }
}

// Revisar cada 1 minuto para mayor precisión (o cada hora si se prefiere)
// Dado que buscamos 23:00 exacto, mejor cada minuto, o manejar intervalo amplio pero con check de "ya se ejcutó hoy".
// Para simplicidad del ejemplo y evitar carga excesiva, checking cada 1 min es seguro en Node.
setInterval(revisarGeneracionAutomatica, 60 * 1000); 


const MARCADOR_REPORTES_PERIODO = ".reportes_periodo_generados";

function obtenerCarpetaPeriodo(periodo) {
  const nombreCarpeta = periodo && periodo.nombre
    ? String(periodo.nombre).replace(/[^a-zA-Z0-9-_]/g, "_")
    : `periodo_${periodo.id_periodo}`;
  return path.join(SEMESTRES_BASE_PATH, nombreCarpeta);
}

function obtenerMarcadorReportesPeriodo(carpetaPeriodo) {
  return path.join(carpetaPeriodo, MARCADOR_REPORTES_PERIODO);
}

function escribirMarcadorReportesPeriodo(rutaMarcador, motivo, tuvoErrores) {
  const estado = tuvoErrores ? "con_errores" : "ok";
  const contenido = [
    `generado=${new Date().toISOString()}`,
    `motivo=${motivo}`,
    `estado=${estado}`,
  ].join("\n");
  fs.writeFileSync(rutaMarcador, contenido, "utf8");
}

async function generarReportesPeriodo(periodo, motivo) {
  const nombrePeriodo = periodo && periodo.nombre
    ? periodo.nombre
    : `periodo_${periodo.id_periodo}`;
  const carpetaPeriodo = obtenerCarpetaPeriodo(periodo);
  const marcador = obtenerMarcadorReportesPeriodo(carpetaPeriodo);

  if (fs.existsSync(marcador)) {
    console.log(`Reportes del periodo '${nombrePeriodo}' ya generados. Se omite (${motivo}).`);
    return;
  }

  if (!fs.existsSync(carpetaPeriodo)) {
    fs.mkdirSync(carpetaPeriodo, { recursive: true });
    console.log(`🆕 Carpeta creada para el periodo '${nombrePeriodo}': ${carpetaPeriodo}`);
  } else {
    console.log(`ℹ️ Carpeta reutilizada para el periodo '${nombrePeriodo}': ${carpetaPeriodo}`);
  }
  const carpetaPeriodoRelativa = path.relative(ROOT_PATH, carpetaPeriodo);

  const fechaInicioSQL = normalizarFechaSQL(periodo.fecha_inicio);
  const fechaFinSQL = normalizarFechaSQL(periodo.fecha_fin);

  const [docentesPeriodo] = await db.query(`
    SELECT DISTINCT h.id_docente, d.nombre, d.dni
    FROM horarios h
    JOIN docentes d ON h.id_docente = d.id_docente
    WHERE h.id_periodo = ? AND d.activacion = 1
  `, [periodo.id_periodo]);

  if (!docentesPeriodo.length) {
    console.log(`   - No se encontraron docentes asociados al periodo '${nombrePeriodo}'.`);
    escribirMarcadorReportesPeriodo(marcador, `${motivo}-sin-docentes`, false);
    return;
  }

  console.log(`   - Generando reportes del periodo para ${docentesPeriodo.length} docentes en '${carpetaPeriodo}'.`);

  let tuvoErrores = false;

  for (const docente of docentesPeriodo) {
    try {
      const workbook = await crearWorkbookDocente(docente.id_docente, docente.nombre, docente.dni, {
        fechaInicio: fechaInicioSQL,
        fechaFin: fechaFinSQL
      });
      const nombreLimpio = docente.nombre.replace(/[^a-zA-Z0-9]/g, "_");
      const nombreArchivo = `reporte_${nombreLimpio || docente.id_docente}.xlsx`;
      const destinoReporte = path.join(carpetaPeriodo, nombreArchivo);
      console.log(`      ↳ Preparando ${nombreArchivo} (${docente.nombre}) dentro de ${carpetaPeriodoRelativa}`);
      await workbook.xlsx.writeFile(destinoReporte);
      console.log(`      • Reporte del periodo guardado (${nombrePeriodo}): ${path.relative(ROOT_PATH, destinoReporte)}`);
    } catch (errDoc) {
      tuvoErrores = true;
      console.error(`   ❌ Error generando reporte del periodo para ${docente.nombre}:`, errDoc);
    }
  }

  escribirMarcadorReportesPeriodo(marcador, motivo, tuvoErrores);
  if (tuvoErrores) {
    console.log(`   - Reportes del periodo '${nombrePeriodo}' generados con errores. Revisar logs.`);
  }
}


/* ================= LIMPIEZA AUTOMÁTICA ================= */
async function limpiarPeriodosVencidos({ motivo = "manual" } = {}) {
  if (limpiezaPeriodosEnCurso) {
    console.log(`⏳ Limpieza de periodos ya en curso. Se omite disparo (${motivo}).`);
    return;
  }

  limpiezaPeriodosEnCurso = true;

  try {
    const ahora = await obtenerFechaHoraServidor();
    const minutosDelDia = ahora.getHours() * 60 + ahora.getMinutes();
    const listoParaUltimoDia = minutosDelDia >= 23 * 60; // 23:00

    const [resActivar] = await db.query(`
      UPDATE horarios h
      JOIN periodos p ON h.id_periodo = p.id_periodo
      SET h.activacion = 1
      WHERE h.activacion = 0
        AND p.activacion = 1
        AND p.fecha_inicio <= CURDATE()
        AND p.fecha_fin >= CURDATE()
    `);

    if (resActivar.affectedRows > 0) {
      console.log(`✅ Horarios activados por inicio de periodo: ${resActivar.affectedRows}.`);
      broadcastAdminRefresh("horarios:activar-periodo", { total: resActivar.affectedRows });
    }

    if (listoParaUltimoDia) {
      const [periodosUltimoDia] = await db.query(`
        SELECT id_periodo, nombre, fecha_inicio, fecha_fin
        FROM periodos
        WHERE fecha_fin = CURDATE() AND activacion = 1
      `);

      for (const p of periodosUltimoDia) {
        await generarReportesPeriodo(p, "ultimo-dia");
      }
    }

    // Obtener periodos vencidos cuyo fin ya pasó respecto al día actual
    const [periodos] = await db.query(`
      SELECT id_periodo, nombre, fecha_inicio, fecha_fin 
      FROM periodos 
      WHERE fecha_fin < CURDATE() AND activacion = 1
    `);

    if (periodos.length === 0) {
      return;
    }

    console.log(`🧹 (${motivo}) Se limpiarán ${periodos.length} periodos vencidos.`);

    for (const p of periodos) {
      await generarReportesPeriodo(p, "vencido");
      // 1. Desactivar horarios vinculados al periodo
      const [resHorarios] = await db.query("UPDATE horarios SET activacion = 0 WHERE id_periodo = ?", [p.id_periodo]);
      console.log(`   - Periodo '${p.nombre}' (Fin: ${p.fecha_fin}): Desactivados ${resHorarios.affectedRows} horarios.`);

      // 2. Desactivar el periodo mismo
      await db.query("UPDATE periodos SET activacion = 0 WHERE id_periodo = ?", [p.id_periodo]);
      console.log(`   - Periodo '${p.nombre}' desactivado correctamente.`);
    }

    console.log("✅ Proceso de desactivación completado.");
  } catch (err) {
    console.error("❌ Error en desactivación de periodos:", err);
  } finally {
    limpiezaPeriodosEnCurso = false;
  }
}

setInterval(() => limpiarPeriodosVencidos({ motivo: "intervalo" }), LIMPIEZA_PERIODOS_INTERVALO_MS);

/* ================= SERVER ================= */
app.listen(3000, () => {
  console.log("✅ Servidor corriendo en http://localhost:3000");
  
  // Ejecutar limpieza al iniciar el servidor
  limpiarPeriodosVencidos({ motivo: "inicio-servidor" });
  sincronizarReportesMensualesPendientes({ motivo: "inicio-servidor" });
});