/*********************************
 * ADMIN PANEL - GESTIÓN COMPLETA - VESRION FINALISIMA - SANDRO CARDENAS VILCA
 *********************************/

let docentes = [];
let cursos = [];
let horarios = [];
let bloqueados = [];
let activaciones = [];
let periodos = [];
let asistencias = [];
let promesaCargaGlobal = null;
// Usar rutas relativas (mismo origen cuando se sirve desde backend).
// Si la página NO se sirve desde el backend (ej. Live Server en :5500 o file://),
// forzar el BASE_URL hacia el servidor backend en http://localhost:3000
const BASE_URL = (typeof window !== 'undefined' && window.location && window.location.port === '3000')
  ? ''
  : 'http://localhost:3000';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_STREAM_URL = `${BASE_URL || ''}/api/admin/stream`;
const STREAM_RETRY_BASE_MS = 3000;
const STREAM_RETRY_MAX_MS = 15000;
const STREAM_AUTO_REFRESH_DELAY_MS = 800;

let adminEventSource = null;
let streamRetryTimer = null;
let streamRetryDelay = STREAM_RETRY_BASE_MS;
let autoRefreshTimer = null;
let refreshPendiente = false;

document.addEventListener('visibilitychange', manejarVisibilidadPanel);
window.addEventListener('beforeunload', () => cerrarStreamTiempoReal(true));

// Normalizar manejo de errores en fetch para no propagar respuestas erróneas como datos válidos
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const res = await nativeFetch(input, init);

    if (!res.ok) {
      let body;
      try {
        body = await res.clone().json();
      } catch (err) {
        try {
          body = await res.clone().text();
        } catch (innerErr) {
          body = null;
        }
      }

      const message = (body && body.error) || (body && body.message) || (typeof body === 'string' && body) || `HTTP ${res.status}`;
      const error = new Error(message);
      error.response = res;
      throw error;
    }

    return res;
  };
})();

async function solicitarAccesoAdmin() {
  // Solicitar la contraseña mediante SweetAlert2 con hasta tres intentos
  for (let intento = 0; intento < 3; intento++) {
    const { value: password, isConfirmed } = await Swal.fire({
      title: 'Acceso restringido',
      text: 'Ingresa la contraseña del panel administrativo.',
      input: 'password',
      inputPlaceholder: 'Contraseña',
      confirmButtonText: 'Ingresar',
      cancelButtonText: 'Cancelar',
      showCancelButton: true,
      allowOutsideClick: false,
      allowEscapeKey: false,
      inputAttributes: {
        autocapitalize: 'off',
        autocorrect: 'off'
      },
      preConfirm: (value) => {
        if (!value || !value.trim()) {
          Swal.showValidationMessage('Ingresa la contraseña');
        }
        return value;
      }
    });

    if (!isConfirmed) {
      return false;
    }

    if ((password || '').trim() === ADMIN_PASSWORD) {
      await Swal.fire({
        icon: 'success',
        title: 'Acceso concedido',
        timer: 1200,
        showConfirmButton: false
      });
      return true;
    }

    const quedanIntentos = intento < 2;
    await Swal.fire({
      icon: 'error',
      title: 'Contraseña incorrecta',
      text: quedanIntentos ? 'Intenta nuevamente.' : 'Se alcanzó el número máximo de intentos.',
      confirmButtonText: 'Entendido',
      allowOutsideClick: false
    });
  }

  return false;
}

let filtroDocentes = '';
let filtroCursos = '';
let filtroReportes = '';
let filtroHorarios = '';
let filtroPeriodos = '';
let filtroAsistencias = '';
let filtroChipAsistencias = ''; // 'tardanza' | 'recuperacion' | 'falta' | 'encurso' | ''

const vistaCompleta = {
  docentes: false,
  cursos: false,
  periodos: false,
  horarios: false,
  asistencias: false,
  reportes: false,
};

const paginacionSecciones = {
  docentes: { pagina: 1, tamano: 10 },
  cursos: { pagina: 1, tamano: 10 },
  periodos: { pagina: 1, tamano: 10 },
  horarios: { pagina: 1, tamano: 10 },
  reportes: { pagina: 1, tamano: 10 },
  asistencias: { pagina: 1, tamano: 10 },
};

const renderizadoresPorSeccion = {
  docentes: () => renderizarDocentes(),
  cursos: () => renderizarCursos(),
  periodos: () => renderizarPeriodos(),
  horarios: () => renderizarHorarios(),
  reportes: () => renderizarReportes(),
  asistencias: () => renderizarAsistencias(),
};

const contenedoresPaginacion = {
  docentes: 'paginationDocentes',
  cursos: 'paginationCursos',
  periodos: 'paginationPeriodos',
  horarios: 'paginationHorarios',
  reportes: 'paginationReportes',
  asistencias: 'paginationAsistencias',
};

function obtenerEstadoPaginacion(seccion) {
  if (!paginacionSecciones[seccion]) {
    paginacionSecciones[seccion] = { pagina: 1, tamano: 10 };
  }
  return paginacionSecciones[seccion];
}

function resetearPaginacion(seccion) {
  const estado = obtenerEstadoPaginacion(seccion);
  estado.pagina = 1;
}

function paginarLista(lista = [], seccion) {
  const estado = obtenerEstadoPaginacion(seccion);
  const tamano = estado.tamano || 10;
  const totalItems = Array.isArray(lista) ? lista.length : 0;
  const totalPaginas = Math.max(1, Math.ceil(Math.max(totalItems, 1) / tamano));
  const pagina = Math.min(Math.max(estado.pagina, 1), totalPaginas);
  estado.pagina = pagina;
  const inicio = totalItems ? (pagina - 1) * tamano : 0;
  const items = totalItems ? lista.slice(inicio, inicio + tamano) : [];
  return {
    items,
    meta: {
      pagina,
      totalPaginas,
      totalItems,
      tamano,
      desde: totalItems ? inicio + 1 : 0,
      hasta: totalItems ? Math.min(inicio + tamano, totalItems) : 0,
    }
  };
}

function obtenerMetaPaginacionVacia(seccion) {
  const estado = obtenerEstadoPaginacion(seccion);
  return {
    pagina: 1,
    totalPaginas: 1,
    totalItems: 0,
    tamano: estado.tamano || 10,
    desde: 0,
    hasta: 0,
  };
}

function irAPagina(seccion, pagina) {
  const estado = obtenerEstadoPaginacion(seccion);
  estado.pagina = Math.max(1, Math.floor(pagina) || 1);
  const render = renderizadoresPorSeccion[seccion];
  if (typeof render === 'function') {
    render();
  }
}

function renderizarControlesPaginacion(seccion, meta) {
  const contenedorId = contenedoresPaginacion[seccion];
  if (!contenedorId) return;
  const contenedor = document.getElementById(contenedorId);
  if (!contenedor) return;

  if (!meta || meta.totalItems <= meta.tamano) {
    contenedor.innerHTML = '';
    contenedor.style.display = 'none';
    return;
  }

  contenedor.style.display = '';
  const paginaActual = meta.pagina;
  const totalPaginas = meta.totalPaginas;
  const desde = meta.desde || 0;
  const hasta = meta.hasta || 0;

  contenedor.innerHTML = `
    <div class="pagination-info">Mostrando ${desde}-${hasta} de ${meta.totalItems} registros</div>
    <div class="pagination-controls">
      <button type="button" class="pagination-btn" data-action="prev" ${paginaActual === 1 ? 'disabled' : ''} aria-label="Página anterior">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="pagination-page">Página ${paginaActual} de ${totalPaginas}</span>
      <button type="button" class="pagination-btn" data-action="next" ${paginaActual === totalPaginas ? 'disabled' : ''} aria-label="Página siguiente">
        <i class="fa-solid fa-chevron-right"></i>
      </button>
      <div class="pagination-jump">
        <label>Ir a</label>
        <input type="number" min="1" max="${totalPaginas}" value="${paginaActual}" aria-label="Ir a la página en ${seccion}">
        <button type="button" class="pagination-go" data-action="jump">Ir</button>
      </div>
    </div>
  `;

  const prevBtn = contenedor.querySelector('button[data-action="prev"]');
  const nextBtn = contenedor.querySelector('button[data-action="next"]');
  const jumpBtn = contenedor.querySelector('button[data-action="jump"]');
  const jumpInput = contenedor.querySelector('input[type="number"]');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => irAPagina(seccion, paginaActual - 1));
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => irAPagina(seccion, paginaActual + 1));
  }
  const intentarSalto = () => {
    if (!jumpInput) return;
    const destino = Number(jumpInput.value);
    if (Number.isNaN(destino)) {
      jumpInput.value = paginaActual;
      return;
    }
    const paginaDestino = Math.floor(Math.min(Math.max(destino, 1), totalPaginas));
    irAPagina(seccion, paginaDestino);
  };
  if (jumpBtn) {
    jumpBtn.addEventListener('click', intentarSalto);
  }
  if (jumpInput) {
    jumpInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        intentarSalto();
      }
    });
  }
}

function actualizarMetricasAsistencias(lista = []) {
  const total = lista.length;
  const tardanzas = lista.filter((item) => esTardanzaVisible(item));
  const recuperaciones = lista.filter((item) => item.esRecuperacion).length;
  const faltas = lista.filter((item) => (item.estado || '').toUpperCase() === 'FALTA').length;
  const enCurso = lista.filter((item) => esAsistenciaEnCurso(item)).length;

  const totalNodo = document.getElementById('chipTotalAsistencias');
  const tardanzaNodo = document.getElementById('chipTardanzas');
  const recuperacionNodo = document.getElementById('chipRecuperaciones');
  const faltasNodo = document.getElementById('chipFaltas');
  const enCursoNodo = document.getElementById('chipEnCurso');

  if (totalNodo) totalNodo.textContent = total;
  if (tardanzaNodo) tardanzaNodo.textContent = tardanzas.length || 0;
  if (recuperacionNodo) recuperacionNodo.textContent = recuperaciones;
  if (faltasNodo) faltasNodo.textContent = faltas;
  if (enCursoNodo) enCursoNodo.textContent = enCurso;

  // Marcar el chip activo visualmente
  document.querySelectorAll('.highlight-card').forEach(card => card.classList.remove('chip-activo'));
  if (filtroChipAsistencias) {
    const mapa = {
      tardanza: '.highlight-card.tardanza',
      recuperacion: '.highlight-card.recuperacion',
      falta: '.highlight-card.faltas',
      encurso: '.highlight-card.encurso'
    };
    const sel = mapa[filtroChipAsistencias];
    if (sel) document.querySelector(sel)?.classList.add('chip-activo');
  }
}

function aplicarFiltroChip(tipo) {
  if (tipo === 'total' || filtroChipAsistencias === tipo) {
    filtroChipAsistencias = '';
  } else {
    filtroChipAsistencias = tipo;
  }
  resetearPaginacion('asistencias');
  renderizarAsistencias();
}

function configurarResaltadoDashboard() {
  const attendanceCard = document.querySelector('.attendance-card');
  if (!attendanceCard) return;

  const segmentos = ['tardanza', 'faltas', 'encurso', 'realizados'];
  const breakdownCards = attendanceCard.querySelectorAll('.attendance-breakdown .breakdown-card[data-segment]');
  if (!breakdownCards.length) return;

  const limpiarResaltado = () => {
    segmentos.forEach((segmento) => attendanceCard.classList.remove(`segment-highlight-${segmento}`));
    breakdownCards.forEach((card) => card.classList.remove('is-highlighted'));
  };

  const activarResaltado = (segmento, card) => {
    limpiarResaltado();
    if (!segmento || !card) return;
    attendanceCard.classList.add(`segment-highlight-${segmento}`);
    card.classList.add('is-highlighted');
  };

  breakdownCards.forEach((card) => {
    const segmento = card.getAttribute('data-segment');
    if (!segmento) return;
    card.addEventListener('mouseenter', () => activarResaltado(segmento, card));
    card.addEventListener('focus', () => activarResaltado(segmento, card));
    card.addEventListener('mouseleave', limpiarResaltado);
    card.addEventListener('blur', limpiarResaltado);
  });

  attendanceCard.addEventListener('mouseleave', limpiarResaltado);
}





const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function sanitizeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

// Un registro está "en curso" si ya marcó entrada y todavía no registra salida.
function esAsistenciaEnCurso(registro = {}) {
  const estado = (registro.estado || '').toUpperCase();
  if (estado === 'FALTA') return false;
  const tieneEntrada = Boolean(registro.horaEntradaReal);
  const tieneSalida = Boolean(registro.horaSalidaReal);
  return tieneEntrada && !tieneSalida;
}

function esTardanzaVisible(registro = {}) {
  if (!registro) return false;
  const estado = (registro.estado || '').toUpperCase();
  if (estado === 'FALTA') return false;
  return Number(registro.minutosNoTrabajados) > 0;
}

function contarActivos(lista, campo = 'activacion') {
  return Array.isArray(lista)
    ? lista.filter((item) => item && Number(item[campo]) !== 0).length
    : 0;
}

function esPeriodoVigente(periodo = {}) {
  if (Number(periodo.activacion) === 0) return false;
  const hoy = toInputDateValue(new Date());
  const inicio = toInputDateValue(periodo.fecha_inicio || periodo.fechaInicio);
  const fin = toInputDateValue(periodo.fecha_fin || periodo.fechaFin);
  const despuesDeInicio = !inicio || inicio <= hoy;
  const antesDeFin = !fin || fin >= hoy;
  return despuesDeInicio && antesDeFin;
}

