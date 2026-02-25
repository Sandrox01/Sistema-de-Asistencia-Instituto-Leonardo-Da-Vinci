/*********************************
 * CONFIGURACIÓN COMPLETA - VESRION FINAL - SANDRO CARDENAS VILCA
 *********************************/

const TOLERANCIA_ENTRADA_MIN = 10;
const LIMITE_TARDANZA = 30;
const VENTANA_SALIDA_MIN = 15; // Ventana de 15 minutos después del último curso
const DNI_ADMIN = "16769288";
const BASE_URL = "http://localhost:3000";

let docenteActual = null;
let asistenciasHoy = [];
let cursoActivoActual = null;
let bloqueActivo = false;

let docentes = [];
let desfaseServidorMs = 0;
let ultimaSincronizacionServidor = 0;
let relojIntervalId = null;

async function sincronizarHoraServidor() {
    try {
        const inicio = Date.now();
        const res = await fetch(`${BASE_URL}/api/hora-servidor`);
        if (!res.ok) throw new Error("Respuesta inválida");
        const data = await res.json();
        if (!data || !data.iso) throw new Error("Formato inesperado");
        const fin = Date.now();
        const horaServidor = Date.parse(data.iso);
        if (Number.isNaN(horaServidor)) throw new Error("Fecha no interpretable");
        const latencia = (fin - inicio) / 2;
        desfaseServidorMs = horaServidor - (inicio + latencia);
        ultimaSincronizacionServidor = Date.now();
    } catch (err) {
        console.error("No se pudo sincronizar hora del servidor:", err);
        desfaseServidorMs = 0;
    }
}

function ahoraServidor() {
    return new Date(Date.now() + desfaseServidorMs);
}

function renderizarRelojCabecera() {
    const relojTexto = document.getElementById("relojTexto");
    if (!relojTexto) return;

    // Re-sincronizar cada 60 segundos para minimizar desvíos
    if (Date.now() - ultimaSincronizacionServidor > 60_000) {
        sincronizarHoraServidor().catch((err) => console.error("Error al re-sincronizar reloj:", err));
    }

    const ahora = ahoraServidor();
    relojTexto.textContent = `${ahora.toLocaleDateString("es-PE", {
        weekday: "short",
        day: "2-digit",
        month: "short",
    })} • ${ahora.toLocaleTimeString("es-PE")}`;
}

function iniciarRelojCabecera() {
    renderizarRelojCabecera();
    if (relojIntervalId) clearInterval(relojIntervalId);
    relojIntervalId = setInterval(renderizarRelojCabecera, 1000);
}

async function cargarDocentes() {
    const res = await fetch(`${BASE_URL}/api/docentes`);
    docentes = await res.json();
}

window.addEventListener("load", async () => {
    try {
        await Promise.all([cargarDocentes(), sincronizarHoraServidor()]);
    } catch (err) {
        console.error("Error en la inicialización:", err);
    }
    iniciarRelojCabecera();
});

/*********************************
 * LOGIN POR DNI
 *********************************/
async function verificarDNI() {
    const dni = document.getElementById("dniInput").value.trim();

    if (dni === DNI_ADMIN) {
        window.location.href = "admin.html";
        return;
    }

    docenteActual = docentes.find(d => d.dni === dni);

    if (!docenteActual) {
        // Aviso visual usando SweetAlert2 en lugar del mensaje fijo debajo
        await Swal.fire({
            icon: "error",
            title: "DNI no encontrado",
            text: "El DNI ingresado no existe. Verifique que esté bien escrito e intente nuevamente.",
            confirmButtonText: "Entendido"
        });
        const campoDni = document.getElementById("dniInput");
        if (campoDni) campoDni.value = "";
        // Limpia el mensaje de texto en la tarjeta, por si tenía algo previo
        mostrarMensaje("");
        return;
    }

    docenteActual.horario = await cargarHorarioDocente(dni);
    asistenciasHoy = await cargarAsistenciasHoy(dni);
    
    // PASO 1: Limpiar entradas huérfanas (entradas sin salida de cursos ya terminados)
    await limpiarEntradasHuerfanas(dni);
    
    // PASO 2: Registrar faltas automáticas para cursos que ya terminaron sin asistencia
    await registrarFaltasAutomaticas(dni);
    
    // PASO 3: Recargar asistencias después de limpiar y registrar faltas
    asistenciasHoy = await cargarAsistenciasHoy(dni);
    
    cursoActivoActual = await cargarCursoActivo(dni);
    bloqueActivo = cursoActivoActual !== null;

    await sincronizarHoraServidor();
    mostrarPanelDocente();

}

