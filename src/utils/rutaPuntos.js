const pool = require('../database');
const { calcularDistancia } = require('./geoUtils');
const { enviarNotificacionAlumno } = require('./notificaciones');

const entregasNotificadasHoy = new Set(); // Cache en memoria: alumnoId_fecha

const normalizarNumero = (valor) => {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
};

const normalizarSentidoRuta = (valor) => {
    const sentido = String(valor || 'recogida').trim().toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    if (['recogida', 'casa_a_colegio', 'ida', 'manana'].includes(sentido)) {
        return 'recogida';
    }
    if (['entrega', 'colegio_a_casa', 'vuelta', 'tarde'].includes(sentido)) {
        return 'entrega';
    }
    return sentido;
};

const verificarEntregasAutomaticas = async (rutaId, lat, lng, io) => {
    if (!rutaId || !lat || !lng) return;

    try {
        const hoy = new Date().toISOString().split('T')[0];

        // 1. Buscar alumnos de esta ruta (sentido entrega) que NO han sido entregados hoy
        const pendientes = await pool.query(
            `SELECT p.alumno_id, p.latitud, p.longitud, p.nombre_parada, a.nombre as alumno_nombre
             FROM puntos_ruta p
             JOIN alumnos a ON a.id = p.alumno_id
             WHERE p.ruta_id = $1 AND p.tipo = 'entrega' AND p.alumno_id IS NOT NULL
             AND NOT EXISTS (
                SELECT 1 FROM eventos_ruta er
                WHERE er.tipo = 'entregado'
                  AND er.descripcion = CONCAT('alumnoId:', p.alumno_id)
                  AND DATE(er.creado_en) = CURRENT_DATE
             )`,
            [rutaId]
        );

        for (const p of pendientes.rows) {
            const key = `${p.alumno_id}_${hoy}`;
            if (entregasNotificadasHoy.has(key)) continue;

            const dist = calcularDistancia(lat, lng, Number(p.latitud), Number(p.longitud));

            // Si está a menos de 150 metros
            if (dist < 150) {
                entregasNotificadasHoy.add(key);
                console.log(`[AUTO-ENTREGA] Alumno ${p.alumno_nombre} entregado automáticamente en ${p.nombre_parada}`);

                // A. Registrar en DB
                await pool.query(
                    `INSERT INTO eventos_ruta (ruta_id, tipo, descripcion)
                     VALUES ($1, 'entregado', $2)`,
                    [rutaId, `alumnoId:${p.alumno_id}`]
                );

                // B. Notificar al padre
                enviarNotificacionAlumno(
                    p.alumno_id,
                    'Entrega confirmada',
                    `${p.alumno_nombre} ha sido entregado en su destino (Deteccion GPS).`,
                    { tipo: 'entrega_automatica', alumnoId: p.alumno_id, rutaId }
                ).catch(e => console.error('Error enviando push entrega auto:', e.message));

                // C. Emitir vía Socket
                if (io) {
                    io.to(`ruta:${rutaId}`).emit('alumno:entregado', {
                        alumnoId: p.alumno_id,
                        nombre: p.alumno_nombre,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error en verificarEntregasAutomaticas:', error.message);
    }
};

const normalizarTurnoRuta = (valor) => {
    const turno = String(valor || '').trim().toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    if (!turno || turno === 'todos') return null;
    if (turno === 'manana') return 'matutino';
    if (turno === 'tarde') return 'vespertino';
    return turno;
};

const sincronizarPuntoAlumno = async (alumnoId, client = pool) => {
    const resultado = await client.query(
        `SELECT id, ruta_id, nombre, parada, latitude, longitude, orden
         FROM alumnos
         WHERE id = $1::int`,
        [alumnoId]
    );

    if (resultado.rows.length === 0) return null;

    const alumno = resultado.rows[0];
    const rutaId = alumno.ruta_id;
    const latitud = normalizarNumero(alumno.latitude);
    const longitud = normalizarNumero(alumno.longitude);

    await client.query(
        `DELETE FROM puntos_ruta
         WHERE alumno_id = $1::int
           AND tipo = 'recogida'
           AND ($2::integer IS NULL OR ruta_id <> $2::int)`,
        [alumno.id, rutaId || null]
    );

    if (!rutaId || latitud === null || longitud === null) {
        await client.query(
            `DELETE FROM puntos_ruta
             WHERE alumno_id = $1::int
               AND tipo = 'recogida'`,
            [alumno.id]
        );
        return null;
    }

    const nombreParada = alumno.parada || `Punto de ${alumno.nombre}`;
    const orden = Number.isInteger(Number(alumno.orden)) ? Number(alumno.orden) : 1000;

    // Usar DELETE seguido de INSERT para evitar problemas con ON CONFLICT y índices parciales
    await client.query(
        `DELETE FROM puntos_ruta WHERE alumno_id = $1::int AND tipo = 'recogida'`,
        [alumno.id]
    );

    const punto = await client.query(
        `INSERT INTO puntos_ruta (ruta_id, alumno_id, tipo, latitud, longitud, orden, nombre_parada)
         VALUES ($1::int, $2::int, 'recogida', $3::numeric, $4::numeric, $5::int, $6::text)
         RETURNING *`,
        [rutaId, alumno.id, latitud, longitud, orden, nombreParada]
    );

    return punto.rows[0] || null;
};

const guardarPuntoRutaAlumno = async ({
    alumnoId,
    rutaId,
    tipo = 'recogida',
    latitud,
    longitud,
    orden = 1000,
    nombreParada,
}, client = pool) => {
    const lat = normalizarNumero(latitud);
    const lng = normalizarNumero(longitud);

    if (!alumnoId || !rutaId || lat === null || lng === null) return null;

    await client.query(
        `DELETE FROM puntos_ruta
         WHERE alumno_id = $1::int
           AND tipo = $2::text`,
        [alumnoId, tipo]
    );

    const punto = await client.query(
        `INSERT INTO puntos_ruta (ruta_id, alumno_id, tipo, latitud, longitud, orden, nombre_parada)
         VALUES ($1::int, $2::int, $3::text, $4::numeric, $5::numeric, $6::int, $7::text)
         RETURNING *`,
        [rutaId, alumnoId, tipo, lat, lng, orden, nombreParada || `Punto ${tipo}`]
    );

    return punto.rows[0] || null;
};

const sincronizarPuntosRuta = async (rutaId, client = pool, opciones = {}) => {
    if (!rutaId) return [];

    const turno = normalizarTurnoRuta(opciones.turno || 'matutino');
    const sentido = normalizarSentidoRuta(opciones.sentido);

    // 1. Obtener datos base (Alumnos activos de la ruta)
    // Filtramos alumnos que tengan ausencia AUTORIZADA para hoy
    const alumnosResult = await client.query(
        `SELECT a.id, a.nombre, a.parada, a.latitude, a.longitude, a.orden, a.turno_estudio,
                c.latitude as colegio_lat, c.longitude as colegio_lng, c.nombre as colegio_nombre
         FROM alumnos a
         LEFT JOIN colegios c ON c.id = a.colegio_id
         WHERE a.ruta_id = $1
           AND a.activo = true
           AND ($2::text IS NULL OR a.turno_estudio = $2::text)
           AND NOT EXISTS (
               SELECT 1 FROM ausencias au
               WHERE au.alumno_id = a.id
                 AND au.estado = 'autorizado'
                 AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
           )`,
        [rutaId, turno]
    );

    if (alumnosResult.rows.length === 0) {
        // Si no hay alumnos, limpiamos la ruta y salimos
        await client.query(`DELETE FROM puntos_ruta WHERE ruta_id = $1 AND tipo = $2::text`, [rutaId, sentido]);
        return [];
    }

    const colegio = {
        lat: normalizarNumero(alumnosResult.rows[0].colegio_lat),
        lng: normalizarNumero(alumnosResult.rows[0].colegio_lng),
        nombre: alumnosResult.rows[0].colegio_nombre || 'Colegio'
    };

    // 2. Buscar cambios temporales APROBADOS para hoy.
    const alumnosIdsBase = alumnosResult.rows.map((alumno) => alumno.id);
    const cambiosResult = await client.query(
        `SELECT *
         FROM programacion_rutas
         WHERE fecha = CURRENT_DATE
           AND estado = 'aprobado'
           AND (ruta_id = $1 OR alumno_id = ANY($2::int[]))`,
        [rutaId, alumnosIdsBase]
    );

    const cambiosMap = new Map();
    const rutaCambioAlumno = new Map();
    for (const cambio of cambiosResult.rows) {
        const tipoCambio = normalizarSentidoRuta(cambio.tipo);
        if (cambio.ruta_id) {
            rutaCambioAlumno.set(Number(cambio.alumno_id), Number(cambio.ruta_id));
        }
        if (cambio.tipo === 'ambos' || tipoCambio === sentido) {
            cambiosMap.set(Number(cambio.alumno_id), cambio);
        }
    }

    const entregaResult = await client.query(
        `SELECT alumno_id, ruta_id, nombre_parada, latitud, longitud, orden
         FROM puntos_ruta
         WHERE ruta_id = $1
           AND tipo = 'entrega'
           AND alumno_id = ANY($2::int[])`,
        [rutaId, alumnosIdsBase]
    );
    const entregasMap = new Map(entregaResult.rows.map((p) => [Number(p.alumno_id), p]));

    const alumnosRutaActual = alumnosResult.rows.filter((alumno) => {
        const rutaCambio = rutaCambioAlumno.get(Number(alumno.id));
        return !rutaCambio || rutaCambio === Number(rutaId);
    });

    const alumnosEntrantesResult = await client.query(
        `SELECT a.id, a.nombre, a.parada, a.latitude, a.longitude, a.orden, a.turno_estudio,
                c.latitude as colegio_lat, c.longitude as colegio_lng, c.nombre as colegio_nombre
         FROM programacion_rutas pr
         INNER JOIN alumnos a ON a.id = pr.alumno_id
         LEFT JOIN colegios c ON c.id = a.colegio_id
         WHERE pr.ruta_id = $1
           AND pr.fecha = CURRENT_DATE
           AND pr.estado = 'aprobado'
           AND a.ruta_id <> $1
           AND a.activo = true
           AND ($2::text IS NULL OR a.turno_estudio = $2::text)
           AND (pr.tipo = 'ambos' OR pr.tipo = $3::text OR pr.tipo = $4::text)
           AND NOT EXISTS (
               SELECT 1 FROM ausencias au
               WHERE au.alumno_id = a.id
                 AND au.estado = 'autorizado'
                 AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
           )`,
        [
            rutaId,
            turno,
            sentido,
            sentido === 'recogida' ? 'casa_a_colegio' : 'colegio_a_casa',
        ]
    );

    for (const alumno of alumnosEntrantesResult.rows) {
        alumnosRutaActual.push(alumno);
    }

    if (alumnosEntrantesResult.rows.length > 0) {
        const alumnosIdsEntrantes = alumnosEntrantesResult.rows.map((alumno) => alumno.id);
        const cambiosEntrantes = await client.query(
            `SELECT *
             FROM programacion_rutas
             WHERE ruta_id = $1
               AND fecha = CURRENT_DATE
               AND estado = 'aprobado'
               AND alumno_id = ANY($2::int[])`,
            [rutaId, alumnosIdsEntrantes]
        );
        for (const cambio of cambiosEntrantes.rows) {
            cambiosMap.set(Number(cambio.alumno_id), cambio);
        }

        const entregaEntranteResult = await client.query(
            `SELECT alumno_id, ruta_id, nombre_parada, latitud, longitud, orden
             FROM puntos_ruta
             WHERE tipo = 'entrega'
               AND alumno_id = ANY($1::int[])`,
            [alumnosIdsEntrantes]
        );
        for (const punto of entregaEntranteResult.rows) {
            entregasMap.set(Number(punto.alumno_id), punto);
        }
    }

    // 3. Construir lista de paradas "Vivas"
    let paradas = alumnosRutaActual.map(alumno => {
        const cambio = cambiosMap.get(Number(alumno.id));
        
        // Si hay un cambio aprobado que aplique a este sentido o sea 'ambos'
        if (cambio) {
            return {
                alumno_id: alumno.id,
                nombre: alumno.nombre,
                parada: cambio.parada || alumno.parada,
                lat: normalizarNumero(cambio.latitude) ?? normalizarNumero(alumno.latitude),
                lng: normalizarNumero(cambio.longitude) ?? normalizarNumero(alumno.longitude),
                orden: alumno.orden || 1000
            };
        }

        if (sentido === 'entrega') {
            const entrega = entregasMap.get(Number(alumno.id));
            if (entrega) {
                return {
                    alumno_id: alumno.id,
                    nombre: alumno.nombre,
                    parada: entrega.nombre_parada || alumno.parada,
                    lat: normalizarNumero(entrega.latitud),
                    lng: normalizarNumero(entrega.longitud),
                    orden: entrega.orden || alumno.orden || 1000
                };
            }
        }

        return {
            alumno_id: alumno.id,
            nombre: alumno.nombre,
            parada: alumno.parada,
            lat: normalizarNumero(alumno.latitude),
            lng: normalizarNumero(alumno.longitude),
            orden: alumno.orden || 1000
        };
    });

    // Filtrar paradas sin GPS
    paradas = paradas.filter(p => p.lat !== null && p.lng !== null);

    // 4. Ordenar y aplicar lógica de Recogida vs Entrega
    if (sentido === 'recogida') {
        // Orden normal -> El Colegio es el DESTINO FINAL
        paradas.sort((a, b) => a.orden - b.orden);
        if (colegio.lat && colegio.lng) {
            paradas.push({
                alumno_id: null,
                nombre: 'Llegada: ' + colegio.nombre,
                parada: 'Colegio',
                lat: colegio.lat,
                lng: colegio.lng,
                orden: 9999
            });
        }
    } else {
        // Sentido Entrega: El Colegio es el PUNTO DE PARTIDA
        paradas.sort((a, b) => a.orden - b.orden);
        if (colegio.lat && colegio.lng) {
            paradas.unshift({
                alumno_id: null,
                nombre: 'Salida: ' + colegio.nombre,
                parada: 'Colegio',
                lat: colegio.lat,
                lng: colegio.lng,
                orden: 0
            });
        }
    }

    // 5. Guardar en la tabla puntos_ruta (la que usa el mapa y el detector de desvíos)
    await client.query(`DELETE FROM puntos_ruta WHERE ruta_id = $1 AND tipo = $2::text`, [rutaId, sentido]);

    const puntosInsertados = [];
    for (let i = 0; i < paradas.length; i++) {
        const p = paradas[i];
        const res = await client.query(
            `INSERT INTO puntos_ruta (ruta_id, alumno_id, tipo, latitud, longitud, orden, nombre_parada)
             VALUES ($1::int, $2::int, $3::text, $4::numeric, $5::numeric, $6::int, $7::text)
             RETURNING *`,
            [rutaId, p.alumno_id, sentido, p.lat, p.lng, i + 1, p.parada || `Punto de ${p.nombre}`]
        );
        puntosInsertados.push(res.rows[0]);
    }

    return puntosInsertados;
};

module.exports = {
    guardarPuntoRutaAlumno,
    sincronizarPuntoAlumno,
    sincronizarPuntosRuta,
    normalizarSentidoRuta,
    verificarEntregasAutomaticas,
};