function ordenarAsistenciasDesc(lista = []) {
  return [...lista].sort((a, b) => {
    const fechaA = a.fecha ? new Date(a.fecha).getTime() : 0;
    const fechaB = b.fecha ? new Date(b.fecha).getTime() : 0;
    if (fechaB !== fechaA) return fechaB - fechaA;
    const horaA = a.horaEntradaReal || a.horaEntradaProg || '';
    const horaB = b.horaEntradaReal || b.horaEntradaProg || '';
    if (horaB !== horaA) return horaB.localeCompare(horaA);
    return (a.docente || '').localeCompare(b.docente || '');
  });
}

function setDashboardText(id, valor) {
  const nodo = document.getElementById(id);
  if (nodo) nodo.textContent = valor;
}

function eliminarBotonActualizarPanel() {
  const heroActions = document.querySelector('.dashboard-hero .hero-actions');
  if (!heroActions) return;
  const boton = Array.from(heroActions.querySelectorAll('button')).find((btn) =>
    (btn.textContent || '').toLowerCase().includes('actualizar panel')
  );
  if (boton) {
    boton.remove();
  }
}

function actualizarDashboardInicio() {
  // Totales base
  const docentesActivos = contarActivos(docentes);
  setDashboardText('metricDocentesActivos', docentesActivos);
  setDashboardText('metricDocentesTotal', docentes.length || 0);

  const cursosActivos = contarActivos(cursos);
  setDashboardText('metricCursosActivos', cursosActivos);
  setDashboardText('metricCursosTotal', cursos.length || 0);

  const periodosVigentes = Array.isArray(periodos) ? periodos.filter(esPeriodoVigente).length : 0;
  setDashboardText('metricPeriodosVigentes', periodosVigentes);
  setDashboardText('metricPeriodosTotal', periodos.length || 0);

  const horariosActivos = contarActivos(horarios);
  setDashboardText('metricHorariosActivos', horariosActivos);
  setDashboardText('metricHorariosTotal', horarios.length || 0);

  // Asistencias del día
  const hoyIso = toInputDateValue(new Date());
  const asistenciasHoy = Array.isArray(asistencias)
    ? asistencias.filter((r) => toInputDateValue(r.fecha) === hoyIso)
    : [];
  const tardanzasHoy = asistenciasHoy.filter((r) => esTardanzaVisible(r));
  const faltasHoy = asistenciasHoy.filter((r) => (r.estado || '').toUpperCase() === 'FALTA');
  const enCursoHoy = asistenciasHoy.filter((r) => esAsistenciaEnCurso(r));
  const realizadosHoy = asistenciasHoy.filter((registro) => {
    const esTardanza = esTardanzaVisible(registro);
    const esFalta = (registro.estado || '').toUpperCase() === 'FALTA';
    const estaEnCurso = esAsistenciaEnCurso(registro);
    return !esTardanza && !esFalta && !estaEnCurso;
  }).length;

  setDashboardText('metricAsistenciasHoy', asistenciasHoy.length || 0);
  setDashboardText('metricTardanzasHoy', tardanzasHoy.length || 0);
  setDashboardText('metricFaltasHoy', faltasHoy.length || 0);
  setDashboardText('metricEnCursoHoy', enCursoHoy.length || 0);
  setDashboardText('metricRealizadosHoy', realizadosHoy || 0);

  const cobertura = docentesActivos > 0 ? Math.min(100, Math.round((asistenciasHoy.length / docentesActivos) * 100)) : 0;
  setDashboardText('metricCoberturaHoy', `${cobertura}%`);
  const gauge = document.getElementById('dashboardAsisGauge');
  if (gauge) {
    const totalEstadosHoy = tardanzasHoy.length + faltasHoy.length + enCursoHoy.length + realizadosHoy;
    const obtenerPorcentaje = (valor) => (totalEstadosHoy > 0 ? (valor / totalEstadosHoy) * 100 : 0);
    const normalizar = (valor) => {
      if (!Number.isFinite(valor)) return 0;
      return Math.max(0, Math.min(100, Number(valor.toFixed(2))));
    };

    const acumuladoRealizados = obtenerPorcentaje(realizadosHoy);
    const acumuladoTardanza = acumuladoRealizados + obtenerPorcentaje(tardanzasHoy.length);
    const acumuladoFalta = acumuladoTardanza + obtenerPorcentaje(faltasHoy.length);
    let acumuladoEnCurso = acumuladoFalta + obtenerPorcentaje(enCursoHoy.length);

    const segRealizados = normalizar(acumuladoRealizados);
    const segTardanza = normalizar(acumuladoTardanza);
    const segFalta = normalizar(acumuladoFalta);
    let segEnCurso = normalizar(acumuladoEnCurso);
    if (totalEstadosHoy > 0 && segEnCurso < 100) {
      segEnCurso = 100;
    }

    gauge.style.setProperty('--avance', `${cobertura}%`);
    gauge.style.setProperty('--segment-realizados', `${segRealizados}%`);
    gauge.style.setProperty('--segment-tardanza', `${segTardanza}%`);
    gauge.style.setProperty('--segment-falta', `${segFalta}%`);
    gauge.style.setProperty('--segment-encurso', `${segEnCurso}%`);
  }

  // Alertas recientes
  const alertList = document.getElementById('dashboardAlertList');
  if (alertList) {
    const incidencias = Array.isArray(asistencias)
      ? ordenarAsistenciasDesc(asistencias)
          .filter((r) => Number(r.minutosNoTrabajados) > 0 || (r.estado || '').toUpperCase() === 'FALTA')
          .slice(0, 4)
      : [];

    if (!incidencias.length) {
      alertList.innerHTML = '<li class="empty-state">Sin incidencias recientes.</li>';
    } else {
      alertList.innerHTML = incidencias.map((registro) => {
        const tipo = (registro.estado || '').toUpperCase() === 'FALTA' ? 'Falta' : 'Tardanza';
        const pillClass = tipo === 'Falta' ? 'pill-danger' : 'pill-warning';
        return `
          <li>
            <div>
              <strong>${sanitizeHtml(registro.docente || 'Sin docente')}</strong>
              <span>${sanitizeHtml(registro.curso || 'Sin curso')}</span>
            </div>
            <div class="alert-meta">
              <span class="pill ${pillClass}">${tipo}</span>
              <span class="time">${formatearFechaBonita(registro.fecha)}</span>
            </div>
          </li>
        `;
      }).join('');
    }
  }

  // Actividad reciente
  const tbody = document.getElementById('dashboardRecientes');
  if (tbody) {
    const recientes = Array.isArray(asistencias)
      ? ordenarAsistenciasDesc(asistencias).slice(0, 7)
      : [];
    if (!recientes.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#888;">Sin movimientos registrados.</td></tr>';
    } else {
      tbody.innerHTML = recientes.map((registro) => {
        const estado = sanitizeHtml(registro.estado || 'N/D');
        return `
          <tr>
            <td>${formatearFechaBonita(registro.fecha)}</td>
            <td>${sanitizeHtml(registro.docente || 'Sin docente')}</td>
            <td>${sanitizeHtml(registro.curso || 'Sin curso')}</td>
            <td>${estado}</td>
          </tr>
        `;
      }).join('');
    }
  }

  const ultima = document.getElementById('dashboardUltimaActualizacion');
  if (ultima) ultima.textContent = formatearFechaHoraLocal(new Date());
}

/*********************************
 * HELPERS AM/PM PARA HORARIOS
 *********************************/
function sincronizarBotonesAMPM(inputId) {
  const input = document.getElementById(inputId);
  const btnAM = document.getElementById(inputId + '-am');
  const btnPM = document.getElementById(inputId + '-pm');
  if (!btnAM || !btnPM) return;
  // Si no hay valor, AM por defecto
  if (!input || !input.value) {
    btnAM.classList.add('active');
    btnPM.classList.remove('active');
    return;
  }
  const h = parseInt(input.value.split(':')[0], 10);
  const esPM = !isNaN(h) && h >= 12;
  btnAM.classList.toggle('active', !esPM);
  btnPM.classList.toggle('active', esPM);
}

function setAMPM(inputId, periodo) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const partes = (input.value || '').split(':');
  if (partes.length < 2) return;
  let h = parseInt(partes[0], 10);
  if (isNaN(h)) return;
  if (periodo === 'PM' && h < 12) h += 12;
  if (periodo === 'AM' && h >= 12) h -= 12;
  input.value = `${String(h).padStart(2, '0')}:${partes[1]}`;
  sincronizarBotonesAMPM(inputId);
}

function formatearFechaBonita(valor) {
  if (!valor) return '--';
  const base = valor.toString().split('T')[0];
  const partes = base.split('-');
  if (partes.length !== 3) return base;
  const [anio, mes, dia] = partes;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const indiceMes = parseInt(mes, 10) - 1;
  const mesTexto = indiceMes >= 0 && indiceMes < meses.length ? meses[indiceMes] : mes;
  return `${dia}/${mesTexto}/${anio}`;
}

function formatearHoraCorta(valor) {
  if (!valor) return '--:--';
  const str = valor.toString();
  return str.length >= 5 ? str.slice(0, 5) : str;
}