async function cargarHorarioDocente(dni) {
    const res = await fetch(`${BASE_URL}/api/horarios`);
    const horarios = await res.json();

    return horarios
        .filter(h => h.docente_dni === dni)
        .map(h => ({
            id_curso: h.id_curso,
            curso: h.curso,
            dia: h.dia,
            inicio: h.hora_inicio,
            fin: h.hora_fin
        }));
}

async function cargarAsistenciasHoy(dni) {
    const res = await fetch(`${BASE_URL}/api/asistencias-hoy/${dni}`);
    return await res.json();
}

async function cargarCursoActivo(dni) {
    const res = await fetch(`${BASE_URL}/api/asistencia-activa/${dni}`);
    return await res.json();
}

// Limpia entradas huérfanas (entradas sin salida de cursos que ya terminaron)
async function limpiarEntradasHuerfanas(dni) {
    try {
        const res = await fetch(`${BASE_URL}/api/limpiar-entradas-huerfanas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dni: dni })
        });
        
        if (res.ok) {
            const resultado = await res.json();
            if (resultado.limpiezas > 0) {
                console.log(`🧹 ${resultado.mensaje}`);
            }
        }
    } catch (err) {
        console.error("Error al limpiar entradas huérfanas:", err);
    }
}

// Registra faltas automáticas para cursos que ya terminaron sin asistencia
async function registrarFaltasAutomaticas(dni) {
    try {
        const res = await fetch(`${BASE_URL}/api/registrar-faltas-automaticas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dni: dni })
        });
        
        if (res.ok) {
            const resultado = await res.json();
            if (resultado.faltas_registradas > 0) {
                console.log(`✅ ${resultado.mensaje}`);
            }
        }
    } catch (err) {
        console.error("Error al registrar faltas automáticas:", err);
    }
}

/*********************************
 * UTILIDADES
 *********************************/

function convertirAMin(hora) {
    const [h, m] = hora.split(":").map(Number);
    return h * 60 + m;
}

