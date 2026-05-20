const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { autoNombrarRuta } = require('../utils/geoNaming');
const { guardarPuntoRutaAlumno, sincronizarPuntoAlumno } = require('../utils/rutaPuntos');
const { generarCodigoAleatorio } = require('../utils/codigos');
const { enviarNotificacionPush } = require('../utils/notificaciones');

const CONFIG_UI_POR_DEFECTO = {
    mostrarTotalAlumnosHistorial: false,
    mostrarLogoColegioInicio: true,
};

const tieneTexto = (valor) => valor !== null && valor !== undefined && String(valor).trim() !== '';
const normalizarTexto = (valor) => tieneTexto(valor) ? String(valor).trim() : null;
const normalizarCoordenada = (valor) => {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
};
const coordenadaIgual = (actual, nueva) => {
    if (actual === null || actual === undefined || nueva === null || nueva === undefined) return false;
    return Math.abs(Number(actual) - Number(nueva)) < 0.000001;
};
const normalizarTipoPunto = (valor) => {
    const tipo = tieneTexto(valor) ? String(valor).trim().toLowerCase() : 'recogida';
    return ['recogida', 'entrega'].includes(tipo) ? tipo : null;
};

const alumnoTienePuntoExacto = (alumno) => (
    tieneTexto(alumno.parada)
    && alumno.latitude !== null
    && alumno.latitude !== undefined
    && alumno.longitude !== null
    && alumno.longitude !== undefined
);

const crearSolicitudCambioPunto = async (client, {
    alumno,
    padreId,
    paradaNueva,
    latitudeNueva,
    longitudeNueva,
    motivo,
    tipo = 'recogida',
}) => {
    const pendiente = await client.query(
        `SELECT id
         FROM solicitudes_cambio_punto_recogida
         WHERE alumno_id = $1::int
           AND tipo = $2::text
           AND estado = 'pendiente'
         LIMIT 1`,
        [alumno.id, tipo]
    );

    if (pendiente.rows.length > 0) {
        const error = new Error('Ya existe una solicitud pendiente para este alumno');
        error.codigo = 'SOLICITUD_CAMBIO_PUNTO_PENDIENTE';
        error.solicitudId = pendiente.rows[0].id;
        throw error;
    }

    const solicitud = await client.query(
        `INSERT INTO solicitudes_cambio_punto_recogida (
            alumno_id,
            padre_id,
            conductor_id,
            ruta_id,
            tipo,
            parada_actual,
            latitude_actual,
            longitude_actual,
            parada_nueva,
            latitude_nueva,
            longitude_nueva,
            motivo
         )
         VALUES (
            $1::int, 
            $2::int, 
            $3::int, 
            $4::int, 
            $5::text, 
            $6::text, 
            $7::numeric, 
            $8::numeric, 
            $9::text, 
            $10::numeric, 
            $11::numeric, 
            $12::text
         )
         RETURNING *`,
        [
            alumno.id,
            padreId,
            alumno.conductor_id || null,
            alumno.ruta_id || null,
            tipo,
            alumno.parada,
            alumno.latitude,
            alumno.longitude,
            paradaNueva,
            latitudeNueva,
            longitudeNueva,
            motivo || 'Cambio solicitado por el padre desde el mapa',
        ]
    );

    return solicitud.rows[0];
};

const obtenerConfiguracionPadre = async () => {
    const resultado = await pool.query(
        `SELECT clave, valor
         FROM configuracion
         WHERE clave = ANY($1::text[])`,
        [[
            'mostrar_total_alumnos_historial_padre',
            'mostrar_logo_colegio_inicio',
        ]]
    );

    const configuracion = { ...CONFIG_UI_POR_DEFECTO };
    for (const item of resultado.rows) {
        const valor = String(item.valor).toLowerCase() === 'true';
        if (item.clave === 'mostrar_total_alumnos_historial_padre') {
            configuracion.mostrarTotalAlumnosHistorial = valor;
        }
        if (item.clave === 'mostrar_logo_colegio_inicio') {
            configuracion.mostrarLogoColegioInicio = valor;
        }
    }

    return configuracion;
};