function formatearFechaHoraLocal(valor) {
  if (!valor) return '';
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function normalizarTexto(valor) {
  return valor
    ? valor.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
    : '';
}

function convertirIsoALatam(valor) {
  if (!valor) return '';
  const iso = valor.toString().slice(0, 10);
  if (!iso.includes('-')) return iso;
  const [anio, mes, dia] = iso.split('-');
  if (!anio || !mes || !dia) return iso;
  return `${dia.padStart(2, '0')}/${mes.padStart(2, '0')}/${anio}`;
}

function actualizarToggleEstado(boton, activo) {
  if (!boton) return;
  if (activo) {
    boton.classList.add('btn-toggle-active');
    boton.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Ver solo activos';
  } else {
    boton.classList.remove('btn-toggle-active');
    boton.innerHTML = '<i class="fa-solid fa-eye"></i> Ver todos';
  }
}

function sincronizarToggleModal(toggleId) {
  const toggle = document.getElementById(toggleId);
  const caption = document.querySelector(`label[for="${toggleId}"].toggle-caption`);
  if (!toggle || !caption) return;
  const actualizar = () => {
    caption.textContent = toggle.checked ? 'Activo' : 'Inactivo';
  };
  actualizar();
  toggle.addEventListener('change', actualizar);
}

function obtenerValorToggle(toggleId) {
  return document.getElementById(toggleId)?.checked ? 1 : 0;
}

function toInputDateValue(valor) {
  if (!valor) return '';
  if (valor instanceof Date) {
    const year = valor.getFullYear();
    const month = String(valor.getMonth() + 1).padStart(2, '0');
    const day = String(valor.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const str = valor.toString();
  if (str.includes('T')) {
    return str.slice(0, 10);
  }
  return str.slice(0, 10);
}

function toInputTimeValue(valor) {
  if (!valor) return '';
  const str = valor.toString();
  if (!str.includes(':')) return '';
  return str.slice(0, 5);
}

function construirFilaPreview(reporte) {
  const entradaReal = formatearHoraCorta(reporte.horaEntradaReal);
  const salidaReal = formatearHoraCorta(reporte.horaSalidaReal);

  const estado = sanitizeHtml(reporte.estado || 'N/D');
  const estadoUpper = estado.toUpperCase();
  let estadoClase = 'success';
  let estadoIcon = 'fa-circle-check';
  if (estadoUpper === 'FALTA') {
    estadoClase = 'danger';
    estadoIcon = 'fa-triangle-exclamation';
  } else if (estadoUpper === 'RECUPERADO') {
    estadoClase = 'info';
    estadoIcon = 'fa-arrows-rotate';
  }
  const estadoBadge = `<span class="preview-badge ${estadoClase}"><i class="fa-solid ${estadoIcon}"></i>${estado}</span>`;

  const extras = [];
  if (reporte.minutosExcedentes && Number(reporte.minutosExcedentes) > 0) {
    extras.push(`<span class="preview-badge warning"><i class="fa-solid fa-clock"></i>${reporte.minutosExcedentes} min</span>`);
  }
  if (reporte.esRecuperacion) {
    extras.push('<span class="preview-badge info"><i class="fa-solid fa-arrows-rotate"></i>Recuperación</span>');
  }
  if (reporte.faltaRecuperada) {
    extras.push('<span class="preview-badge info"><i class="fa-solid fa-check-double"></i>Recuperado</span>');
  }

  const observacion = reporte.observacion
    ? sanitizeHtml(reporte.observacion).replace(/\n/g, '<br>')
    : 'Sin observaciones registradas.';

  return `
    <tr>
      <td>${formatearFechaBonita(reporte.fecha)}</td>
      <td>${sanitizeHtml(reporte.curso)}</td>
      <td>
        <div class="preview-time">
          <span><span class="time-value">${entradaReal}</span></span>
        </div>
      </td>
      <td>
        <div class="preview-time">
          <span><span class="time-value">${salidaReal}</span></span>
        </div>
      </td>
      <td>
        <div class="preview-state">
          ${estadoBadge}
          ${extras.length ? `<div class="preview-state-extra">${extras.join('')}</div>` : ''}
        </div>
      </td>
      <td><div class="preview-observacion">${observacion}</div></td>
    </tr>
  `;
}

/*********************************
 * INICIALIZACIÓN
 *********************************/
window.addEventListener('load', async () => {
  eliminarBotonActualizarPanel();
  let accesoPermitido = false;
  try {
    accesoPermitido = await solicitarAccesoAdmin();
    if (!accesoPermitido) {
      window.location.replace('../pages/index.html');
      return;
    }
    await ejecutarCargaTotal();
    actualizarDashboardInicio();
  } catch (err) {
    console.error('Error inicializando panel:', err);
  }
  inicializarEventListeners();
  mostrarSeccion('inicio');
  if (accesoPermitido) {
    inicializarActualizacionesEnTiempoReal();
  }
});

async function cargarTodo() {
  await Promise.all([
    cargarDocentes(),
    cargarCursos(),
    cargarPeriodos(),
    cargarHorarios(),
    cargarBloqueados(),
    cargarActivaciones(),
  ]);
  // Cargar asistencias sólo si la sección existe en el DOM
  if (document.getElementById('asistencia')) {
    await cargarAsistencias();
  }
}

async function ejecutarCargaTotal() {
  if (!promesaCargaGlobal) {
    promesaCargaGlobal = (async () => {
      await cargarTodo();
    })().finally(() => {
      promesaCargaGlobal = null;
      if (refreshPendiente && !document.hidden) {
        refreshPendiente = false;
        programarRefrescoAutomatico(true);
      }
    });
  }
  return promesaCargaGlobal;
}

function inicializarActualizacionesEnTiempoReal() {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    console.warn('El navegador no soporta actualizaciones en tiempo real (SSE).');
    return;
  }

  if (adminEventSource) {
    return;
  }

  try {
    adminEventSource = new EventSource(ADMIN_STREAM_URL);
    adminEventSource.addEventListener('message', procesarActualizacionTiempoReal);
    adminEventSource.addEventListener('error', manejarErrorStreamTiempoReal);
    adminEventSource.addEventListener('open', () => {
      streamRetryDelay = STREAM_RETRY_BASE_MS;
      console.debug('[Realtime] Conexión SSE establecida');
    });
  } catch (err) {
    console.error('No se pudo iniciar la conexión en tiempo real:', err);
  }
}

function procesarActualizacionTiempoReal(event) {
  if (!event?.data) return;

  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch (err) {
    console.warn('[Realtime] Evento inválido recibido', err);
    return;
  }

  if (!payload || payload.type !== 'full-refresh') {
    return;
  }

  if (document.hidden || promesaCargaGlobal) {
    refreshPendiente = true;
    return;
  }

  programarRefrescoAutomatico(false);
}

function programarRefrescoAutomatico(force = false) {
  if (promesaCargaGlobal) {
    refreshPendiente = true;
    return;
  }

  if (autoRefreshTimer) {
    if (!force) {
      refreshPendiente = true;
      return;
    }
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  autoRefreshTimer = setTimeout(async () => {
    autoRefreshTimer = null;
    try {
      await ejecutarCargaTotal();
      actualizarDashboardInicio();
    } catch (err) {
      console.error('Error actualizando datos automáticamente:', err);
    } finally {
      if (refreshPendiente && !document.hidden) {
        refreshPendiente = false;
        programarRefrescoAutomatico(true);
      }
    }
  }, force ? 0 : STREAM_AUTO_REFRESH_DELAY_MS);
}

function manejarErrorStreamTiempoReal(event) {
  console.warn('[Realtime] Conexión interrumpida, reintentando...', event?.message || event);
  if (streamRetryTimer) {
    return;
  }
  cerrarStreamTiempoReal(false);
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = null;
    inicializarActualizacionesEnTiempoReal();
  }, streamRetryDelay);
  streamRetryDelay = Math.min(streamRetryDelay * 1.5, STREAM_RETRY_MAX_MS);
}

function cerrarStreamTiempoReal(resetDelay) {
  if (adminEventSource) {
    adminEventSource.removeEventListener('message', procesarActualizacionTiempoReal);
    adminEventSource.removeEventListener('error', manejarErrorStreamTiempoReal);
    adminEventSource.close();
    adminEventSource = null;
  }
  if (streamRetryTimer) {
    clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
  }
  if (resetDelay) {
    streamRetryDelay = STREAM_RETRY_BASE_MS;
  }
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function manejarVisibilidadPanel() {
  if (!document.hidden && refreshPendiente) {
    const ejecutarAhora = refreshPendiente;
    refreshPendiente = false;
    if (ejecutarAhora) {
      programarRefrescoAutomatico(true);
    }
  }
}

function inicializarEventListeners() {
  // Búsqueda de docentes
  const buscarDocente = document.getElementById('buscarDocente');
  if (buscarDocente) {
    buscarDocente.addEventListener('input', (e) => {
      filtroDocentes = e.target.value;
      resetearPaginacion('docentes');
      renderizarDocentes();
    });
  }

  // Búsqueda de cursos
  const buscarCurso = document.getElementById('buscarCurso');
  if (buscarCurso) {
    buscarCurso.addEventListener('input', (e) => {
      filtroCursos = e.target.value;
      resetearPaginacion('cursos');
      renderizarCursos();
    });
  }

  const buscarHorario = document.getElementById('buscarHorario');
  if (buscarHorario) {
    buscarHorario.addEventListener('input', (e) => {
      filtroHorarios = e.target.value;
      resetearPaginacion('horarios');
      renderizarHorarios();
    });
  }

  const buscarPeriodo = document.getElementById('buscarPeriodo');
  if (buscarPeriodo) {
    buscarPeriodo.addEventListener('input', (e) => {
      filtroPeriodos = e.target.value;
      resetearPaginacion('periodos');
      renderizarPeriodos();
    });
  }

  const buscarReporte = document.getElementById('buscarReporte');
  if (buscarReporte) {
    buscarReporte.addEventListener('input', (e) => {
      filtroReportes = e.target.value;
      resetearPaginacion('reportes');
      renderizarReportes();
    });
  }

  const buscarAsistencia = document.getElementById('buscarAsistencia');
  if (buscarAsistencia) {
    buscarAsistencia.addEventListener('input', (e) => {
      filtroAsistencias = e.target.value;
      resetearPaginacion('asistencias');
      renderizarAsistencias();
    });
  }

  // Botón limpiar historial
  const btnLimpiar = document.getElementById('btnLimpiar');
  if (btnLimpiar) {
    btnLimpiar.addEventListener('click', limpiarHistorial);
  }

  // Botones "Nuevo" - usar querySelectorAll para obtener todos
  const btnNuevoDocente = document.querySelector('#docentes .btn-nuevo');
  const btnNuevoCurso = document.querySelector('#cursos .btn-nuevo');
  const btnNuevoHorario = document.querySelector('#horarios .btn-nuevo');
  const btnNuevoPeriodo = document.querySelector('#periodos .btn-nuevo');
  const btnRefrescarTodo = document.getElementById('btnRefrescarTodo');

  if (btnNuevoDocente) {
    btnNuevoDocente.addEventListener('click', nuevoDocente);
  }
  if (btnNuevoCurso) {
    btnNuevoCurso.addEventListener('click', nuevoCurso);
  }
  if (btnNuevoHorario) {
    btnNuevoHorario.addEventListener('click', nuevoHorario);
  }
  if (btnNuevoPeriodo) {
    btnNuevoPeriodo.addEventListener('click', nuevoPeriodo);
  }
  if (btnRefrescarTodo) {
    btnRefrescarTodo.addEventListener('click', refrescarTodo);
  }

  const btnNuevaAsistencia = document.getElementById('btnNuevaAsistencia');
  if (btnNuevaAsistencia) {
    btnNuevaAsistencia.addEventListener('click', () => abrirModalAsistencia());
  }

  const tablaAsistencias = document.querySelector('#tablaAsistencias tbody');
  if (tablaAsistencias) {
    tablaAsistencias.addEventListener('click', manejarAccionAsistencia);
  }

  const btnToggleDocentes = document.getElementById('toggleDocentes');
  if (btnToggleDocentes) {
    actualizarToggleEstado(btnToggleDocentes, vistaCompleta.docentes);
    btnToggleDocentes.addEventListener('click', async () => {
      vistaCompleta.docentes = !vistaCompleta.docentes;
      actualizarToggleEstado(btnToggleDocentes, vistaCompleta.docentes);
      await cargarDocentes();
    });
  }

  const btnToggleCursos = document.getElementById('toggleCursos');
  if (btnToggleCursos) {
    actualizarToggleEstado(btnToggleCursos, vistaCompleta.cursos);
    btnToggleCursos.addEventListener('click', async () => {
      vistaCompleta.cursos = !vistaCompleta.cursos;
      actualizarToggleEstado(btnToggleCursos, vistaCompleta.cursos);
      await cargarCursos();
    });
  }

  const btnTogglePeriodos = document.getElementById('togglePeriodos');
  if (btnTogglePeriodos) {
    actualizarToggleEstado(btnTogglePeriodos, vistaCompleta.periodos);
    btnTogglePeriodos.addEventListener('click', async () => {
      vistaCompleta.periodos = !vistaCompleta.periodos;
      actualizarToggleEstado(btnTogglePeriodos, vistaCompleta.periodos);
      await cargarPeriodos();
    });
  }

  const btnToggleHorarios = document.getElementById('toggleHorarios');
  if (btnToggleHorarios) {
    actualizarToggleEstado(btnToggleHorarios, vistaCompleta.horarios);
    btnToggleHorarios.addEventListener('click', async () => {
      vistaCompleta.horarios = !vistaCompleta.horarios;
      actualizarToggleEstado(btnToggleHorarios, vistaCompleta.horarios);
      await cargarHorarios();
    });
  }

  const btnToggleReportes = document.getElementById('toggleReportes');
  if (btnToggleReportes) {
    actualizarToggleEstado(btnToggleReportes, vistaCompleta.reportes);
    btnToggleReportes.addEventListener('click', async () => {
      vistaCompleta.reportes = !vistaCompleta.reportes;
      actualizarToggleEstado(btnToggleReportes, vistaCompleta.reportes);
      await cargarDocentes();
    });
  }

  const btnToggleAsistencias = document.getElementById('toggleAsistencias');
  if (btnToggleAsistencias) {
    actualizarToggleEstado(btnToggleAsistencias, vistaCompleta.asistencias);
    btnToggleAsistencias.addEventListener('click', async () => {
      vistaCompleta.asistencias = !vistaCompleta.asistencias;
      actualizarToggleEstado(btnToggleAsistencias, vistaCompleta.asistencias);
      await cargarAsistencias();
    });
  }
}

/*********************************
 * DOCENTES
 *********************************/
async function cargarDocentes() {
  try {
  const necesitaInactivos = vistaCompleta.docentes || vistaCompleta.reportes;
  const query = necesitaInactivos ? '?incluirInactivos=1' : '';
  const res = await fetch(`${BASE_URL}/api/docentes${query}`);
    docentes = await res.json();
    renderizarDocentes();
    renderizarReportes();
  } catch (err) {
    console.error('Error cargando docentes:', err);
    Swal.fire('Error', 'No se pudieron cargar los docentes', 'error');
  }
}

function renderizarDocentes() {
  const tbody = document.querySelector('#tablaDocentes tbody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  const base = vistaCompleta.docentes ? docentes : docentes.filter((doc) => Number(doc.activacion) !== 0);
  const filtro = normalizarTexto(filtroDocentes);
  const lista = filtro
    ? base.filter((doc) => {
        const nombre = normalizarTexto(doc.nombre);
        const dni = normalizarTexto(doc.dni);
        return nombre.includes(filtro) || dni.includes(filtro);
      })
    : base;

  if (!lista.length) {
    const mensaje = base.length === 0
      ? 'No hay docentes activos en esta vista'
      : 'Sin coincidencias según la búsqueda.';
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#888;">${mensaje}</td></tr>`;
    renderizarControlesPaginacion('docentes', obtenerMetaPaginacionVacia('docentes'));
    return;
  }

  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0;
    const bActivo = Number(b.activacion) !== 0;
    if (aActivo === bActivo) {
      return (a.nombre || '').localeCompare(b.nombre || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'docentes');
  tbody.innerHTML = items.map((doc) => {
    const extraClase = Number(doc.activacion) === 0 ? 'class="is-inactive"' : '';
    return `
      <tr ${extraClase}>
        <td>${doc.nombre}</td>
        <td>${doc.dni}</td>
        <td>
          <div class="btn-actions">
            <button class="btn-small btn-edit" onclick="editarDocente('${doc.dni}', '${doc.nombre.replace(/'/g, "\\'")}', ${Number(doc.activacion)})">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="btn-small btn-delete" onclick="eliminarDocente('${doc.dni}', '${doc.nombre.replace(/'/g, "\\'")}')">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderizarControlesPaginacion('docentes', meta);
  actualizarDashboardInicio();
}

async function nuevoDocente() {
  const { value: formValues } = await Swal.fire({
    title: 'Nuevo Docente',
    html: `
      <div class="form-container">
        <div class="form-grid">

          <div class="form-field form-col-2">
            <label for="swal-dni">DNI *</label>
            <div class="input-icon">
              <i class="fa-solid fa-id-card"></i>
              <input id="swal-dni" placeholder="Ej: 12345678" maxlength="8">
            </div>
            <div class="form-help">Debe tener exactamente 8 dígitos.</div>
          </div>

          <div class="form-field form-col-2">
            <label for="swal-nombre">Nombre Completo *</label>
            <div class="input-icon">
              <i class="fa-solid fa-user"></i>
              <input id="swal-nombre" placeholder="Ej: Juan Pérez García">
            </div>
            <div class="form-help">Escribe el nombre completo del docente.</div>
          </div>

        </div>
      </div>
    `,

    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: 'Crear',
    cancelButtonText: 'Cancelar',
    width: '560px',
    customClass: { popup: 'modal-slim modal-docente' },
    preConfirm: () => {
      const dni = document.getElementById('swal-dni').value.trim();
      const nombre = document.getElementById('swal-nombre').value.trim();
      
      if (!dni || !nombre) {
        Swal.showValidationMessage('Todos los campos son obligatorios');
        return false;
      }
      
      if (dni.length !== 8 || !/^\d+$/.test(dni)) {
        Swal.showValidationMessage('El DNI debe tener 8 dígitos');
        return false;
      }
      
      return { dni, nombre };
    }
  });

  if (formValues) {
  try {
    const res = await fetch(`${BASE_URL}/api/admin/docentes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValues)
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Éxito!', 'Docente creado correctamente', 'success');
        await cargarDocentes();
      } else {
        throw new Error(data.error || 'Error al crear docente');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo crear el docente', 'error');
    }
  }
}

async function editarDocente(dni, nombreActual, estadoActual = 1) {
  const { value: formValues } = await Swal.fire({
    title: 'Editar Docente',
    html: `
      <div class="form-container">
        <div class="form-grid">
          <div class="form-field form-col-2">
            <label for="swal-docente-nombre">Nombre completo *</label>
            <div class="input-icon">
              <i class="fa-solid fa-user"></i>
              <input id="swal-docente-nombre" value="${sanitizeHtml(nombreActual)}" placeholder="Nombre completo del docente">
            </div>
          </div>
          <div class="form-field">
            <label class="toggle-label">Estado</label>
            <div class="toggle-row">
              <input type="checkbox" id="swal-docente-activo" ${Number(estadoActual) !== 0 ? 'checked' : ''}>
              <label for="swal-docente-activo" class="toggle-caption">${Number(estadoActual) !== 0 ? 'Activo' : 'Inactivo'}</label>
            </div>
          </div>
        </div>
      </div>
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: 'Guardar cambios',
    cancelButtonText: 'Cancelar',
    didOpen: () => {
      sincronizarToggleModal('swal-docente-activo');
    },
    preConfirm: () => {
      const nombre = (document.getElementById('swal-docente-nombre')?.value || '').trim();
      const activo = obtenerValorToggle('swal-docente-activo');
      if (!nombre) {
        Swal.showValidationMessage('El nombre del docente no puede estar vacío');
        return false;
      }
      return { nombre, activacion: activo };
    }
  });

  if (!formValues) return;

  try {
    const res = await fetch(`${BASE_URL}/api/admin/docentes/${dni}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formValues)
    });

    const data = await res.json();

    if (res.ok) {
      Swal.fire('¡Éxito!', 'Docente actualizado correctamente', 'success');
      await cargarDocentes();
    } else {
      throw new Error(data.error || 'Error al actualizar docente');
    }
  } catch (err) {
    console.error('Error:', err);
    Swal.fire('Error', err.message || 'No se pudo actualizar el docente', 'error');
  }
}

async function eliminarDocente(dni, nombre) {
  const confirm = await Swal.fire({
    title: '¿Estás seguro?',
    html: `Se eliminará el docente <strong>${nombre}</strong> (${dni})<br><br>Esta acción no se puede deshacer`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#d33',
    confirmButtonText: 'Sí, eliminar',
    cancelButtonText: 'Cancelar'
  });

  if (confirm.isConfirmed) {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/docentes/${dni}`, {
        method: 'DELETE'
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Eliminado!', 'Docente eliminado correctamente', 'success');
        await cargarDocentes();
      } else {
        throw new Error(data.error || 'Error al eliminar');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo eliminar el docente', 'error');
    }
  }
}

/*********************************
 * CURSOS
 *********************************/
async function cargarCursos() {
  try {
  const query = vistaCompleta.cursos ? '?incluirInactivos=1' : '';
  const res = await fetch(`${BASE_URL}/api/cursos${query}`);
    cursos = await res.json();
    renderizarCursos();
  } catch (err) {
    console.error('Error cargando cursos:', err);
    Swal.fire('Error', 'No se pudieron cargar los cursos', 'error');
  }
}

/*********************************
 * PERIODOS
 *********************************/
async function cargarPeriodos() {
  try {
    const query = vistaCompleta.periodos ? '?incluirInactivos=1' : '';
    const res = await fetch(`${BASE_URL}/api/periodos${query}`);
    periodos = await res.json();
    renderizarPeriodos();
  } catch (err) {
    console.error('Error cargando periodos:', err);
    Swal.fire('Error', 'No se pudieron cargar los periodos', 'error');
  }
}

function renderizarPeriodos() {
  const tbody = document.querySelector('#tablaPeriodos tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const base = vistaCompleta.periodos ? periodos : periodos.filter((p) => Number(p.activacion) !== 0);

  if (base.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#888;">No hay periodos activos en esta vista</td></tr>';
    renderizarControlesPaginacion('periodos', obtenerMetaPaginacionVacia('periodos'));
    return;
  }

  const filtro = normalizarTexto(filtroPeriodos);
  const lista = filtro
    ? base.filter((p) => {
        const fechaInicioIso = formatearFechaSimple(p.fecha_inicio);
        const fechaFinIso = formatearFechaSimple(p.fecha_fin);
        const fechaInicioLatam = convertirIsoALatam(fechaInicioIso);
        const fechaFinLatam = convertirIsoALatam(fechaFinIso);
        const candidatos = [
          normalizarTexto(p.nombre),
          normalizarTexto(fechaInicioIso),
          normalizarTexto(fechaFinIso),
          normalizarTexto(fechaInicioLatam),
          normalizarTexto(fechaFinLatam)
        ];
        return candidatos.some((valor) => valor.includes(filtro));
      })
    : base;

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#888;">Sin coincidencias según la búsqueda.</td></tr>';
    renderizarControlesPaginacion('periodos', obtenerMetaPaginacionVacia('periodos'));
    return;
  }

  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0;
    const bActivo = Number(b.activacion) !== 0;
    if (aActivo === bActivo) {
      return (a.fecha_inicio || '').localeCompare(b.fecha_inicio || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'periodos');
  tbody.innerHTML = items.map((p) => {
    const fechaInicioSimple = formatearFechaSimple(p.fecha_inicio);
    const fechaFinSimple = formatearFechaSimple(p.fecha_fin);
    const fechaInicioLabel = convertirIsoALatam(fechaInicioSimple);
    const fechaFinLabel = convertirIsoALatam(fechaFinSimple);
    const extraClase = Number(p.activacion) === 0 ? 'class="is-inactive"' : '';
    return `
      <tr ${extraClase}>
        <td>${p.nombre}</td>
        <td>${fechaInicioLabel}</td>
        <td>${fechaFinLabel}</td>
        <td>
          <div class="btn-actions">
            <button class="btn-small btn-edit" onclick="editarPeriodo(${p.id_periodo}, '${p.nombre.replace(/'/g, "\\'")}', '${fechaInicioSimple}', '${fechaFinSimple}', ${Number(p.activacion)})">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="btn-small btn-delete" onclick="eliminarPeriodo(${p.id_periodo}, '${p.nombre.replace(/'/g, "\\'")}')">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderizarControlesPaginacion('periodos', meta);
  actualizarDashboardInicio();
}