function agruparCursosContinuos(horarios) {
    if (!horarios.length) return [];

    horarios.sort((a, b) => convertirAMin(a.inicio) - convertirAMin(b.inicio));

    const grupos = [];
    let grupo = [horarios[0]];

    for (let i = 1; i < horarios.length; i++) {
        const finAnterior = convertirAMin(horarios[i - 1].fin);
        const inicioActual = convertirAMin(horarios[i].inicio);
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

/*********************************
 * PANEL DOCENTE
 *********************************/
function mostrarPanelDocente() {
    document.getElementById("panelDocente").classList.remove("hidden");

    document.getElementById("bienvenida").innerText =
        `Bienvenido/a ${docenteActual.nombre}`;

    const ahora = ahoraServidor();
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const diaHoy = dias[ahora.getDay()];

    document.getElementById("fechaActual").innerText =
        `${diaHoy} - ${ahora.toLocaleDateString()}`;

    const lista = document.getElementById("listaCursos");
    lista.innerHTML = "";

    const minActual = ahora.getHours() * 60 + ahora.getMinutes();
    const cursosHoy = docenteActual.horario.filter(h => h.dia === diaHoy);

    if (cursosHoy.length === 0) {
        lista.innerHTML = `<li>📅 No tiene cursos programados para hoy</li>`;
        bloquearBotones();
        return;
    }

    const grupos = agruparCursosContinuos(cursosHoy);
    // ================================
    // ✅ SI HAY ASISTENCIA ACTIVA REAL
    // ================================
    if (cursoActivoActual) {
        const cursoActivoId = cursoActivoActual.id_curso;

        // Buscar el grupo donde está el curso activo
        const grupoActivo = grupos.find(g => g.some(c => c.id_curso === cursoActivoId));

        if (grupoActivo) {
            const idx = grupoActivo.findIndex(c => c.id_curso === cursoActivoId);

            lista.innerHTML += `<li><strong>📘 Curso en curso</strong></li>`;

            for (let i = idx; i < grupoActivo.length; i++) {
                const c = grupoActivo[i];

                if (i === idx) {
                    lista.innerHTML += `<li>▶ ${c.curso} (${c.inicio} - ${c.fin})</li>`;
                } else {
                    lista.innerHTML += `<li>↳ ${c.curso} (${c.inicio} - ${c.fin})</li>`;
                }
            }

            lista.innerHTML += `<li class="info-bloque">ℹ️ Marque salida para cerrar el curso actual</li>`;

            ocultarEntradaMostrarSalida();
            return; // 🔥 IMPORTANTÍSIMO: NO seguir con lógica de "disponibles"
        }
    }


    // Identificar cursos con asistencia (completados O con falta)
    const cursosConAsistencia = asistenciasHoy.map(a => a.id_curso);
    
    // Identificar solo los completados (con hora_salida)
    const cursosCompletados = asistenciasHoy
        .filter(a => a.hora_salida !== null)
        .map(a => a.id_curso);

    // Buscar bloque/curso disponible
    let bloqueDisponible = null;
    let cursoInicioBloque = null;
    let enVentanaSalida = false;

    for (const grupo of grupos) {
        // Buscar cursos que NO tienen ningún registro de asistencia
        const cursosSinRegistro = grupo.filter(c => !cursosConAsistencia.includes(c.id_curso));
        
        if (cursosSinRegistro.length === 0) {
            // Todos los cursos de este bloque ya tienen registro (completados o faltas)
            continue;
        }

        // Encontrar el primer curso sin registro que esté en su ventana de tiempo
        let cursoDisponible = null;
        
        for (const curso of cursosSinRegistro) {
            const inicioCurso = convertirAMin(curso.inicio);
            const finCurso = convertirAMin(curso.fin);
            
            // Verificar si estamos en ventana de este curso (10 min antes hasta 15 min después)
            if (minActual >= inicioCurso - TOLERANCIA_ENTRADA_MIN && 
                minActual <= finCurso) {
                cursoDisponible = curso;
                break;
            }
        }
        
        if (cursoDisponible) {
            const inicioCurso = convertirAMin(cursoDisponible.inicio);
            const finCurso = convertirAMin(cursoDisponible.fin);
            
            // Verificar si estamos en la ventana de salida
            if (minActual > finCurso && minActual <= finCurso + VENTANA_SALIDA_MIN) {
                enVentanaSalida = true;
            }
            
            bloqueDisponible = [cursoDisponible];
            cursoInicioBloque = cursoDisponible;
            
            // Agregar cursos continuos posteriores sin registro
            const idxCurso = grupo.findIndex(c => c.id_curso === cursoDisponible.id_curso);
            for (let i = idxCurso + 1; i < grupo.length; i++) {
                const siguienteCurso = grupo[i];
                if (!cursosConAsistencia.includes(siguienteCurso.id_curso)) {
                    bloqueDisponible.push(siguienteCurso);
                } else {
                    continue; // Si encuentra uno con registro, detener
                }
            }
            
            break;
        }
    }

    if (bloqueDisponible && cursoInicioBloque) {
        // Hay bloque/curso disponible
        
        // Mostrar solo cursos que aún están en tiempo (antes de su fin) o en ventana de salida
        const cursosAMostrar = bloqueDisponible.filter(curso => {
            const finCurso = convertirAMin(curso.fin);
            return minActual <= finCurso + VENTANA_SALIDA_MIN;
        });

        if (cursosAMostrar.length === 0) {
            mostrarCursosCompletadosYPendientes(grupos, cursosCompletados, lista);
            lista.innerHTML += `<li>⛔ No tiene curso disponible en este momento</li>`;
            bloquearBotones();
            return;
        }

        if (cursosAMostrar.length > 1) {
            lista.innerHTML += `<li><strong>📘 Bloque de cursos disponible</strong></li>`;
        } else {
            lista.innerHTML += `<li><strong>📘 Curso disponible</strong></li>`;
        }
        
        cursosAMostrar.forEach((curso, idx) => {
            if (idx === 0) {
                lista.innerHTML += `<li>▶ ${curso.curso} (${curso.inicio} - ${curso.fin})</li>`;
            } else {
                lista.innerHTML += `<li>↳ ${curso.curso} (${curso.inicio} - ${curso.fin})</li>`;
            }
        });

        if (bloqueActivo) {
            // Hay entrada activa
            if (enVentanaSalida) {
                lista.innerHTML += `<li class="info-bloque">⏰ Ventana de salida activa (${VENTANA_SALIDA_MIN} min después del último curso)</li>`;
            } else if (cursosAMostrar.length > 1) {
                lista.innerHTML += `<li class="info-bloque">ℹ️ Puede salir al finalizar cada curso o al final del bloque completo</li>`;
            } else {
                lista.innerHTML += `<li class="info-bloque">ℹ️ Marque salida al finalizar</li>`;
            }
            ocultarEntradaMostrarSalida();
        } else {
            // No hay entrada activa
            if (enVentanaSalida) {
                // Está en ventana de salida pero sin entrada activa - no debería pasar, pero por si acaso
                lista.innerHTML += `<li>⛔ Fuera de horario de entrada. Cursos ya finalizados.</li>`;
                bloquearBotones();
            } else {
                if (cursosAMostrar.length > 1) {
                    lista.innerHTML += `<li class="info-bloque">ℹ️ Marque entrada una vez. Puede salir entre cursos o al final</li>`;
                } else {
                    lista.innerHTML += `<li class="info-bloque">ℹ️ Marque entrada para iniciar</li>`;
                }
                habilitarEntrada();
            }
        }
    } else {
        // No hay curso disponible ahora - mostrar completados y pendientes
        mostrarCursosCompletadosYPendientes(grupos, cursosCompletados, lista);
        lista.innerHTML += `<li>⛔ No tiene curso disponible en este momento</li>`;
        bloquearBotones();
    }
}

function mostrarCursosCompletadosYPendientes(grupos, cursosCompletados, lista) {
    let hayCompletados = false;
    let hayPendientes = false;

    grupos.forEach(grupo => {
        const algunoCompletado = grupo.some(c => cursosCompletados.includes(c.id_curso));
        const todosCompletados = grupo.every(c => cursosCompletados.includes(c.id_curso));

        if (algunoCompletado) {
            if (!hayCompletados) {
                lista.innerHTML += `<li><strong>✅ Cursos completados hoy</strong></li>`;
                hayCompletados = true;
            }
            grupo.forEach((curso, idx) => {
                const completado = cursosCompletados.includes(curso.id_curso);
                const prefijo = completado ? (idx === 0 ? '✓' : '↳✓') : (idx === 0 ? '○' : '↳○');
                const estilo = completado ? '' : ' style="opacity: 0.6"';
                lista.innerHTML += `<li${estilo}>${prefijo} ${curso.curso} (${curso.inicio} - ${curso.fin})</li>`;
            });
        } else {
            if (!hayPendientes) {
                lista.innerHTML += `<li><strong>⏳ Bloques pendientes</strong></li>`;
                hayPendientes = true;
            }
            grupo.forEach((curso, idx) => {
                const prefijo = idx === 0 ? '○' : '↳';
                lista.innerHTML += `<li>${prefijo} ${curso.curso} (${curso.inicio} - ${curso.fin})</li>`;
            });
        }
    });
}

/*********************************
 * MARCAR ENTRADA
 *********************************/
async function marcarEntrada() {
    const res = await fetch(`${BASE_URL}/api/marcar-entrada`,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ dni: docenteActual.dni })
    });

    const data = await res.json();

    if (!res.ok) {
        if (data.bloqueado) {
            Swal.fire({
                icon: "error",
                title: "Acceso Bloqueado",
                html: `
                    <p>${data.error}</p>
                    <br>
                    <p><strong>¿Qué hacer?</strong></p>
                    <ol style="text-align:left; margin-left:20%">
                        <li>Acuda a administración</li>
                        <li>Explique su situación</li>
                        <li>Solicite una activación especial</li>
                        <li>Vuelva a intentar marcar entrada</li>
                    </ol>
                `,
                confirmButtonText: "Entendido"
            });
        } else {
            Swal.fire("Error", data.error || "No se pudo registrar entrada", "error");
        }
        return;
    }

    let mensaje = '';
    if (data.cursos_bloque > 1) {
        mensaje = `Bloque de ${data.cursos_bloque} curso(s) iniciado.\nPuede salir entre cursos o al finalizar todo el bloque.`;
    } else {
        mensaje = 'Entrada registrada correctamente';
    }

    Swal.fire("¡Entrada registrada!", mensaje, "success")
        .then(()=>reiniciarSesion());
}