// GET /api/padres/mis-hijos
// Devuelve la lista de hijos con su estado actual y datos de ruta
router.get('/mis-hijos', authenticateToken, requireRole('padre'), async (req, res) => {
    try {
        const padreId = req.user.id;
        
        const resultado = await pool.query(
            `SELECT 
                a.id, 
                a.nombre, 
                a.grado, 
                a.turno_estudio,
                COALESCE(a.colegio_nombre, c_fix.nombre) as "colegioNombre",
                COALESCE(pr.parada, a.parada) as parada, 
                COALESCE(pr.latitude, a.latitude) as latitude, 
                COALESCE(pr.longitude, a.longitude) as longitude,
                pe.nombre_parada as "entregaParada",
                pe.latitud as "entregaLatitude",
                pe.longitud as "entregaLongitude",
                COALESCE(pr.ruta_id, r.id) as "rutaId", 
                COALESCE(nr.nombre, r.nombre) as "rutaNombre",
                COALESCE(nu.nombre, u.nombre) as "conductorNombre", 
                COALESCE(nu.telefono, u.telefono) as "conductorTelefono",
                COALESCE(nu.id, u.id) as "conductorId",
                EXISTS (
                    SELECT 1 FROM eventos_ruta er 
                    WHERE er.tipo = 'abordado' 
                    AND er.descripcion = CONCAT('alumnoId:', a.id)
                    AND DATE(er.creado_en) = CURRENT_DATE
                ) as abordado,
                (pr.id IS NOT NULL) as "tieneProgramacionHoy",
                EXISTS (
                    SELECT 1 FROM ausencias au
                    WHERE au.alumno_id = a.id 
                      AND au.estado = 'autorizado'
                      AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
                ) as ausente,
                -- Promedios semanales (HH:MM)
                (SELECT TO_CHAR(AVG(creado_en::time - '00:00:00'::time), 'HH24:MI') 
                 FROM eventos_ruta 
                 WHERE tipo = 'abordado' AND descripcion = CONCAT('alumnoId:', a.id)
                   AND creado_en > NOW() - INTERVAL '7 days') as "promedioRecogida",
                (SELECT TO_CHAR(AVG(creado_en::time - '00:00:00'::time), 'HH24:MI') 
                 FROM eventos_ruta 
                 WHERE tipo = 'fin_ruta' AND ruta_id = COALESCE(pr.ruta_id, r.id)
                   AND creado_en > NOW() - INTERVAL '7 days') as "promedioLlegada"
            FROM alumnos a
            JOIN alumno_padres ap ON ap.alumno_id = a.id
            LEFT JOIN LATERAL (
                SELECT * FROM programacion_rutas 
                WHERE alumno_id = a.id AND fecha = CURRENT_DATE
                AND estado = 'aprobado'
                ORDER BY CASE WHEN tipo = 'ambos' THEN 1 ELSE 2 END
                LIMIT 1
            ) pr ON true
            LEFT JOIN rutas r ON r.id = a.ruta_id
            LEFT JOIN puntos_ruta pe ON pe.alumno_id = a.id AND pe.tipo = 'entrega'
            LEFT JOIN colegios c_fix ON c_fix.id = a.colegio_id
            LEFT JOIN usuarios u ON u.id = r.conductor_id
            LEFT JOIN rutas nr ON nr.id = pr.ruta_id
            LEFT JOIN usuarios nu ON nu.id = nr.conductor_id
            WHERE ap.padre_id = $1::int AND a.activo = true
            ORDER BY a.nombre`,
            [padreId]
        );

        res.json({ hijos: resultado.rows });
    } catch (error) {
        console.error('Error obteniendo hijos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

const handleProgramacionRequest = async (req, res) => {
    const { fecha_inicio, fecha_fin, ruta_id, parada, latitude, longitude, tipo, nota, fecha } = req.body;
    const alumnoId = Number(req.params.alumnoId || req.params.id);
    
    const fStartStr = fecha_inicio || fecha;
    const fEndStr = fecha_fin || fStartStr;

    if (!fStartStr) return res.status(400).json({ error: 'Fecha es requerida' });

    try {
        const vinculacion = await pool.query(
            'SELECT 1 FROM alumno_padres WHERE alumno_id = $1 AND padre_id = $2',
            [alumnoId, req.user.id]
        );
        if (vinculacion.rows.length === 0) return res.status(403).json({ error: 'No autorizado' });

        const fInicio = new Date(fStartStr);
        const fFin = new Date(fEndStr);
        const resultados = [];

        for (let d = new Date(fInicio); d <= fFin; d.setDate(d.getDate() + 1)) {
            const fechaStr = d.toISOString().split('T')[0];
            const resInsert = await pool.query(
                `INSERT INTO programacion_rutas 
                    (alumno_id, fecha, ruta_id, parada, latitude, longitude, tipo, nota, creado_por, estado)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente')
                 ON CONFLICT (alumno_id, fecha, tipo) 
                 DO UPDATE SET 
                    ruta_id = EXCLUDED.ruta_id,
                    parada = EXCLUDED.parada,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    nota = EXCLUDED.nota,
                    estado = 'pendiente',
                    creado_en = NOW()
                 RETURNING *`,
                [alumnoId, fechaStr, ruta_id || null, parada || null, latitude || null, longitude || null, tipo || 'ambos', nota || null, req.user.id]
            );
            resultados.push(resInsert.rows[0]);
        }

        res.status(201).json({ mensaje: 'Programaciones creadas', programaciones: resultados });
    } catch (error) {
        console.error('Error programacion:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// POST /api/padres/hijos/:alumnoId/programacion
router.post('/hijos/:alumnoId/programacion', authenticateToken, requireRole('padre'), handleProgramacionRequest);
router.post('/hijos/:alumnoId/programar-cambio', authenticateToken, requireRole('padre'), handleProgramacionRequest);

// Alias con :id para compatibilidad absoluta con instrucciones de frontend
router.post('/hijos/:id/reportar-ausencia', authenticateToken, requireRole('padre'), async (req, res) => {
    req.body.alumnoId = req.params.id;
    return reportarAusencia(req, res);
});
router.post('/hijos/:id/programar-cambio', authenticateToken, requireRole('padre'), handleProgramacionRequest);

// PUT /api/padres/hijos/:alumnoId
// Permite al padre editar la información básica de su hijo
router.put('/hijos/:alumnoId', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);
    const { nombre, grado, colegioNombre, direccion } = req.body;

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    try {
        // 1. Verificar pertenencia
        const check = await pool.query(
            `SELECT a.parada
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.id = $1::int AND ap.padre_id = $2::int AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'No tienes permiso para editar a este alumno' });
        }

        if (direccion !== undefined && tieneTexto(check.rows[0].parada) && direccion !== check.rows[0].parada) {
            return res.status(409).json({
                error: 'El cambio de direccion requiere coordinacion con el conductor',
                codigo: 'CAMBIO_DIRECCION_REQUIERE_APROBACION',
                mensaje: 'Coordina el cambio de direccion con el conductor. El flujo de solicitud pendiente de aprobacion aun no esta disponible.'
            });
        }

        // 2. Actualizar datos
        const resultado = await pool.query(
            `UPDATE alumnos 
             SET nombre = COALESCE($1::text, nombre),
                 grado = COALESCE($2::text, grado),
                 colegio_nombre = COALESCE($3::text, colegio_nombre),
                 parada = CASE
                    WHEN (parada IS NULL OR BTRIM(parada) = '') AND $4::text IS NOT NULL THEN $4::text
                    ELSE parada
                 END
             WHERE id = $5::int
             RETURNING id, nombre, grado, colegio_nombre as "colegioNombre", parada as direccion`,
            [nombre, grado, colegioNombre, direccion, alumnoId]
        );

        res.json({
            mensaje: 'Información del alumno actualizada correctamente',
            alumno: resultado.rows[0]
        });
    } catch (error) {
        console.error('Error editando alumno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/padres/hijos/:alumnoId/solicitudes-cambio-ruta
// Flujo futuro: solicitud pendiente de aprobacion del conductor.
router.post('/hijos/:alumnoId/solicitudes-cambio-ruta', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    try {
        const check = await pool.query(
            `SELECT 1
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.id = $1 AND ap.padre_id = $2 AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'No tienes permiso para solicitar cambios para este alumno' });
        }

        return res.status(501).json({
            error: 'Flujo de solicitud de cambio de ruta no implementado',
            codigo: 'SOLICITUD_CAMBIO_RUTA_NO_IMPLEMENTADA',
            mensaje: 'Por ahora coordina el cambio de direccion o ruta directamente con el conductor.'
        });
    } catch (error) {
        console.error('Error en solicitud de cambio de ruta:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/padres/hijos/:alumnoId/solicitud-cambio-punto-recogida
// Solicita autorizacion del conductor para mover un punto de recogida ya definido.
router.post('/hijos/:alumnoId/solicitud-cambio-punto-recogida', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);
    const {
        parada_nueva,
        latitude_nueva,
        longitude_nueva,
        motivo,
        tipo = 'recogida',
    } = req.body;

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    const latNueva = normalizarCoordenada(latitude_nueva);
    const lngNueva = normalizarCoordenada(longitude_nueva);
    const tipoPunto = normalizarTipoPunto(tipo);
    if (!tipoPunto) {
        return res.status(400).json({ error: 'tipo debe ser recogida o entrega' });
    }
    if (latNueva === null || lngNueva === null) {
        return res.status(400).json({ error: 'latitude_nueva y longitude_nueva son requeridos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const actual = await client.query(
            `SELECT a.id, a.nombre, a.ruta_id, a.parada, a.latitude, a.longitude,
                    r.conductor_id, u.nombre AS conductor_nombre
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             LEFT JOIN rutas r ON r.id = a.ruta_id
             LEFT JOIN usuarios u ON u.id = r.conductor_id
             WHERE a.id = $1::int
               AND ap.padre_id = $2::int
               AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Alumno no encontrado para este padre' });
        }

        const alumno = actual.rows[0];
        if (!alumnoTienePuntoExacto(alumno)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'El alumno aun no tiene un punto exacto guardado',
                codigo: 'PUNTO_RECOGIDA_INICIAL_REQUERIDO',
                mensaje: 'El primer punto exacto se guarda directamente desde /punto-recogida.'
            });
        }

        if (!alumno.conductor_id || !alumno.ruta_id) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'El alumno no tiene conductor asignado',
                codigo: 'CONDUCTOR_NO_ASIGNADO'
            });
        }

        const paradaNueva = normalizarTexto(parada_nueva) || `Punto ${latNueva.toFixed(5)}, ${lngNueva.toFixed(5)}`;

        const solicitud = await crearSolicitudCambioPunto(client, {
            alumno,
            padreId,
            paradaNueva,
            latitudeNueva: latNueva,
            longitudeNueva: lngNueva,
            motivo,
            tipo: tipoPunto,
        });

        await client.query('COMMIT');

        enviarNotificacionPush(
            alumno.conductor_id,
            'Solicitud de cambio de punto',
            `${alumno.nombre} tiene un nuevo punto de recogida pendiente de autorizacion.`,
            { tipo: 'solicitud_cambio_punto_recogida', solicitudId: solicitud.id, alumnoId: alumno.id, rutaId: alumno.ruta_id }
        ).catch(err => console.error('Error notificando cambio de punto al conductor:', err.message));

        if (req.io) {
            req.io.to(`ruta:${alumno.ruta_id}`).emit('solicitud:cambio_punto_recogida', {
                solicitudId: solicitud.id,
                alumnoId: alumno.id,
                estado: solicitud.estado,
            });
        }

        res.status(202).json({
            mensaje: 'Solicitud de cambio de punto de recogida enviada al conductor',
            solicitud
        });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.codigo === 'SOLICITUD_CAMBIO_PUNTO_PENDIENTE' || error.code === '23505') {
            return res.status(409).json({
                error: error.codigo ? error.message : 'Ya existe una solicitud pendiente para este alumno',
                codigo: 'SOLICITUD_CAMBIO_PUNTO_PENDIENTE',
                solicitudId: error.solicitudId
            });
        }
        console.error('Error creando solicitud de cambio de punto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

// PUT /api/padres/hijos/:alumnoId/punto-recogida
// El primer punto se guarda directo. Cambios posteriores quedan pendientes de conductor.
router.put('/hijos/:alumnoId/punto-recogida', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);
    const { parada, latitude, longitude, aplicarATodos = false, tipo = 'recogida' } = req.body;

    console.log(`[GEOPOSICIONAMIENTO] Recibida petición para alumno ${alumnoId}:`, {
        body: req.body,
        padreId
    });

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'latitude y longitude son requeridos' });
    }

    const latSolicitada = normalizarCoordenada(latitude);
    const lngSolicitada = normalizarCoordenada(longitude);
    const tipoPunto = normalizarTipoPunto(tipo);
    if (!tipoPunto) {
        return res.status(400).json({ error: 'tipo debe ser recogida o entrega' });
    }
    if (latSolicitada === null || lngSolicitada === null) {
        return res.status(400).json({ error: 'latitude y longitude deben ser numeros validos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar que el alumno pertenece al padre
        const actual = await client.query(
            `SELECT a.id, a.nombre, a.ruta_id, a.parada, a.latitude, a.longitude,
                    r.conductor_id, u.nombre AS conductor_nombre
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             LEFT JOIN rutas r ON r.id = a.ruta_id
             LEFT JOIN usuarios u ON u.id = r.conductor_id
             WHERE a.id = $1::int AND ap.padre_id = $2::int AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Alumno no encontrado para este padre' });
        }

        const conductorNombre = actual.rows[0].conductor_nombre || 'el conductor';

        // 2. Identificar qué alumnos actualizar
        let idsAActualizar = [alumnoId];
        if (aplicarATodos) {
            const otrosHijos = await client.query(
                `SELECT a.id AS alumno_id
                 FROM alumnos a
                 JOIN alumno_padres ap ON ap.alumno_id = a.id
                 WHERE ap.padre_id = $1::int AND a.activo = true`,
                [padreId]
            );
            idsAActualizar = otrosHijos.rows.map(h => h.alumno_id);
        }

        const alumnosAActualizar = aplicarATodos
            ? await client.query(
                `SELECT a.id, a.nombre, a.ruta_id, a.parada, a.latitude, a.longitude,
                        r.conductor_id, u.nombre AS conductor_nombre
                 FROM alumnos a
                 LEFT JOIN rutas r ON r.id = a.ruta_id
                 LEFT JOIN usuarios u ON u.id = r.conductor_id
                 WHERE a.id = ANY($1::int[])`,
                [idsAActualizar]
            )
            : actual;

        const paradaSolicitada = tieneTexto(parada) ? String(parada) : null;
        const paradaGenerada = `Punto ${latSolicitada.toFixed(5)}, ${lngSolicitada.toFixed(5)}`;
        const paradaNueva = paradaSolicitada || paradaGenerada;

        if (tipoPunto === 'entrega') {
            const idsEntrega = alumnosAActualizar.rows.map((alumno) => alumno.id);
            const puntosActuales = await client.query(
                `SELECT alumno_id, ruta_id, nombre_parada, latitud, longitud, orden
                 FROM puntos_ruta
                 WHERE alumno_id = ANY($1::int[])
                   AND tipo = 'entrega'`,
                [idsEntrega]
            );
            const puntosPorAlumno = new Map(puntosActuales.rows.map((punto) => [Number(punto.alumno_id), punto]));
            const directos = [];
            const solicitudesEntrega = [];

            for (const alumno of alumnosAActualizar.rows) {
                if (!alumno.conductor_id || !alumno.ruta_id) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        error: 'El punto de entrega requiere conductor asignado',
                        codigo: 'CONDUCTOR_NO_ASIGNADO',
                        alumnos: [{ id: alumno.id, nombre: alumno.nombre }]
                    });
                }

                const puntoActual = puntosPorAlumno.get(Number(alumno.id));
                if (!puntoActual) {
                    directos.push(alumno);
                    continue;
                }

                const cambiaParada = paradaSolicitada !== null && paradaSolicitada !== puntoActual.nombre_parada;
                const cambiaLatitud = !coordenadaIgual(puntoActual.latitud, latSolicitada);
                const cambiaLongitud = !coordenadaIgual(puntoActual.longitud, lngSolicitada);

                if (cambiaParada || cambiaLatitud || cambiaLongitud) {
                    const solicitud = await crearSolicitudCambioPunto(client, {
                        alumno: {
                            ...alumno,
                            parada: puntoActual.nombre_parada,
                            latitude: puntoActual.latitud,
                            longitude: puntoActual.longitud,
                        },
                        padreId,
                        paradaNueva,
                        latitudeNueva: latSolicitada,
                        longitudeNueva: lngSolicitada,
                        motivo: 'Cambio de punto de entrega solicitado por el padre desde el mapa',
                        tipo: 'entrega',
                    });
                    solicitudesEntrega.push(solicitud);
                }
            }

            const puntosGuardados = [];
            for (const alumno of directos) {
                const punto = await guardarPuntoRutaAlumno({
                    alumnoId: alumno.id,
                    rutaId: alumno.ruta_id,
                    tipo: 'entrega',
                    latitud: latSolicitada,
                    longitud: lngSolicitada,
                    orden: 2000 + Number(alumno.id),
                    nombreParada: paradaNueva,
                }, client);
                if (punto) puntosGuardados.push(punto);
            }

            await client.query('COMMIT');

            for (const alumno of directos) {
                autoNombrarRuta(alumno.ruta_id).catch(e => console.error('Error auto-nombrando:', e));
            }

            if (solicitudesEntrega.length > 0) {
                for (const solicitud of solicitudesEntrega) {
                    enviarNotificacionPush(
                        solicitud.conductor_id,
                        'Solicitud de cambio de punto',
                        'Hay un nuevo punto de entrega pendiente de autorizacion.',
                        { tipo: 'solicitud_cambio_punto_entrega', solicitudId: solicitud.id, alumnoId: solicitud.alumno_id, rutaId: solicitud.ruta_id }
                    ).catch(err => console.error('Error notificando cambio de punto al conductor:', err.message));

                    if (req.io && solicitud.ruta_id) {
                        req.io.to(`ruta:${solicitud.ruta_id}`).emit('solicitud:cambio_punto_recogida', {
                            solicitudId: solicitud.id,
                            alumnoId: solicitud.alumno_id,
                            estado: solicitud.estado,
                            tipo: 'entrega',
                        });
                    }
                }

                return res.status(202).json({
                    mensaje: puntosGuardados.length > 0
                        ? 'Puntos de entrega iniciales guardados y solicitudes de cambio enviadas'
                        : 'Solicitud de cambio de punto de entrega enviada al conductor',
                    codigo: 'CAMBIO_PUNTO_ENTREGA_PENDIENTE_APROBACION',
                    solicitudes: solicitudesEntrega,
                    puntos: puntosGuardados,
                    idsActualizados: directos.map((alumno) => alumno.id),
                    conductorNombre
                });
                }

                return res.json({
                mensaje: aplicarATodos
                    ? 'Punto de entrega actualizado para todos los hijos'
                    : 'Punto de entrega definido correctamente',
                puntos: puntosGuardados,
                idsActualizados: directos.map((alumno) => alumno.id),
                conductorNombre
                });

        }

        const aActualizarDirecto = [];
        const aCrearSolicitud = [];

        for (const alumno of alumnosAActualizar.rows) {
            const tieneGPS = alumno.latitude !== null && alumno.longitude !== null;

            if (!tieneGPS) {
                // PRIMERA VEZ: Se permite geoposicionar directamente
                aActualizarDirecto.push(alumno.id);
            } else {
                // SEGUNDA VEZ O MÁS: Requiere autorización del conductor
                const cambiaParada = paradaSolicitada !== null && tieneTexto(alumno.parada) && paradaSolicitada !== alumno.parada;
                const cambiaLatitud = !coordenadaIgual(alumno.latitude, latSolicitada);
                const cambiaLongitud = !coordenadaIgual(alumno.longitude, lngSolicitada);

                if (cambiaParada || cambiaLatitud || cambiaLongitud) {
                    aCrearSolicitud.push(alumno);
                }
            }
        }

        // 3. Procesar Cambios Bloqueados (Solicitudes)
        const solicitudesCreadas = [];
        if (aCrearSolicitud.length > 0) {
            const alumnosSinConductor = aCrearSolicitud.filter((alumno) => !alumno.conductor_id || !alumno.ruta_id);
            if (alumnosSinConductor.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: 'El cambio de punto requiere conductor asignado',
                    codigo: 'CONDUCTOR_NO_ASIGNADO',
                    alumnos: alumnosSinConductor.map((alumno) => ({
                        id: alumno.id,
                        nombre: alumno.nombre
                    }))
                });
            }

            for (const alumno of aCrearSolicitud) {
                console.log(`[GEOPOSICIONAMIENTO] Creando solicitud para alumno ${alumno.id} tipo ${tipoPunto}`);
                const solicitud = await crearSolicitudCambioPunto(client, {
                    alumno,
                    padreId,
                    paradaNueva,
                    latitudeNueva: latSolicitada,
                    longitudeNueva: lngSolicitada,
                    motivo: `Cambio de punto de ${tipoPunto} solicitado por el padre desde el mapa`,
                    tipo: tipoPunto,
                });
                solicitudesCreadas.push(solicitud);
            }
        }

        // 4. Procesar Actualizaciones Directas
        if (aActualizarDirecto.length > 0) {
            await client.query(
                `UPDATE alumnos 
                 SET parada = CASE
                        WHEN $1::text IS NOT NULL THEN $1::text
                        WHEN parada IS NULL OR BTRIM(parada) = '' THEN $2::text
                        ELSE parada
                     END,
                     latitude = COALESCE(latitude, $3::numeric),
                     longitude = COALESCE(longitude, $4::numeric)
                 WHERE id = ANY($5::int[])`,
                [paradaSolicitada, paradaGenerada, latSolicitada, lngSolicitada, aActualizarDirecto]
            );

            // Sincronizar puntos y rutas para los directos
            for (const id of aActualizarDirecto) {
                await sincronizarPuntoAlumno(id, client);
                
                const rId = await client.query('SELECT ruta_id FROM alumnos WHERE id = $1', [id]);
                if (rId.rows[0]?.ruta_id) {
                    autoNombrarRuta(rId.rows[0].ruta_id).catch(e => console.error('Error auto-nombrando:', e));
                }
            }
        }

        await client.query('COMMIT');

        // 5. Notificar y responder
        if (solicitudesCreadas.length > 0) {
            for (const solicitud of solicitudesCreadas) {
                const alumno = aCrearSolicitud.find((item) => item.id === solicitud.alumno_id);
                enviarNotificacionPush(
                    solicitud.conductor_id,
                    'Solicitud de cambio de punto',
                    `${alumno?.nombre || 'Un alumno'} tiene un nuevo punto de recogida pendiente de autorizacion.`,
                    { tipo: 'solicitud_cambio_punto_recogida', solicitudId: solicitud.id, alumnoId: solicitud.alumno_id, rutaId: solicitud.ruta_id }
                ).catch(err => console.error('Error notificando cambio de punto al conductor:', err.message));

                if (req.io && solicitud.ruta_id) {
                    req.io.to(`ruta:${solicitud.ruta_id}`).emit('solicitud:cambio_punto_recogida', {
                        solicitudId: solicitud.id,
                        alumnoId: solicitud.alumno_id,
                        estado: solicitud.estado,
                    });
                }
            }

            return res.status(202).json({
                mensaje: aActualizarDirecto.length > 0 
                    ? 'Puntos iniciales guardados y solicitudes de cambio enviadas' 
                    : 'Solicitud de cambio de punto enviada al conductor',
                codigo: 'CAMBIO_PUNTO_RECOGIDA_PENDIENTE_APROBACION',
                solicitudes: solicitudesCreadas,
                idsActualizados: aActualizarDirecto,
                conductorNombre
            });
        }

        res.json({
            mensaje: aplicarATodos 
                ? 'Punto de recogida actualizado para todos los hijos' 
                : 'Punto de recogida definido correctamente',
            idsActualizados: aActualizarDirecto,
            conductorNombre
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[GEOPOSICIONAMIENTO] Error crítico guardando punto:', {
            mensaje: error.message,
            codigo: error.codigo || error.code,
            alumnoId,
            padreId,
            stack: error.stack
        });

        if (error.codigo === 'SOLICITUD_CAMBIO_PUNTO_PENDIENTE' || error.code === '23505') {
            return res.status(409).json({
                error: error.codigo ? error.message : 'Ya existe una solicitud pendiente para este alumno',
                codigo: 'SOLICITUD_CAMBIO_PUNTO_PENDIENTE',
                solicitudId: error.solicitudId
            });
        }
        res.status(500).json({ 
            error: `Error servidor: ${error.message}`,
            detalle: error.message,
            paso: 'guardado_punto_recogida'
        });
    } finally {
        client.release();
    }
});

// POST /api/padres/hijos/:alumnoId/generar-invitacion
// Permite que un padre invite a otro usuario (ej. el otro progenitor) para seguir al mismo alumno
router.post('/hijos/:alumnoId/generar-invitacion', authenticateToken, requireRole('padre'), async (req, res) => {
    const { alumnoId } = req.params;
    try {
        // Verificar que el alumno pertenece al padre
        const check = await pool.query(
            'SELECT 1 FROM alumno_padres WHERE alumno_id = $1 AND padre_id = $2',
            [alumnoId, req.user.id]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'No tienes permiso para compartir este alumno' });
        }

        // Generar código aleatorio de 8 caracteres
        const codigo = generarCodigoAleatorio(8);

        await pool.query(
            `INSERT INTO codigos_invitacion (codigo, tipo, entidad_id, creado_por, max_usos, expira_en)
             VALUES ($1, 'padre_compartido', $2, $3, 1, NOW() + INTERVAL '48 hours')`,
            [codigo, alumnoId, req.user.id]
        );

        res.json({ 
            mensaje: 'Código de invitación generado. Válido por 48 horas.',
            codigo 
        });
    } catch (error) {
        console.error('Error generando invitación compartida:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/padres/hijos/:alumnoId/compartir-por-telefono
// Nueva forma de compartir seguimiento directamente por número de teléfono
router.post('/hijos/:alumnoId/compartir-por-telefono', authenticateToken, requireRole('padre'), async (req, res) => {
    const { alumnoId } = req.params;
    const { telefono } = req.body;

    if (!telefono) {
        return res.status(400).json({ error: 'El número de teléfono es requerido' });
    }

    // Normalizar teléfono: solo dígitos y tomar los últimos 8 (estándar SV)
    const telLimpio = String(telefono).replace(/[^\d]/g, '');
    const telNormalizado = telLimpio.length > 8 ? telLimpio.slice(-8) : telLimpio;

    if (telNormalizado.length < 8) {
        return res.status(400).json({ error: 'El número de teléfono no es válido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar que el emisor tiene permiso sobre el alumno y obtener el colegio_id
        const checkEmisor = await client.query(
            `SELECT a.colegio_id, a.nombre as alumno_nombre
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.id = $1 AND ap.padre_id = $2`,
            [alumnoId, req.user.id]
        );

        if (checkEmisor.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'No tienes permiso para compartir el seguimiento de este alumno' });
        }

        const { colegio_id, alumno_nombre } = checkEmisor.rows[0];

        // 2. Buscar al invitado por teléfono
        // Buscamos usuarios cuyo teléfono termine en el número normalizado (para mayor flexibilidad)
        const checkInvitado = await client.query(
            `SELECT id, nombre, colegio_id 
             FROM usuarios 
             WHERE (telefono LIKE $1 OR telefono = $2) AND rol = 'padre'
             LIMIT 1`,
            [`%${telNormalizado}`, telNormalizado]
        );

        if (checkInvitado.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: 'Usuario no encontrado', 
                mensaje: 'El invitado debe estar registrado en la aplicación como padre para recibir el seguimiento.' 
            });
        }

        const invitado = checkInvitado.rows[0];

        if (invitado.id === req.user.id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No puedes compartir el seguimiento contigo mismo' });
        }

        // 3. Vincular al invitado con el alumno
        await client.query(
            `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
             VALUES ($1, $2, 'compartido')
             ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
            [alumnoId, invitado.id]
        );

        // 4. Opcional: Asegurar que el invitado esté en el mismo colegio si no tiene uno
        if (colegio_id && !invitado.colegio_id) {
            await client.query(
                'UPDATE usuarios SET colegio_id = $1 WHERE id = $2',
                [colegio_id, invitado.id]
            );
        }

        await client.query('COMMIT');

        // Enviar notificación al invitado (opcional pero recomendado)
        enviarNotificacionPush(
            invitado.id,
            'Nuevo seguimiento compartido',
            `Ahora puedes seguir el transporte de ${alumno_nombre}.`,
            { tipo: 'seguimiento_compartido', alumnoId }
        ).catch(err => console.error('Error enviando notificación de compartido:', err));

        res.json({
            mensaje: `Seguimiento de ${alumno_nombre} compartido con ${invitado.nombre} correctamente.`,
            invitado: {
                id: invitado.id,
                nombre: invitado.nombre
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error compartiendo por teléfono:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

router.get('/:padreId/historial', async (req, res) => {
    const padreId = Number(req.params.padreId);

    if (!Number.isInteger(padreId)) {
        return res.status(400).json({ error: 'padreId invalido' });
    }

    try {
        const [eventosResult, colegioResult, configuracionUi] = await Promise.all([
            pool.query(
                `WITH rutas_padre AS (
                    SELECT DISTINCT a.ruta_id
                    FROM alumnos a
                    JOIN alumno_padres ap ON ap.alumno_id = a.id
                    WHERE ap.padre_id = $1
                      AND a.activo = true
                      AND a.ruta_id IS NOT NULL
                )
                SELECT
                    e.ruta_id AS "rutaId",
                    r.nombre AS "rutaNombre",
                    TO_CHAR(DATE(e.creado_en), 'YYYY-MM-DD') AS fecha,
                    e.tipo,
                    e.descripcion,
                    TO_CHAR(e.creado_en, 'HH24:MI:SS') AS hora,
                    u.nombre AS "conductorNombre"
                FROM eventos_ruta e
                INNER JOIN rutas_padre rp ON rp.ruta_id = e.ruta_id
                INNER JOIN rutas r ON r.id = e.ruta_id
                LEFT JOIN usuarios u ON u.id = e.conductor_id
                WHERE e.tipo <> 'abordado'
                ORDER BY e.creado_en DESC`,
                [padreId]
            ),
            pool.query(
                `SELECT DISTINCT
                    c.id,
                    c.nombre,
                    c.logo_url AS "logoUrl"
                 FROM alumnos a
                 JOIN alumno_padres ap ON ap.alumno_id = a.id
                 INNER JOIN rutas r ON r.id = a.ruta_id
                 INNER JOIN colegios c ON c.id = r.colegio_id
                 WHERE ap.padre_id = $1::int
                   AND a.activo = true
                 ORDER BY c.id
                 LIMIT 1`,
                [padreId]
            ),
            obtenerConfiguracionPadre(),
        ]);

        const viajesMap = new Map();

        for (const evento of eventosResult.rows) {
            const llave = `${evento.rutaId}-${evento.fecha}`;

            if (!viajesMap.has(llave)) {
                viajesMap.set(llave, {
                    rutaId: evento.rutaId,
                    rutaNombre: evento.rutaNombre,
                    fecha: evento.fecha,
                    conductorNombre: evento.conductorNombre,
                    horaInicio: null,
                    reportes: [],
                });
            }

            const viaje = viajesMap.get(llave);

            if (evento.tipo === 'inicio_ruta') {
                viaje.horaInicio = evento.hora;
                continue;
            }

            viaje.reportes.push({
                tipo: evento.tipo,
                descripcion: evento.descripcion,
                hora: evento.hora,
            });
        }

        res.json({
            historial: Array.from(viajesMap.values()),
            colegio: colegioResult.rows[0] || null,
            configuracionUi,
        });
    } catch (error) {
        console.error('Error historialPadre:', error.message);
        res.status(500).json({ error: 'Error obteniendo historial del padre' });
    }
});

module.exports = router;