function formatearFechaSimple(valor) {
  if (!valor) return '';
  const str = valor.toString();
  if (str.includes('T')) {
    return str.split('T')[0];
  }
  return str;
}

async function nuevoPeriodo() {
  const { value: formValues } = await Swal.fire({
    title: 'Nuevo Periodo',
    width: '500px',
    customClass: { popup: 'modal-slim' },
    showCancelButton: true,
    confirmButtonText: 'Crear',
    cancelButtonText: 'Cancelar',
    html: `
      <div class="form-container modal-periodo">
        <div class="form-grid form-grid-periodo">
          <div class="form-field form-col-2">
            <label>Nombre *</label>
            <input id="swal-periodo-nombre" placeholder="Ej: 2025-I">
          </div>
          <div class="form-field form-half">
            <label>Fecha inicio *</label>
            <input id="swal-periodo-inicio" type="date">
          </div>
          <div class="form-field form-half">
            <label>Fecha fin *</label>
            <input id="swal-periodo-fin" type="date">
          </div>
        </div>
      </div>
    `,
    preConfirm: () => {
      const nombre = document.getElementById('swal-periodo-nombre').value.trim();
      const fecha_inicio = document.getElementById('swal-periodo-inicio').value;
      const fecha_fin = document.getElementById('swal-periodo-fin').value;

      if (!nombre || !fecha_inicio || !fecha_fin) {
        Swal.showValidationMessage('Todos los campos son obligatorios');
        return false;
      }

      if (fecha_inicio > fecha_fin) {
        Swal.showValidationMessage('La fecha fin debe ser mayor o igual a la fecha inicio');
        return false;
      }

      return { nombre, fecha_inicio, fecha_fin };
    },
  });

  if (!formValues) return;

  try {
    const res = await fetch(`${BASE_URL}/api/admin/periodos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formValues),
    });

    const data = await res.json();

    if (res.ok) {
      Swal.fire('¡Éxito!', 'Periodo creado correctamente', 'success');
      await cargarPeriodos();
    } else {
      throw new Error(data.error || 'Error al crear periodo');
    }
  } catch (err) {
    console.error('Error:', err);
    Swal.fire('Error', err.message || 'No se pudo crear el periodo', 'error');
  }
}

async function editarPeriodo(id, nombreActual, fechaInicioActual, fechaFinActual, estadoActual = 1) {
  const { value: formValues } = await Swal.fire({
    title: 'Editar Periodo',
    width: '500px',
    customClass: { popup: 'modal-slim' },
    showCancelButton: true,
    confirmButtonText: 'Actualizar',
    cancelButtonText: 'Cancelar',
    html: `
      <div class="form-container modal-periodo">
        <div class="form-grid form-grid-periodo">
          <div class="form-field form-col-2">
            <label>Nombre *</label>
            <input id="swal-periodo-nombre" value="${sanitizeHtml(nombreActual)}">
          </div>
          <div class="form-field form-half">
            <label>Fecha inicio *</label>
            <input id="swal-periodo-inicio" type="date" value="${fechaInicioActual}">
          </div>
          <div class="form-field form-half">
            <label>Fecha fin *</label>
            <input id="swal-periodo-fin" type="date" value="${fechaFinActual}">
          </div>
          <div class="form-field form-col-2">
            <label class="toggle-label">Estado</label>
            <div class="toggle-row">
              <input type="checkbox" id="swal-periodo-activo" ${Number(estadoActual) !== 0 ? 'checked' : ''}>
              <label for="swal-periodo-activo" class="toggle-caption">${Number(estadoActual) !== 0 ? 'Activo' : 'Inactivo'}</label>
            </div>
          </div>
        </div>
      </div>
    `,
    didOpen: () => {
      sincronizarToggleModal('swal-periodo-activo');
    },
    preConfirm: () => {
      const nombre = document.getElementById('swal-periodo-nombre').value.trim();
      const fecha_inicio = document.getElementById('swal-periodo-inicio').value;
      const fecha_fin = document.getElementById('swal-periodo-fin').value;
      const activacion = obtenerValorToggle('swal-periodo-activo');

      if (!nombre || !fecha_inicio || !fecha_fin) {
        Swal.showValidationMessage('Todos los campos son obligatorios');
        return false;
      }

      if (fecha_inicio > fecha_fin) {
        Swal.showValidationMessage('La fecha fin debe ser mayor o igual a la fecha inicio');
        return false;
      }

      return { nombre, fecha_inicio, fecha_fin, activacion };
    },
  });

  if (!formValues) return;

  try {
    const res = await fetch(`${BASE_URL}/api/admin/periodos/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formValues),
    });

    const data = await res.json();

    if (res.ok) {
      Swal.fire('¡Éxito!', 'Periodo actualizado correctamente', 'success');
      await cargarPeriodos();
    } else {
      throw new Error(data.error || 'Error al actualizar periodo');
    }
  } catch (err) {
    console.error('Error:', err);
    Swal.fire('Error', err.message || 'No se pudo actualizar el periodo', 'error');
  }
}

async function eliminarPeriodo(id, nombre) {
  const confirm = await Swal.fire({
    title: '¿Estás seguro?',
    html: `Se eliminará el periodo <strong>${nombre}</strong><br><br>Esta acción no se puede deshacer`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#d33',
    confirmButtonText: 'Sí, eliminar',
    cancelButtonText: 'Cancelar',
  });

  if (!confirm.isConfirmed) return;

  try {
    const res = await fetch(`${BASE_URL}/api/admin/periodos/${id}`, {
      method: 'DELETE',
    });

    const data = await res.json();

    if (res.ok) {
      Swal.fire('¡Eliminado!', 'Periodo eliminado correctamente', 'success');
      await cargarPeriodos();
    } else {
      throw new Error(data.error || 'Error al eliminar periodo');
    }
  } catch (err) {
    console.error('Error:', err);
    Swal.fire('Error', err.message || 'No se pudo eliminar el periodo', 'error');
  }
}