/*********************************
 * MARCAR SALIDA
 *********************************/
async function marcarSalida() {
    document.getElementById("btnSalida").disabled = true;

    const resSalida = await fetch(`${BASE_URL}/api/marcar-salida`,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ dni: docenteActual.dni })
    });

    const data = await resSalida.json();

    if (!resSalida.ok) {
        if (data.bloqueado) {
            Swal.fire({
                icon: "error",
                title: "Acceso Bloqueado",
                html: `
                    <p>${data.error}</p>
                    <br>
                    <p><strong>¿Qué hacer?</strong></p>
                    <ol style="text-align:left; margin-left:20%">
                        <li>Acuda a administración</li>
                        <li>Explique su situación</li>
                        <li>Solicite una activación especial</li>
                        <li>Vuelva a intentar marcar salida</li>
                    </ol>
                `,
                confirmButtonText: "Entendido"
            });
        } else {
            Swal.fire(
                "Salida fuera de tolerancia",
                data.error || "Debe acudir a administración",
                "error"
            );
        }
        document.getElementById("btnSalida").disabled = false;
        return;
    }

    let titulo = "¡Salida registrada!";
    let mensaje = "";

    if (data.modo === 'activacion_especial') {
        mensaje = "Salida registrada con activación especial de administración";
    } else if (data.modo === 'emergencia') {
        mensaje = data.mensaje || "Salida anticipada. Los demás cursos quedan disponibles.";
    } else if (data.modo === 'bloque_completo') {
        mensaje = `Bloque completo: ${data.cursos_completados} curso(s) registrado(s)`;
    } else {
        mensaje = `Curso(s) completado(s). Los siguientes cursos quedan disponibles.`;
    }

    Swal.fire(titulo, mensaje, "success")
        .then(()=>reiniciarSesion());
}

/*********************************
 * UI HELPERS
 *********************************/

function bloquearBotones() {
    document.getElementById("btnEntrada").disabled = true;
    document.getElementById("btnEntrada").classList.add("hidden");
    document.getElementById("btnSalida").classList.add("hidden");
}

function habilitarEntrada() {
    document.getElementById("btnEntrada").disabled = false;
    document.getElementById("btnEntrada").classList.remove("hidden");
    document.getElementById("btnSalida").classList.add("hidden");
}

function ocultarEntradaMostrarSalida() {
    document.getElementById("btnEntrada").classList.add("hidden");
    document.getElementById("btnSalida").classList.remove("hidden");
    document.getElementById("btnSalida").disabled = false;
}

/*********************************
 * SESIÓN
 *********************************/

function reiniciarSesion() {
    docenteActual = null;
    asistenciasHoy = [];
    bloqueActivo = false;
    document.getElementById("dniInput").value = "";
    location.reload();
}

function mostrarMensaje(msg) {
    document.getElementById("mensaje").innerText = msg;
}