function renderizarCursos() {
  const tbody = document.querySelector('#tablaCursos tbody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  const base = vistaCompleta.cursos ? cursos : cursos.filter((curso) => Number(curso.activacion) !== 0);

  const filtro = normalizarTexto(filtroCursos);
  const lista = filtro
    ? base.filter((curso) => normalizarTexto(curso.nombre).includes(filtro))
    : base;

  if (!lista.length) {
    const mensaje = base.length === 0
      ? 'No hay cursos activos en esta vista'
      : 'Sin coincidencias según la búsqueda.';
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center; color:#888;">${mensaje}</td></tr>`;
    renderizarControlesPaginacion('cursos', obtenerMetaPaginacionVacia('cursos'));
    return;
  }
  
  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0;
    const bActivo = Number(b.activacion) !== 0;
    if (aActivo === bActivo) {
      return (a.nombre || '').localeCompare(b.nombre || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'cursos');
  tbody.innerHTML = items.map((curso) => {
    const extraClase = Number(curso.activacion) === 0 ? 'class="is-inactive"' : '';
    return `
      <tr ${extraClase}>
        <td>${curso.nombre}</td>
        <td>
          <div class="btn-actions">
            <button class="btn-small btn-edit" onclick="editarCurso(${curso.id_curso}, '${curso.nombre.replace(/'/g, "\\'")}', ${Number(curso.activacion)})">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="btn-small btn-delete" onclick="eliminarCurso(${curso.id_curso}, '${curso.nombre.replace(/'/g, "\\'")}")">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderizarControlesPaginacion('cursos', meta);
  actualizarDashboardInicio();
}

async function nuevoCurso() {
  const { value: nombre } = await Swal.fire({
    title: 'Nuevo Curso',
    input: 'text',
    inputPlaceholder: 'Nombre del curso',
    showCancelButton: true,
    confirmButtonText: 'Crear',
    cancelButtonText: 'Cancelar',
    inputValidator: (value) => {
      if (!value || !value.trim()) {
        return 'El nombre del curso no puede estar vacío';
      }
    }
  });

  if (nombre && nombre.trim() !== '') {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/cursos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: nombre.trim() })
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Éxito!', 'Curso creado correctamente', 'success');
        await cargarCursos();
      } else {
        throw new Error(data.error || 'Error al crear curso');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo crear el curso', 'error');
    }
  }
}

async function editarCurso(id, nombreActual, estadoActual = 1) {
  const { value: formValues } = await Swal.fire({
    title: 'Editar Curso',
    html: `
      <div class="form-container">
        <div class="form-grid">
          <div class="form-field form-col-2">
            <label for="swal-curso-nombre">Nombre del curso *</label>
            <div class="input-icon">
              <i class="fa-solid fa-book"></i>
              <input id="swal-curso-nombre" value="${sanitizeHtml(nombreActual)}" placeholder="Nombre del curso">
            </div>
          </div>
          <div class="form-field">
            <label class="toggle-label">Estado</label>
            <div class="toggle-row">
              <input type="checkbox" id="swal-curso-activo" ${Number(estadoActual) !== 0 ? 'checked' : ''}>
              <label for="swal-curso-activo" class="toggle-caption">${Number(estadoActual) !== 0 ? 'Activo' : 'Inactivo'}</label>
            </div>
          </div>
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Guardar cambios',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    didOpen: () => {
      sincronizarToggleModal('swal-curso-activo');
    },
    preConfirm: () => {
      const nombre = (document.getElementById('swal-curso-nombre')?.value || '').trim();
      const activacion = obtenerValorToggle('swal-curso-activo');
      if (!nombre) {
        Swal.showValidationMessage('El nombre del curso no puede estar vacío');
        return false;
      }
      return { nombre, activacion };
    }
  });

  if (!formValues) return;

  try {
    const res = await fetch(`${BASE_URL}/api/admin/cursos/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formValues)
    });

    const data = await res.json();

    if (res.ok) {
      Swal.fire('¡Éxito!', 'Curso actualizado correctamente', 'success');
      await cargarCursos();
    } else {
      throw new Error(data.error || 'Error al actualizar');
    }
  } catch (err) {
    console.error('Error:', err);
    Swal.fire('Error', err.message || 'No se pudo actualizar el curso', 'error');
  }
}

async function eliminarCurso(id, nombre) {
  const confirm = await Swal.fire({
    title: '¿Estás seguro?',
    html: `Se eliminará el curso <strong>${nombre}</strong><br><br>Esta acción no se puede deshacer`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#d33',
    confirmButtonText: 'Sí, eliminar',
    cancelButtonText: 'Cancelar'
  });

  if (confirm.isConfirmed) {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/cursos/${id}`, {
        method: 'DELETE'
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Eliminado!', 'Curso eliminado correctamente', 'success');
        await cargarCursos();
      } else {
        throw new Error(data.error || 'Error al eliminar');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo eliminar el curso', 'error');
    }
  }
}

/*********************************
 * HORARIOS
 *********************************/
async function cargarHorarios() {
  try {
  const query = vistaCompleta.horarios ? '?incluirInactivos=1' : '';
  const res = await fetch(`${BASE_URL}/api/admin/horarios-completos${query}`);
    horarios = await res.json();
    renderizarHorarios();
  } catch (err) {
    console.error('Error cargando horarios:', err);
    Swal.fire('Error', 'No se pudieron cargar los horarios', 'error');
  }
}

function renderizarHorarios() {
  const tbody = document.querySelector('#tablaHorarios tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const base = vistaCompleta.horarios
    ? horarios
    : horarios.filter((h) => Number(h.activacion) !== 0 && Number(h.activacion_docente) !== 0 && Number(h.activacion_curso) !== 0);

  if (base.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#888;">No hay horarios activos en esta vista</td></tr>';
    renderizarControlesPaginacion('horarios', obtenerMetaPaginacionVacia('horarios'));
    return;
  }

  const filtro = normalizarTexto(filtroHorarios);
  const lista = filtro
    ? base.filter((h) => {
        const docenteTxt = normalizarTexto(h.docente);
        const cursoTxt = normalizarTexto(h.curso);
        const diaTxt = normalizarTexto(h.dia);
        return docenteTxt.includes(filtro) || cursoTxt.includes(filtro) || diaTxt.includes(filtro);
      })
    : base;

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#888;">Sin coincidencias para la búsqueda.</td></tr>';
    renderizarControlesPaginacion('horarios', obtenerMetaPaginacionVacia('horarios'));
    return;
  }

  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0 && Number(a.activacion_docente) !== 0 && Number(a.activacion_curso) !== 0;
    const bActivo = Number(b.activacion) !== 0 && Number(b.activacion_docente) !== 0 && Number(b.activacion_curso) !== 0;
    if (aActivo === bActivo) {
      const docenteCmp = (a.docente || '').localeCompare(b.docente || '');
      if (docenteCmp !== 0) return docenteCmp;
      if ((a.dia || '') !== (b.dia || '')) return (a.dia || '').localeCompare(b.dia || '');
      return (a.hora_inicio || '').localeCompare(b.hora_inicio || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'horarios');
  tbody.innerHTML = items.map((h) => {
    const registroInactivo = Number(h.activacion) === 0 || Number(h.activacion_docente) === 0 || Number(h.activacion_curso) === 0;
    const extraClase = registroInactivo ? 'class="is-inactive"' : '';
    return `
      <tr ${extraClase}>
        <td>${h.docente}</td>
        <td>
          <span>${h.curso}</span>
          ${h.es_recuperacion
            ? '<span class="badge-recuperacion" title="Clase de recuperación">RECUPERACIÓN</span>'
            : ''}
        </td>
        <td>${h.dia}</td>
        <td>${h.hora_inicio}</td>
        <td>${h.hora_fin}</td>
        <td>
          <div class="btn-actions">
            <button class="btn-small btn-edit" onclick="editarHorario(
              ${h.id_horario},
              ${h.id_docente},
              ${h.id_curso},
              '${h.dia}',
              '${h.hora_inicio.slice(0,5)}',
              '${h.hora_fin.slice(0,5)}',
              ${h.id_periodo || 0},
              ${h.es_recuperacion ? 1 : 0},
              ${Number(h.activacion)}
            )">
              <i class="fa-solid fa-pen"></i>
            </button>

            <button class="btn-small btn-delete" onclick="eliminarHorario(
              ${h.id_horario},
              '${h.docente.replace(/'/g, "\\'")}',
              '${h.curso.replace(/'/g, "\\'")}',
              '${h.dia}'
            )">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderizarControlesPaginacion('horarios', meta);
  actualizarDashboardInicio();
}


async function nuevoHorario() {
  if (docentes.length === 0) await cargarDocentes();
  if (cursos.length === 0) await cargarCursos();
  if (periodos.length === 0) await cargarPeriodos();

  const docentesOptions = docentes.map(d =>
    `<option value="${d.id_docente}">${d.nombre}</option>`
  ).join('');

  const cursosOptions = cursos.map(c =>
    `<option value="${c.id_curso}">${c.nombre}</option>`
  ).join('');

  const periodosLista = periodos.filter((p) => Number(p.activacion) !== 0);

  const periodosOptions = periodosLista.map(p => {
    const inicio = formatearFechaSimple(p.fecha_inicio);
    const fin = formatearFechaSimple(p.fecha_fin);
    const etiqueta = `${p.nombre} (${inicio} - ${fin})${Number(p.activacion) === 0 ? ' - INACTIVO' : ''}`;
    return `<option value="${p.id_periodo}">${etiqueta}</option>`;
  }).join('');

  const diasSemana = [
    { valor: 'Lunes', abreviatura: 'L' },
    { valor: 'Martes', abreviatura: 'M' },
    { valor: 'Miércoles', abreviatura: 'X' },
    { valor: 'Jueves', abreviatura: 'J' },
    { valor: 'Viernes', abreviatura: 'V' },
    { valor: 'Sábado', abreviatura: 'S' },
    { valor: 'Domingo', abreviatura: 'D' }
  ];

  const diasMarkup = diasSemana.map(dia => `
    <div class="day-choice">
      <input type="checkbox" class="day-option" id="dia-${dia.valor}" value="${dia.valor}">
      <label for="dia-${dia.valor}" class="btn-day" title="${dia.valor}">${dia.abreviatura}</label>
    </div>
  `).join('');

  const { value: formValues } = await Swal.fire({
    title: 'Nuevo Horario',
    width: '640px',
    customClass: { popup: 'modal-form' },
    showCancelButton: true,
    confirmButtonText: 'Crear',
    cancelButtonText: 'Cancelar',
    html: `
      <div class="form-container form-wide">
        <div class="form-grid form-grid-horario">

          <div class="form-field form-col-2">
            <label>Docente *</label>
            <select id="swal-docente">
              <option value="">Seleccionar docente</option>
              ${docentesOptions}
            </select>
          </div>

          <div class="form-field form-col-2">
            <label>Curso *</label>
            <select id="swal-curso">
              <option value="">Seleccionar curso</option>
              ${cursosOptions}
            </select>
          </div>

          <!-- SELECTOR DE DÍAS MÚLTIPLE MEJORADO -->
          <div class="form-field form-col-2">
            <label>Días (Selecciona uno o varios) *</label>
            <div id="swal-dias-container" class="days-container">
              ${diasMarkup}
            </div>
            <div class="form-help" style="text-align:center; margin-top:5px;">Haz clic para seleccionar</div>
          </div>

          <div class="form-field form-half">
            <label>Hora inicio *</label>
            <input id="swal-inicio" type="time">
            <div class="ampm-toggle-row">
              <button type="button" class="ampm-btn ampm-am" id="swal-inicio-am" onclick="setAMPM('swal-inicio','AM')">AM</button>
              <button type="button" class="ampm-btn ampm-pm" id="swal-inicio-pm" onclick="setAMPM('swal-inicio','PM')">PM</button>
            </div>
          </div>

          <div class="form-field form-half">
            <label>Hora fin *</label>
            <input id="swal-fin" type="time">
            <div class="ampm-toggle-row">
              <button type="button" class="ampm-btn ampm-am" id="swal-fin-am" onclick="setAMPM('swal-fin','AM')">AM</button>
              <button type="button" class="ampm-btn ampm-pm" id="swal-fin-pm" onclick="setAMPM('swal-fin','PM')">PM</button>
            </div>
          </div>

          <div class="form-field">
            <label>Periodo *</label>
            <select id="swal-periodo">
              <option value="">Seleccionar periodo</option>
              ${periodosOptions}
            </select>
          </div>

          <div class="form-field form-recuperacion-inline">
            <label>Recuperación</label>
            <div class="checkbox-recuperacion-wrapper">
              <input id="swal-es-recuperacion" type="checkbox">
            </div>
          </div>

        </div>
      </div>
    `,
    didOpen: () => {
      // Sincronizar botones AM/PM al cambiar hora manualmente
      ['swal-inicio', 'swal-fin'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => sincronizarBotonesAMPM(id));
        sincronizarBotonesAMPM(id);
      });
    },
    preConfirm: () => {
      const popup = Swal.getPopup();
      const id_docente = Number(popup.querySelector('#swal-docente').value);
      const id_curso = Number(popup.querySelector('#swal-curso').value);
      const hora_inicio = popup.querySelector('#swal-inicio').value;
      const hora_fin = popup.querySelector('#swal-fin').value;
      const id_periodo = Number(popup.querySelector('#swal-periodo').value);
      const es_recuperacion = popup.querySelector('#swal-es-recuperacion').checked;

      const selectedDays = Array.from(popup.querySelectorAll('.day-option:checked'))
        .map(input => input.value);

      if (!id_docente || isNaN(id_docente) ||
          !id_curso || isNaN(id_curso) ||
          selectedDays.length === 0 || // Validar selección múltiple
          !hora_inicio || !hora_fin ||
          !id_periodo || isNaN(id_periodo)) {
        Swal.showValidationMessage('Todos los campos son obligatorios (selecciona al menos un día)');
        return false;
      }

      if (hora_inicio >= hora_fin) {
        Swal.showValidationMessage('La hora fin debe ser mayor que la hora inicio');
        return false;
      }

      return {
        id_docente,
        id_curso,
        dias: selectedDays, // Array de días
        hora_inicio,
        hora_fin,
        id_periodo,
        es_recuperacion
      };
    }
  });

  if (!formValues) return;

  try {
    // Procesar cada día seleccionado
    const promesas = formValues.dias.map(dia => {
      return fetch(`${BASE_URL}/api/admin/horarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_docente: formValues.id_docente,
          id_curso: formValues.id_curso,
          dia: dia,
          hora_inicio: formValues.hora_inicio,
          hora_fin: formValues.hora_fin,
          id_periodo: formValues.id_periodo,
          es_recuperacion: formValues.es_recuperacion
        })
      });
    });

    const respuestas = await Promise.all(promesas);
    const algunFallo = respuestas.some(r => !r.ok);

    if (algunFallo) {
      throw new Error('Hubo un problema al crear algunos horarios');
    }

    Swal.fire('¡Éxito!', `Horarios creados para: ${formValues.dias.join(', ')}`, 'success');
    await cargarHorarios();

  } catch (err) {
    console.error(err);
    Swal.fire('Error', 'No se pudieron crear todos los horarios', 'error');
  }
}

async function editarHorario(
  id_horario,
  id_docente_actual,
  id_curso_actual,
  dia_actual,
  hora_inicio_actual,
  hora_fin_actual,
  id_periodo_actual,
  es_recuperacion_actual,
  estado_actual = 1
) {
  if (docentes.length === 0) await cargarDocentes();
  if (cursos.length === 0) await cargarCursos();
  if (periodos.length === 0) await cargarPeriodos();

  const docentesActivos = docentes.filter((d) => Number(d.activacion) !== 0);
  const docentesLista = [...docentesActivos];
  if (!docentesLista.some((d) => Number(d.id_docente) === Number(id_docente_actual))) {
    const docenteActual = docentes.find((d) => Number(d.id_docente) === Number(id_docente_actual));
    if (docenteActual) docentesLista.push(docenteActual);
  }

  const docentesOptions = docentesLista.map((d) => {
    const etiqueta = Number(d.activacion) === 0 ? `${d.nombre} (INACTIVO)` : d.nombre;
    return `<option value="${d.id_docente}">${etiqueta}</option>`;
  }).join('');

  const cursosActivos = cursos.filter((c) => Number(c.activacion) !== 0);
  const cursosLista = [...cursosActivos];
  if (!cursosLista.some((c) => Number(c.id_curso) === Number(id_curso_actual))) {
    const cursoActual = cursos.find((c) => Number(c.id_curso) === Number(id_curso_actual));
    if (cursoActual) cursosLista.push(cursoActual);
  }

  const cursosOptions = cursosLista.map((c) => {
    const etiqueta = Number(c.activacion) === 0 ? `${c.nombre} (INACTIVO)` : c.nombre;
    return `<option value="${c.id_curso}">${etiqueta}</option>`;
  }).join('');

  const periodosActivos = periodos.filter((p) => Number(p.activacion) !== 0);
  const periodosLista = [...periodosActivos];
  if (id_periodo_actual && !periodosLista.some((p) => Number(p.id_periodo) === Number(id_periodo_actual))) {
    const periodoActual = periodos.find((p) => Number(p.id_periodo) === Number(id_periodo_actual));
    if (periodoActual) periodosLista.push(periodoActual);
  }

  const periodosOptions = periodosLista.map(p => {
    const inicio = formatearFechaSimple(p.fecha_inicio);
    const fin = formatearFechaSimple(p.fecha_fin);
    const etiqueta = `${p.nombre} (${inicio} - ${fin})${Number(p.activacion) === 0 ? ' - INACTIVO' : ''}`;
    return `<option value="${p.id_periodo}">${etiqueta}</option>`;
    }).join('');

  const { value: formValues } = await Swal.fire({
    title: 'Editar Horario',
    width: '640px',
    customClass: { popup: 'modal-form' },
    showCancelButton: true,
    confirmButtonText: 'Actualizar',
    cancelButtonText: 'Cancelar',
    html: `
      <div class="form-container form-wide">
        <div class="form-grid form-grid-horario">
          <div class="form-field form-col-2">
            <label>Docente *</label>
            <select id="swal-docente">${docentesOptions}</select>
          </div>
          <div class="form-field form-col-2">
            <label>Curso *</label>
            <select id="swal-curso">${cursosOptions}</select>
          </div>
          <div class="form-field form-col-2">
            <label>Día *</label>
            <select id="swal-dia">
              ${['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']
                .map(d => `<option value="${d}">${d}</option>`).join('')}
            </select>
          </div>
          <div class="form-field form-half">
            <label>Hora inicio *</label>
            <input id="swal-inicio" type="time" value="${hora_inicio_actual}">
            <div class="ampm-toggle-row">
              <button type="button" class="ampm-btn ampm-am" id="swal-inicio-am" onclick="setAMPM('swal-inicio','AM')">AM</button>
              <button type="button" class="ampm-btn ampm-pm" id="swal-inicio-pm" onclick="setAMPM('swal-inicio','PM')">PM</button>
            </div>
          </div>
          <div class="form-field form-half">
            <label>Hora fin *</label>
            <input id="swal-fin" type="time" value="${hora_fin_actual}">
            <div class="ampm-toggle-row">
              <button type="button" class="ampm-btn ampm-am" id="swal-fin-am" onclick="setAMPM('swal-fin','AM')">AM</button>
              <button type="button" class="ampm-btn ampm-pm" id="swal-fin-pm" onclick="setAMPM('swal-fin','PM')">PM</button>
            </div>
          </div>

          <div class="form-field">
            <label>Periodo *</label>
            <select id="swal-periodo">
              <option value="">Seleccionar periodo</option>
              ${periodosOptions}
            </select>
          </div>

          <div class="form-field form-recuperacion-inline">
            <label>Recuperación</label>
            <div class="checkbox-recuperacion-wrapper">
              <input id="swal-es-recuperacion" type="checkbox">
            </div>
          </div>

          <div class="form-field form-col-2">
            <label class="toggle-label">Estado</label>
            <div class="toggle-row">
              <input type="checkbox" id="swal-horario-activo" ${Number(estado_actual) !== 0 ? 'checked' : ''}>
              <label for="swal-horario-activo" class="toggle-caption">${Number(estado_actual) !== 0 ? 'Activo' : 'Inactivo'}</label>
            </div>
          </div>
        </div>
      </div>
    `,
    didOpen: () => {
      document.getElementById('swal-docente').value = id_docente_actual;
      document.getElementById('swal-curso').value = id_curso_actual;
      document.getElementById('swal-dia').value = dia_actual;
      document.getElementById('swal-periodo').value = id_periodo_actual || '';
      document.getElementById('swal-es-recuperacion').checked = !!es_recuperacion_actual;
      sincronizarToggleModal('swal-horario-activo');
      // Inicializar botones AM/PM según la hora cargada
      ['swal-inicio', 'swal-fin'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => sincronizarBotonesAMPM(id));
        sincronizarBotonesAMPM(id);
      });
    },
    preConfirm: () => {
      const id_docente = Number(document.getElementById('swal-docente').value);
      const id_curso = Number(document.getElementById('swal-curso').value);
      const dia = document.getElementById('swal-dia').value;
      const hora_inicio = document.getElementById('swal-inicio').value;
      const hora_fin = document.getElementById('swal-fin').value;

      const id_periodo = Number(document.getElementById('swal-periodo').value);
      const es_recuperacion = document.getElementById('swal-es-recuperacion').checked;
      const activacion = obtenerValorToggle('swal-horario-activo');

      if (!id_docente || !id_curso || !dia || !hora_inicio || !hora_fin ||
          !id_periodo || isNaN(id_periodo)) {
        Swal.showValidationMessage('Todos los campos son obligatorios');
        return false;
      }

      if (hora_inicio >= hora_fin) {
        Swal.showValidationMessage('La hora fin debe ser mayor que la inicio');
        return false;
      }

      return { id_docente, id_curso, dia, hora_inicio, hora_fin, id_periodo, es_recuperacion, activacion };
    }
  });

  // Si el usuario confirma el formulario
  if (formValues) {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/horarios/${id_horario}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValues)
      });

      if (res.ok) {
        Swal.fire('¡Éxito!', 'Horario actualizado correctamente', 'success');
        await cargarHorarios();
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Error al actualizar');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message, 'error');
    }
  }
}



async function eliminarHorario(id, docente, curso, dia) {
  const confirm = await Swal.fire({
    title: '¿Estás seguro?',
    html: `Se eliminará el horario:<br><strong>${docente}</strong> - ${curso}<br>${dia}<br><br>Esta acción no se puede deshacer`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#d33',
    confirmButtonText: 'Sí, eliminar',
    cancelButtonText: 'Cancelar'
  });

  if (confirm.isConfirmed) {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/horarios/${id}`, {
        method: 'DELETE'
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Eliminado!', 'Horario eliminado correctamente', 'success');
        await cargarHorarios();
      } else {
        throw new Error(data.error || 'Error al eliminar');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo eliminar el horario', 'error');
    }
  }
}

/*********************************
 * BLOQUEADOS Y ACTIVACIONES
 *********************************/
async function cargarBloqueados() {
  try {
  const res = await fetch(`${BASE_URL}/api/bloqueados`);
    bloqueados = await res.json();
    renderizarBloqueados();
  } catch (err) {
    console.error('Error cargando bloqueados:', err);
  }
}

async function cargarActivaciones() {
  try {
  const res = await fetch(`${BASE_URL}/api/activaciones`);
    activaciones = await res.json();
    renderizarActivaciones();
  } catch (err) {
    console.error('Error cargando activaciones:', err);
  }
}

function renderizarBloqueados() {
  const lista = document.getElementById('listaBloqueados');
  if (!lista) return;

  if (bloqueados.length === 0) {
    lista.innerHTML = '<p style="text-align:center; color:#888; padding:20px;">No hay docentes bloqueados</p>';
    return;
  }

  lista.innerHTML = '';

  bloqueados.forEach(bloqueo => {
    const card = document.createElement('div');
    card.className = 'bloqueo-card';
    card.innerHTML = `
      <div class="bloqueo-header">
        <div>
          <strong>${bloqueo.nombre}</strong> 
          <span class="badge-tipo badge-${bloqueo.tipo}">${bloqueo.tipo === 'entrada' ? 'ENTRADA' : 'SALIDA'}</span>
        </div>
        <small style="color:#888">${bloqueo.dni}</small>
      </div>
      <div class="bloqueo-body">
        <p><strong>Motivo:</strong> ${bloqueo.motivo}</p>
        <small style="color:#888">Bloqueado: ${new Date(bloqueo.fecha_bloqueo).toLocaleString('es-PE')}</small>
      </div>
      <div class="bloqueo-actions">
        <button class="btn-activacion" onclick="crearActivacion('${bloqueo.dni}', '${bloqueo.nombre.replace(/'/g, "\\'")}', '${bloqueo.tipo}')">
          <i class="fa-solid fa-unlock"></i> Dar Permiso
        </button>
      </div>
    `;
    lista.appendChild(card);
  });
}

function renderizarActivaciones() {
  const contenedor = document.getElementById('listaActivaciones');
  if (!contenedor) return;

  if (!Array.isArray(activaciones) || activaciones.length === 0) {
    contenedor.innerHTML = '<p style="text-align:center; color:#888;">Aún no existen activaciones registradas.</p>';
    return;
  }

  const filas = activaciones.map((item) => {
    const usado = Boolean(item.usado);
    const clase = usado ? 'is-inactive' : '';
    const creado = formatearFechaHoraLocal(item.fecha_creacion);
    const usadoEn = item.fecha_uso ? formatearFechaHoraLocal(item.fecha_uso) : '--';
    const observaciones = sanitizeHtml(item.observaciones || 'Sin observaciones');
    const etiquetaTipo = item.tipo === 'salida' ? 'SALIDA' : 'ENTRADA';

    return `
      <tr class="${clase}">
        <td>${sanitizeHtml(item.nombre)}</td>
        <td>${sanitizeHtml(item.dni)}</td>
        <td>${etiquetaTipo}</td>
        <td>${creado || '--'}</td>
        <td>${usado ? usadoEn : '--'}</td>
        <td>${observaciones}</td>
      </tr>
    `;
  }).join('');

  contenedor.innerHTML = `
    <table class="tabla-activaciones">
      <thead>
        <tr>
          <th>Docente</th>
          <th>DNI</th>
          <th>Tipo</th>
          <th>Creación</th>
          <th>Uso</th>
          <th>Observaciones</th>
        </tr>
      </thead>
      <tbody>
        ${filas}
      </tbody>
    </table>
  `;
}

async function crearActivacion(dni, nombre, tipo) {
  const { value: observaciones } = await Swal.fire({
    title: 'Crear Activación Especial',
    html: `
    <div class="form-container">
      <div style="margin-bottom:10px;">
        <p style="margin:0;"><strong>Docente:</strong> ${nombre}</p>
        <p style="margin:0;"><strong>Tipo:</strong> ${tipo === 'entrada' ? 'Permiso de Entrada' : 'Permiso de Salida'}</p>
      </div>

      <div class="form-field">
        <label for="swal-obs">Observaciones</label>
        <textarea id="swal-obs" placeholder="Ej: Permiso aprobado por administración"></textarea>
        <div class="form-help">Opcional. Si lo dejas vacío se guardará un texto automático.</div>
      </div>
    </div>
  `,

    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: 'Crear Permiso',
    cancelButtonText: 'Cancelar',
    width: '400px',
    customClass: { popup: 'modal-slim' },
    preConfirm: () => {
      return document.getElementById('swal-obs').value;
    }
  });

  if (observaciones !== undefined) {
    try {
      const res = await fetch(`${BASE_URL}/api/crear-activacion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dni,
          nombre,
          tipo,
          observaciones: observaciones || 'Permiso aprobado por administración'
        })
      });

      const data = await res.json();

      if (res.ok) {
        // Recargar bloqueados para que desaparezca de la lista
        await cargarBloqueados();
        await cargarActivaciones();
        
        Swal.fire(
          '¡Permiso Creado!',
          `El docente ${nombre} puede ahora marcar ${tipo === 'entrada' ? 'entrada' : 'salida'}. El bloqueo ha sido eliminado.`,
          'success'
        );
      } else {
        throw new Error(data.error || 'Error creando activación');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo crear la activación', 'error');
    }
  }
}

/*********************************
 * REPORTES
 *********************************/
function renderizarReportes() {
  const tbody = document.querySelector('#tablaReportes tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const base = vistaCompleta.reportes ? docentes : docentes.filter((doc) => Number(doc.activacion) !== 0);

  if (base.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#888;">No hay docentes activos para reportes</td></tr>';
    renderizarControlesPaginacion('reportes', obtenerMetaPaginacionVacia('reportes'));
    return;
  }

  const filtro = normalizarTexto(filtroReportes);
  const lista = filtro
    ? base.filter((doc) => {
        const nombre = normalizarTexto(doc.nombre);
        const dni = normalizarTexto(doc.dni);
        return nombre.includes(filtro) || dni.includes(filtro);
      })
    : base;

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#888;">No se encontraron docentes para la búsqueda.</td></tr>';
    renderizarControlesPaginacion('reportes', obtenerMetaPaginacionVacia('reportes'));
    return;
  }

  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0;
    const bActivo = Number(b.activacion) !== 0;
    if (aActivo === bActivo) {
      return (a.nombre || '').localeCompare(b.nombre || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'reportes');
  tbody.innerHTML = items.map((doc) => {
    const extraClase = Number(doc.activacion) === 0 ? 'class="is-inactive"' : '';
    return `
      <tr ${extraClase}>
        <td>${doc.nombre}</td>
        <td>${doc.dni}</td>
        <td style="text-align:center;">
          <button class="btn-success btn-excel" onclick="mostrarPreviewReporte('${doc.dni}', '${doc.nombre.replace(/'/g, "\\'")}')">
            <i class="fa-solid fa-eye"></i> Vista previa
          </button>
        </td>
      </tr>
    `;
  }).join('');

  renderizarControlesPaginacion('reportes', meta);
}

function descargarReporteExcel(dni) {
  window.open(`${BASE_URL}/api/admin/reporte-excel/${dni}`, "_blank");
}

async function mostrarPreviewReporte(dni, nombreDocente) {
  Swal.fire({
    title: 'Generando vista previa...',
    allowOutsideClick: false,
    didOpen: () => {
      Swal.showLoading();
    }
  });

  try {
    const response = await fetch(`${BASE_URL}/api/admin/reporte-preview/${dni}`);
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      const mensaje = payload && payload.error ? payload.error : 'No se pudo obtener la vista previa.';
      throw new Error(mensaje);
    }

    Swal.close();

    const registros = Array.isArray(payload.registros) ? payload.registros : [];
    const totalMinutos = Number(payload.totalMinutosExcedentes || 0);
    const totalLabel = registros.length === 1 ? 'registro' : 'registros';
    const generado = formatearFechaHoraLocal(payload.generadoEn);

    const filas = registros.length
      ? registros.map(construirFilaPreview).join('')
      : '<tr><td colspan="6"><div class="preview-empty"><i class="fa-solid fa-circle-info"></i> Sin registros de asistencia disponibles.</div></td></tr>';

    const metaHtml = `
      <div class="preview-report-meta">
        <span class="meta-chip"><i class="fa-solid fa-id-card"></i>${sanitizeHtml(payload.docente?.dni || dni)}</span>
        <span class="meta-chip"><i class="fa-solid fa-database"></i>${registros.length} ${totalLabel}</span>
        <span class="meta-chip"><i class="fa-solid fa-clock"></i>Total min. excedentes: ${totalMinutos}</span>
        ${generado ? `<span class="meta-info"><i class="fa-regular fa-clock"></i>${sanitizeHtml(generado)}</span>` : ''}
      </div>
    `;

    Swal.fire({
      width: '1360px',
      html: `
        <div class="preview-report-body">
          <div class="preview-report-header">
            <div class="preview-report-heading">
              <h3><i class="fa-solid fa-file-circle-check"></i> Vista previa de ${sanitizeHtml(nombreDocente)}</h3>
              <span>Revisa los registros antes de descargar el archivo Excel.</span>
            </div>
            <div class="preview-report-actions">
              <button type="button" class="btn-preview-action btn-download" id="btnPreviewDownload">
                <i class="fa-solid fa-file-excel"></i> Descargar Excel
              </button>
              <button type="button" class="btn-preview-action btn-close" id="btnPreviewClose">
                <i class="fa-solid fa-xmark"></i> Cerrar
              </button>
            </div>
          </div>
          ${metaHtml}
          <div class="preview-report-container">
            <div class="preview-report-scroll">
              <table class="preview-report-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Curso</th>
                    <th>Entrada</th>
                    <th>Salida</th>
                    <th>Estado</th>
                    <th>Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  ${filas}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
      showConfirmButton: false,
      showCancelButton: false,
      focusConfirm: false,
      customClass: {
        popup: 'preview-report-modal'
      },
      didRender: () => {
        const btnDescargar = document.getElementById('btnPreviewDownload');
        const btnCerrar = document.getElementById('btnPreviewClose');
        if (btnDescargar) {
          btnDescargar.addEventListener('click', () => descargarReporteExcel(dni));
        }
        if (btnCerrar) {
          btnCerrar.addEventListener('click', () => Swal.close());
        }
      }
    });
  } catch (err) {
    Swal.close();
    console.error('Error vista previa Excel:', err);
    Swal.fire('Error', err.message || 'No se pudo generar la vista previa', 'error');
  }
}

/*********************************
 * ASISTENCIAS - PANEL ADMIN
 *********************************/
async function cargarAsistencias() {
  const tbody = document.querySelector('#tablaAsistencias tbody');
  if (!tbody) {
    return [];
  }

  try {
    const query = vistaCompleta.asistencias ? '?incluirInactivos=1' : '';
    const response = await fetch(`${BASE_URL}/api/admin/asistencias${query}`);
    const payload = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(payload)) {
      const mensaje = payload && payload.error ? payload.error : 'No se pudieron obtener las asistencias.';
      throw new Error(mensaje);
    }

    asistencias = payload;
    renderizarAsistencias();
    return asistencias;
  } catch (err) {
    console.error('Error cargando asistencias:', err);
    asistencias = [];
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#e11d48;">${sanitizeHtml(err.message || 'Error al cargar las asistencias')}</td></tr>`;
    actualizarMetricasAsistencias([]);
    actualizarDashboardInicio();
    throw err;
  }
}

function renderizarAsistencias() {
  const tbody = document.querySelector('#tablaAsistencias tbody');
  if (!tbody) return;
  const base = Array.isArray(asistencias)
    ? (vistaCompleta.asistencias
        ? asistencias
        : asistencias.filter((registro) =>
            Number(registro.activacion) !== 0 &&
            Number(registro.activacionDocente) !== 0 &&
            Number(registro.activacionCurso) !== 0))
    : [];

  // Ordenar por fecha (desc) y hora programada (desc) para asegurar consistencia
  let lista = [...base];
  const filtro = normalizarTexto(filtroAsistencias);

  if (filtro) {
    lista = lista.filter((registro) => {
      const docenteTxt = normalizarTexto(registro.docente);
      const dniTxt = normalizarTexto(registro.dni);
      const cursoTxt = normalizarTexto(registro.curso);
      const fechaIsoValor = toInputDateValue(registro.fecha);
      const fechaIso = normalizarTexto(fechaIsoValor);
      const fechaLatam = normalizarTexto(convertirIsoALatam(fechaIsoValor));
      const fechaBonita = normalizarTexto(formatearFechaBonita(registro.fecha));
      const candidatos = [docenteTxt, dniTxt, cursoTxt, fechaIso, fechaLatam, fechaBonita];
      return candidatos.some((valor) => valor && valor.includes(filtro));
    });
  }

  // Aplicar filtro de chip (tardanzas, recuperaciones, faltas)
  if (filtroChipAsistencias === 'tardanza') {
    lista = lista.filter((r) => esTardanzaVisible(r));
  } else if (filtroChipAsistencias === 'recuperacion') {
    lista = lista.filter((r) => r.esRecuperacion);
  } else if (filtroChipAsistencias === 'falta') {
    lista = lista.filter((r) => (r.estado || '').toUpperCase() === 'FALTA');
  } else if (filtroChipAsistencias === 'encurso') {
    lista = lista.filter((r) => esAsistenciaEnCurso(r));
  }

  lista.sort((a, b) => {
    const fa = a.fecha ? new Date(a.fecha).getTime() : 0;
    const fb = b.fecha ? new Date(b.fecha).getTime() : 0;
    if (fb !== fa) return fb - fa;
    const ta = a.horaEntradaProg || '';
    const tb = b.horaEntradaProg || '';
    if (tb !== ta) return tb.localeCompare(ta);
    return (a.docente || '').localeCompare(b.docente || '');
  });

  actualizarMetricasAsistencias(lista);

  if (!lista.length) {
    const mensaje = base.length === 0
      ? 'No hay asistencias activas en esta vista.'
      : 'No se encontraron asistencias que coincidan con la búsqueda.';
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#888;">${mensaje}</td></tr>`;
    renderizarControlesPaginacion('asistencias', obtenerMetaPaginacionVacia('asistencias'));
    actualizarDashboardInicio();
    return;
  }

  const ordenados = [...lista].sort((a, b) => {
    const aActivo = Number(a.activacion) !== 0 && Number(a.activacionDocente) !== 0 && Number(a.activacionCurso) !== 0;
    const bActivo = Number(b.activacion) !== 0 && Number(b.activacionDocente) !== 0 && Number(b.activacionCurso) !== 0;
    if (aActivo === bActivo) {
      const fechaA = a.fecha ? new Date(a.fecha).getTime() : 0;
      const fechaB = b.fecha ? new Date(b.fecha).getTime() : 0;
      if (fechaB !== fechaA) return fechaB - fechaA;
      const horaA = a.horaEntradaProg || '';
      const horaB = b.horaEntradaProg || '';
      if (horaB !== horaA) return horaB.localeCompare(horaA);
      return (a.docente || '').localeCompare(b.docente || '');
    }
    return aActivo ? -1 : 1;
  });

  const { items, meta } = paginarLista(ordenados, 'asistencias');

  const filas = items.map((registro) => {
    const estadoTexto = sanitizeHtml(registro.estado || 'N/D');
    const estadoUpper = estadoTexto.toUpperCase();
    let badgeClass = 'success';
    let badgeIcon = 'fa-circle-check';
    if (estadoUpper === 'FALTA') {
      badgeClass = 'danger';
      badgeIcon = 'fa-triangle-exclamation';
    } else if (estadoUpper === 'RECUPERADO') {
      badgeClass = 'info';
      badgeIcon = 'fa-arrows-rotate';
    }

    const extras = [];
    if (registro.esRecuperacion) {
      extras.push('<span class="preview-badge info"><i class="fa-solid fa-arrows-rotate"></i>Recuperación</span>');
    }
    if (registro.faltaRecuperada) {
      extras.push('<span class="preview-badge info"><i class="fa-solid fa-check-double"></i>Recuperado</span>');
    }
    if (registro.minutosNoTrabajados && Number(registro.minutosNoTrabajados) > 0) {
      extras.push(`<span class="preview-badge warning"><i class="fa-solid fa-clock"></i>${registro.minutosNoTrabajados} min</span>`);
    }

    const entradaProg = formatearHoraCorta(registro.horaEntradaProg);
    const entradaProgHtml = entradaProg !== '--:--' ? `<span class="time-chip" title="Hora programada"><i class="fa-regular fa-clock"></i>${entradaProg}</span>` : '';
    const salidaProg = formatearHoraCorta(registro.horaSalidaProg);
    const salidaProgHtml = salidaProg !== '--:--' ? `<span class="time-chip" title="Hora programada"><i class="fa-regular fa-clock"></i>${salidaProg}</span>` : '';

    const observacion = registro.observacion
      ? sanitizeHtml(registro.observacion).replace(/\n/g, '<br>')
      : 'Sin observaciones registradas.';

    const estadoBadge = `<div class="preview-state"><span class="preview-badge ${badgeClass}"><i class="fa-solid ${badgeIcon}"></i>${estadoTexto}</span>${extras.length ? `<div class="preview-state-extra">${extras.join('')}</div>` : ''}</div>`;

    const registroInactivo = Number(registro.activacion) === 0 || Number(registro.activacionDocente) === 0 || Number(registro.activacionCurso) === 0;

    return `
      <tr data-id="${registro.id}" class="${registroInactivo ? 'is-inactive' : ''}">
        <td>${formatearFechaBonita(registro.fecha)}</td>
        <td>
          <div class="asistencia-docente">
            <strong>${sanitizeHtml(registro.docente || 'Sin docente')}</strong>
            ${registro.dni ? `<span class="dni">${sanitizeHtml(registro.dni)}</span>` : ''}
          </div>
        </td>
        <td>${sanitizeHtml(registro.curso || 'Sin curso')}</td>
        <td>
          <div class="asistencia-time">
            <span class="time-primary">${formatearHoraCorta(registro.horaEntradaReal)}</span>
            ${entradaProgHtml}
          </div>
        </td>
        <td>
          <div class="asistencia-time">
            <span class="time-primary">${formatearHoraCorta(registro.horaSalidaReal)}</span>
            ${salidaProgHtml}
          </div>
        </td>
        <td>${estadoBadge}</td>
        <td><div class="preview-observacion">${observacion}</div></td>
        <td>
          <div class="acciones-tabla">
            <button class="btn-icon btn-edit" data-action="editar" data-id="${registro.id}" title="Editar asistencia"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon btn-delete" data-action="eliminar" data-id="${registro.id}" title="Eliminar (desactivar)"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = filas;
  renderizarControlesPaginacion('asistencias', meta);
  actualizarDashboardInicio();
}

function generarOpcionesDocentes(seleccionado) {
  const activos = docentes.filter((doc) => Number(doc.activacion) !== 0);
  const lista = [...activos];

  if (seleccionado) {
    const existe = lista.some((doc) => Number(doc.id_docente) === Number(seleccionado));
    if (!existe) {
      const actual = docentes.find((doc) => Number(doc.id_docente) === Number(seleccionado));
      if (actual) lista.push(actual);
    }
  }

  return lista.map((doc) => {
    const seleccionadoAttr = seleccionado && Number(seleccionado) === Number(doc.id_docente) ? 'selected' : '';
    const label = `${sanitizeHtml(doc.nombre)} (${sanitizeHtml(doc.dni)})${Number(doc.activacion) === 0 ? ' - INACTIVO' : ''}`;
    return `<option value="${doc.id_docente}" ${seleccionadoAttr}>${label}</option>`;
  }).join('');
}

function generarOpcionesCursos(seleccionado) {
  const activos = cursos.filter((curso) => Number(curso.activacion) !== 0);
  const lista = [...activos];

  if (seleccionado) {
    const existe = lista.some((curso) => Number(curso.id_curso) === Number(seleccionado));
    if (!existe) {
      const actual = cursos.find((curso) => Number(curso.id_curso) === Number(seleccionado));
      if (actual) lista.push(actual);
    }
  }

  return lista.map((curso) => {
    const seleccionadoAttr = seleccionado && Number(seleccionado) === Number(curso.id_curso) ? 'selected' : '';
    const label = `${sanitizeHtml(curso.nombre)}${Number(curso.activacion) === 0 ? ' - INACTIVO' : ''}`;
    return `<option value="${curso.id_curso}" ${seleccionadoAttr}>${label}</option>`;
  }).join('');
}

function manejarAccionAsistencia(event) {
  const boton = event.target.closest('button[data-action]');
  if (!boton) return;

  const id = Number(boton.dataset.id);
  if (!id) return;

  const accion = boton.dataset.action;
  const registro = asistencias.find(item => Number(item.id) === id);

  if (!registro) {
    Swal.fire('Atención', 'No se encontró el registro seleccionado.', 'warning');
    return;
  }

  if (accion === 'editar') {
    abrirModalAsistencia(registro);
  } else if (accion === 'eliminar') {
    // Eliminar en UI -> se simula desactivación en backend
    eliminarAsistencia(registro);
  }
}

async function refrescarTodo() {
  const btn = document.getElementById('btnRefrescarTodo');
  if (!btn || btn.disabled) return;

  const contenidoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Actualizando...';

  try {
    await ejecutarCargaTotal();
    actualizarDashboardInicio();
    Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'success',
      title: 'Toda la información fue actualizada',
      showConfirmButton: false,
      timer: 1800,
      timerProgressBar: true
    });
  } catch (err) {
    console.error('Error al refrescar todo:', err);
    Swal.fire('Error', err.message || 'No se pudieron actualizar los datos.', 'error');
  } finally {
    btn.innerHTML = contenidoOriginal;
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

function construirFormularioAsistencia(registro) {
  const fechaValor = toInputDateValue(registro?.fecha);
  const horaEntradaProg = toInputTimeValue(registro?.horaEntradaProg);
  const horaEntradaReal = toInputTimeValue(registro?.horaEntradaReal);
  const horaSalidaProg = toInputTimeValue(registro?.horaSalidaProg);
  const horaSalidaReal = toInputTimeValue(registro?.horaSalidaReal);
  const faltaRecuperada = registro?.faltaRecuperada;
  const estadoEsFalta = registro ? String(registro.estado || '').toUpperCase() === 'FALTA' : false;
  const faltaMarcada = !horaEntradaReal && !horaSalidaReal;
  const mostrarFaltaRecuperada = faltaMarcada || estadoEsFalta || faltaRecuperada;
  const recuperadaDisabledAttr = mostrarFaltaRecuperada ? '' : 'disabled';

  return `
    <div class="form-container form-wide">
      <div class="form-grid asist-form">
        <div class="form-field">
          <label for="asist-fecha">Fecha</label>
          <input id="asist-fecha" type="date" value="${fechaValor}" required>
        </div>
        <div class="form-field">
          <label for="asist-docente">Docente</label>
          <select id="asist-docente" required>
            <option value="" disabled ${registro ? '' : 'selected'}>Selecciona un docente</option>
            ${generarOpcionesDocentes(registro?.idDocente)}
          </select>
        </div>
        <div class="form-field form-col-2">
          <label for="asist-curso">Curso</label>
          <select id="asist-curso" required>
            <option value="" disabled ${registro ? '' : 'selected'}>Selecciona un curso</option>
            ${generarOpcionesCursos(registro?.idCurso)}
          </select>
        </div>
        <div class="form-field">
          <label for="asist-entrada-prog">Entrada programada</label>
          <input id="asist-entrada-prog" type="time" value="${horaEntradaProg}" required>
        </div>
        <div class="form-field">
          <label for="asist-entrada-real">Entrada registrada</label>
          <input id="asist-entrada-real" type="time" value="${horaEntradaReal}">
        </div>
        <div class="form-field">
          <label for="asist-salida-prog">Salida programada</label>
          <input id="asist-salida-prog" type="time" value="${horaSalidaProg}" required>
        </div>
        <div class="form-field">
          <label for="asist-salida-real">Salida registrada</label>
          <input id="asist-salida-real" type="time" value="${horaSalidaReal}">
        </div>
        <div class="form-field form-col-2">
          <div class="checkbox-card-grid">
            <label class="checkbox-card" for="asist-recuperacion">
              <input id="asist-recuperacion" type="checkbox" ${registro?.esRecuperacion ? 'checked' : ''}>
              <span class="checkbox-box" aria-hidden="true"></span>
              <span class="checkbox-text">Sesión de recuperación</span>
            </label>
            <label class="checkbox-card" for="asist-activa">
              <input id="asist-activa" type="checkbox" ${registro?.activacion === 0 ? '' : 'checked'}>
              <span class="checkbox-box" aria-hidden="true"></span>
              <span class="checkbox-text">Mostrar en reportes</span>
            </label>
            ${mostrarFaltaRecuperada ? `
            <label class="checkbox-card" for="asist-falta-recuperada">
              <input id="asist-falta-recuperada" type="checkbox" ${faltaRecuperada ? 'checked' : ''} ${recuperadaDisabledAttr}>
              <span class="checkbox-box" aria-hidden="true"></span>
              <span class="checkbox-text">Marcar falta como recuperada</span>
              <small style="display:block; color:#6b7280;">Solo aplica cuando no hay marcas de entrada y salida.</small>
            </label>
            ` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function abrirModalAsistencia(registro = null) {
  if (!docentes.length || !cursos.length) {
    Swal.fire('Datos incompletos', 'Registra docentes y cursos activos antes de gestionar asistencias manuales.', 'warning');
    return;
  }

  Swal.fire({
    title: registro ? 'Editar asistencia' : 'Nueva asistencia',
    html: construirFormularioAsistencia(registro),
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: registro ? 'Guardar cambios' : 'Crear asistencia',
    cancelButtonText: 'Cancelar',
    width: '540px',
    customClass: { popup: 'modal-asistencia' },
    preConfirm: () => {
      const fecha = document.getElementById('asist-fecha').value.trim();
      const idDocente = document.getElementById('asist-docente').value;
      const idCurso = document.getElementById('asist-curso').value;
      const horaEntradaProg = document.getElementById('asist-entrada-prog').value;
      const horaEntradaReal = document.getElementById('asist-entrada-real').value;
      const horaSalidaProg = document.getElementById('asist-salida-prog').value;
      const horaSalidaReal = document.getElementById('asist-salida-real').value;
      const esRecuperacion = document.getElementById('asist-recuperacion').checked;
      const esFalta = !horaEntradaReal && !horaSalidaReal;
      const faltaRecuperada = esFalta && (document.getElementById('asist-falta-recuperada')?.checked || false);
      const activacion = document.getElementById('asist-activa').checked ? 1 : 0;

      if (!fecha || !idDocente || !idCurso || !horaEntradaProg || !horaSalidaProg) {
        Swal.showValidationMessage('Completa fecha, docente, curso y horas programadas.');
        return false;
      }

      return {
        fecha,
        idDocente: Number(idDocente),
        idCurso: Number(idCurso),
        horaEntradaProg,
        horaEntradaReal: horaEntradaReal || null,
        horaSalidaProg,
        horaSalidaReal: horaSalidaReal || null,
        esRecuperacion,
        faltaRecuperada,
        activacion,
      };
    }
  }).then(async (result) => {
    if (!result.isConfirmed || !result.value) return;

    Swal.fire({
      title: registro ? 'Guardando cambios...' : 'Creando asistencia...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    try {
      await guardarAsistenciaManual(registro ? registro.id : null, result.value);
      Swal.close();
      await cargarAsistencias();
      Swal.fire('Listo', registro ? 'La asistencia fue actualizada.' : 'La asistencia fue registrada.', 'success');
    } catch (err) {
      Swal.close();
      console.error('Error guardando asistencia:', err);
      Swal.fire('Error', err.message || 'No se pudo guardar la asistencia.', 'error');
    }
  });
}

async function guardarAsistenciaManual(idAsistencia, payload) {
  const url = idAsistencia
    ? `${BASE_URL}/api/admin/asistencias/${idAsistencia}`
    : `${BASE_URL}/api/admin/asistencias`;

  const method = idAsistencia ? 'PUT' : 'POST';

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data) {
    throw new Error((data && data.error) || 'No se pudo guardar la asistencia.');
  }

  return data;
}

async function desactivarAsistencia(registro) {
  const confirmacion = await Swal.fire({
    title: 'Desactivar asistencia',
    html: `Se dejará de mostrar el registro del <strong>${sanitizeHtml(registro.docente)}</strong><br><small>${formatearFechaBonita(registro.fecha)} · ${sanitizeHtml(registro.curso)}</small>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    confirmButtonText: 'Sí, desactivar',
    cancelButtonText: 'Cancelar'
  });

  if (!confirmacion.isConfirmed) return;

  Swal.fire({
    title: 'Desactivando...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const response = await fetch(`${BASE_URL}/api/admin/asistencias/${registro.id}/desactivar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error((data && data.error) || 'No se pudo desactivar la asistencia.');
    }

    asistencias = asistencias.filter(item => Number(item.id) !== Number(registro.id));
    renderizarAsistencias();
    Swal.fire('Registro desactivado', 'La asistencia ya no aparecerá en los reportes ni en la lista.', 'success');
  } catch (err) {
    console.error('Error desactivando asistencia:', err);
    Swal.fire('Error', err.message || 'No se pudo desactivar la asistencia.', 'error');
  }
}

async function eliminarAsistencia(registro) {
  const confirmacion = await Swal.fire({
    title: 'Eliminar asistencia',
    html: `Esta acción borrará el registro de <strong>${sanitizeHtml(registro.docente)}</strong> para <strong>${sanitizeHtml(registro.curso)}</strong>.<br><br><small>${formatearFechaBonita(registro.fecha)} · ${formatearHoraCorta(registro.horaEntradaReal)} - ${formatearHoraCorta(registro.horaSalidaReal)}</small>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#b91c1c',
    confirmButtonText: 'Sí, borrar',
    cancelButtonText: 'Cancelar'
  });

  if (!confirmacion.isConfirmed) return;

  Swal.fire({
    title: 'Eliminando registro...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    // Nota: no eliminar realmente en base de datos. Simulamos la eliminación desactivando el registro.
    const response = await fetch(`${BASE_URL}/api/admin/asistencias/${registro.id}/desactivar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error((data && data.error) || 'No se pudo simular la eliminación (desactivar).');
    }

    // Actualizar en memoria y renderizar
    asistencias = asistencias.filter(item => Number(item.id) !== Number(registro.id));
    renderizarAsistencias();
    Swal.fire('Simulación completada', 'El registro fue desactivado (simulación de eliminación).', 'success');
  } catch (err) {
    console.error('Error eliminando asistencia:', err);
    Swal.fire('Error', err.message || 'No se pudo eliminar la asistencia.', 'error');
  }
}

/*********************************
 * LIMPIAR HISTORIAL
 *********************************/
async function limpiarHistorial() {
  const confirm = await Swal.fire({
    title: '⚠️ ¿Estás completamente seguro?',
    html: `
      <p>Esta acción eliminará:</p>
      <ul style="text-align:left; margin-left:20%; line-height:1.8;">
        <li>✗ Todas las asistencias</li>
        <li>✗ Todos los bloqueos</li>
        <li>✗ Todas las activaciones especiales</li>
      </ul>
      <p style="color:#d33; font-weight:bold; margin-top:15px;">⚠️ Esta acción NO se puede deshacer ⚠️</p>
    `,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#d33',
    confirmButtonText: 'Sí, borrar todo',
    cancelButtonText: 'Cancelar'
  });

  if (confirm.isConfirmed) {
    try {
      const res = await fetch(`${BASE_URL}/api/admin/limpiar-historial`, {
        method: 'POST'
      });

      const data = await res.json();

      if (res.ok) {
        Swal.fire('¡Limpiado!', 'Todo el historial ha sido eliminado', 'success');
        await ejecutarCargaTotal();
      } else {
        throw new Error(data.error || 'Error al limpiar historial');
      }
    } catch (err) {
      console.error('Error:', err);
      Swal.fire('Error', err.message || 'No se pudo limpiar el historial', 'error');
    }
  }
}

/*********************************
 * CONTROL DE SECCIONES
 *********************************/
function mostrarSeccion(id) {
  document.querySelectorAll('.seccion-panel').forEach(sec => sec.classList.add('oculto'));
  const seccion = document.getElementById(id);
  if (seccion) seccion.classList.remove('oculto');

  // Actualizar estado activo en el sidebar (botones con clase .btn-side)
  document.querySelectorAll('.btn-side').forEach(btn => btn.classList.remove('active'));
  const boton = document.querySelector(`.btn-side[data-seccion="${id}"]`);
  if (boton) boton.classList.add('active');
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebarAdmin");
  const overlay = document.getElementById("sidebarOverlay");

  if (!sidebar || !overlay) return;

  const isMobile = window.matchMedia("(max-width: 1024px)").matches;
  if (!isMobile) return;

  sidebar.classList.toggle("open");
  overlay.classList.toggle("open");
}

function irSeccion(id) {
  mostrarSeccion(id);
  // cerrar sidebar en móviles
  toggleSidebar();
}

configurarResaltadoDashboard();