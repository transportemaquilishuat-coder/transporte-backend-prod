const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { enviarNotificacionAlumno } = require('../utils/notificaciones');
const { guardarPuntoRutaAlumno, sincronizarPuntoAlumno } = require('../utils/rutaPuntos');
const { autoNombrarRuta } = require('../utils/geoNaming');

const mapSolicitud = (row) => ({
    id: row.id,
    alumnoId: row.alumno_id,
    alumnoNombre: row.alumno_nombre,
    padreId: row.padre_id,
    padreNombre: row.padre_nombre,
    conductorId: row.conductor_id,
    rutaId: row.ruta_id,
    rutaNombre: row.ruta_nombre,
    puntoActual: {
        parada: row.parada_actual,
        latitude: row.latitude_actual,
        longitude: row.longitude_actual,
    },
    puntoNuevo: {
        parada: row.parada_nueva,
        latitude: row.latitude_nueva,
        longitude: row.longitude_nueva,
    },
    estado: row.estado,
    tipo: row.tipo || 'recogida',
    motivo: row.motivo,
    respuestaConductor: row.respuesta_conductor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondidoAt: row.respondido_at,
});

// GET /api/conductor/solicitudes-cambio-punto-recogida
// Lista solicitudes del conductor autenticado, pendientes por defecto.
router.get('/solicitudes-cambio-punto-recogida', authenticateToken, requireRole('conductor'), async (req, res) => {
    const conductorId = req.user.id;
    const estado = req.query.estado || 'pendiente';

    if (!['pendiente', 'aprobado', 'rechazado', 'todos'].includes(estado)) {
        return res.status(400).json({ error: 'estado invalido' });
    }

    try {
        const resultado = await pool.query(
            `SELECT s.*,
                    a.nombre AS alumno_nombre,
                    p.nombre AS padre_nombre,
                    r.nombre AS ruta_nombre
             FROM solicitudes_cambio_punto_recogida s
             INNER JOIN alumnos a ON a.id = s.alumno_id
             INNER JOIN usuarios p ON p.id = s.padre_id
             LEFT JOIN rutas r ON r.id = s.ruta_id
             WHERE s.conductor_id = $1
               AND ($2::text = 'todos' OR s.estado = $2)
             ORDER BY s.created_at DESC`,
            [conductorId, estado]
        );

        res.json({
            solicitudes: resultado.rows.map(mapSolicitud),
            total: resultado.rows.length,
        });
    } catch (error) {
        console.error('Error listando solicitudes de cambio de punto:', error.message);
        res.status(500).json({ error: 'Error obteniendo solicitudes de cambio de punto' });
    }
});

// POST /api/conductor/solicitudes-cambio-punto-recogida/:solicitudId/aprobar
router.post('/solicitudes-cambio-punto-recogida/:solicitudId/aprobar', authenticateToken, requireRole('conductor'), async (req, res) => {
    const conductorId = req.user.id;
    const solicitudId = Number(req.params.solicitudId);
    const { respuesta_conductor, respuestaConductor } = req.body || {};

    if (!Number.isInteger(solicitudId)) {
        return res.status(400).json({ error: 'solicitudId invalido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const solicitudRes = await client.query(
            `SELECT s.*, a.nombre AS alumno_nombre
             FROM solicitudes_cambio_punto_recogida s
             INNER JOIN alumnos a ON a.id = s.alumno_id
             WHERE s.id = $1
               AND s.conductor_id = $2
               AND s.estado = 'pendiente'
             FOR UPDATE`,
            [solicitudId, conductorId]
        );

        if (solicitudRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Solicitud pendiente no encontrada para este conductor' });
        }

        const solicitud = solicitudRes.rows[0];
        const tipoPunto = solicitud.tipo || 'recogida';

        if (tipoPunto === 'entrega') {
            await guardarPuntoRutaAlumno({
                alumnoId: solicitud.alumno_id,
                rutaId: solicitud.ruta_id,
                tipo: 'entrega',
                latitud: solicitud.latitude_nueva,
                longitud: solicitud.longitude_nueva,
                orden: 2000 + Number(solicitud.alumno_id),
                nombreParada: solicitud.parada_nueva,
            }, client);
        } else {
            await client.query(
                `UPDATE alumnos
                 SET parada = $1,
                     latitude = $2,
                     longitude = $3
                 WHERE id = $4`,
                [
                    solicitud.parada_nueva,
                    solicitud.latitude_nueva,
                    solicitud.longitude_nueva,
                    solicitud.alumno_id,
                ]
            );

            await sincronizarPuntoAlumno(solicitud.alumno_id, client);
        }

        const aprobada = await client.query(
            `UPDATE solicitudes_cambio_punto_recogida
             SET estado = 'aprobado',
                 respuesta_conductor = COALESCE($1, respuesta_conductor),
                 updated_at = NOW(),
                 respondido_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [respuesta_conductor || respuestaConductor || null, solicitudId]
        );

        await client.query('COMMIT');

        autoNombrarRuta(solicitud.ruta_id)
            .catch(err => console.error('Error auto-nombrando punto aprobado:', err.message));

        enviarNotificacionAlumno(
            solicitud.alumno_id,
            'Cambio de punto aprobado',
            `El conductor aprobo el nuevo punto de recogida de ${solicitud.alumno_nombre}.`,
            { tipo: 'cambio_punto_recogida_aprobado', solicitudId, alumnoId: solicitud.alumno_id, rutaId: solicitud.ruta_id }
        ).catch(err => console.error('Error notificando aprobacion al padre:', err.message));

        if (req.io && solicitud.ruta_id) {
            req.io.to(`ruta:${solicitud.ruta_id}`).emit('solicitud:cambio_punto_recogida_resuelta', {
                solicitudId,
                alumnoId: solicitud.alumno_id,
                estado: 'aprobado',
            });
        }

        res.json({
            mensaje: 'Cambio de punto de recogida aprobado correctamente',
            solicitud: aprobada.rows[0],
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error aprobando solicitud de cambio de punto:', error.message);
        res.status(500).json({ error: 'Error aprobando solicitud de cambio de punto' });
    } finally {
        client.release();
    }
});

// POST /api/conductor/solicitudes-cambio-punto-recogida/:solicitudId/rechazar
router.post('/solicitudes-cambio-punto-recogida/:solicitudId/rechazar', authenticateToken, requireRole('conductor'), async (req, res) => {
    const conductorId = req.user.id;
    const solicitudId = Number(req.params.solicitudId);
    const { respuesta_conductor, respuestaConductor } = req.body || {};

    if (!Number.isInteger(solicitudId)) {
        return res.status(400).json({ error: 'solicitudId invalido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const solicitudRes = await client.query(
            `SELECT s.*, a.nombre AS alumno_nombre
             FROM solicitudes_cambio_punto_recogida s
             INNER JOIN alumnos a ON a.id = s.alumno_id
             WHERE s.id = $1
               AND s.conductor_id = $2
               AND s.estado = 'pendiente'
             FOR UPDATE`,
            [solicitudId, conductorId]
        );

        if (solicitudRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Solicitud pendiente no encontrada para este conductor' });
        }

        const solicitud = solicitudRes.rows[0];
        const rechazada = await client.query(
            `UPDATE solicitudes_cambio_punto_recogida
             SET estado = 'rechazado',
                 respuesta_conductor = COALESCE($1, respuesta_conductor),
                 updated_at = NOW(),
                 respondido_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [respuesta_conductor || respuestaConductor || null, solicitudId]
        );

        await client.query('COMMIT');

        enviarNotificacionAlumno(
            solicitud.alumno_id,
            'Cambio de punto rechazado',
            `El conductor rechazo el cambio de punto de ${solicitud.alumno_nombre}. Coordina directamente con el conductor.`,
            { tipo: 'cambio_punto_recogida_rechazado', solicitudId, alumnoId: solicitud.alumno_id, rutaId: solicitud.ruta_id }
        ).catch(err => console.error('Error notificando rechazo al padre:', err.message));

        if (req.io && solicitud.ruta_id) {
            req.io.to(`ruta:${solicitud.ruta_id}`).emit('solicitud:cambio_punto_recogida_resuelta', {
                solicitudId,
                alumnoId: solicitud.alumno_id,
                estado: 'rechazado',
            });
        }

        res.json({
            mensaje: 'Cambio de punto de recogida rechazado correctamente',
            solicitud: rechazada.rows[0],
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rechazando solicitud de cambio de punto:', error.message);
        res.status(500).json({ error: 'Error rechazando solicitud de cambio de punto' });
    } finally {
        client.release();
    }
});

// GET /api/conductor/ausencias-pendientes
router.get('/ausencias-pendientes', authenticateToken, requireRole('conductor'), async (req, res) => {
    const conductorId = req.user.id;
    try {
        const resultado = await pool.query(
            `SELECT au.*, a.nombre AS alumno_nombre, p.nombre AS padre_nombre
             FROM ausencias au
             JOIN alumnos a ON a.id = au.alumno_id
             JOIN usuarios p ON p.id = au.padre_id
             JOIN rutas r ON r.id = a.ruta_id
             WHERE r.conductor_id = $1 AND au.estado = 'pendiente' AND au.fecha >= CURRENT_DATE
             ORDER BY au.fecha ASC`,
            [conductorId]
        );
        res.json({ ausencias: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo ausencias pendientes' });
    }
});

// POST /api/conductor/ausencias/:id/responder
router.post('/ausencias/:id/responder', authenticateToken, requireRole('conductor'), async (req, res) => {
    const { id } = req.params;
    const { estado, respuesta_conductor } = req.body; // 'autorizado' o 'rechazado'

    if (!['autorizado', 'rechazado'].includes(estado)) {
        return res.status(400).json({ error: 'estado invalido' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE ausencias
             SET estado = $1, respuesta_conductor = $2, respondido_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [estado, respuesta_conductor || null, id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Ausencia no encontrada' });
        }

        const ausencia = resultado.rows[0];
        enviarNotificacionAlumno(
            ausencia.alumno_id,
            `Ausencia ${estado}`,
            `El conductor ha ${estado} el reporte de ausencia para el dia ${ausencia.fecha}.`
        ).catch(() => {});

        res.json({ mensaje: `Ausencia ${estado}`, ausencia });
    } catch (error) {
        res.status(500).json({ error: 'Error respondiendo a la ausencia' });
    }
});

// GET /api/conductor/programaciones-pendientes
router.get('/programaciones-pendientes', authenticateToken, requireRole('conductor'), async (req, res) => {
    const conductorId = req.user.id;
    try {
        const resultado = await pool.query(
            `SELECT pr.*, a.nombre AS alumno_nombre, p.nombre AS padre_nombre, r_dest.nombre as ruta_destino_nombre
             FROM programacion_rutas pr
             JOIN alumnos a ON a.id = pr.alumno_id
             JOIN usuarios p ON p.id = pr.creado_por
             LEFT JOIN rutas r_dest ON r_dest.id = pr.ruta_id
             -- Se asume que el conductor actual es el de la ruta original del alumno o el de la ruta destino
             LEFT JOIN rutas r_orig ON r_orig.id = a.ruta_id
             WHERE (r_orig.conductor_id = $1 OR r_dest.conductor_id = $1)
               AND pr.estado = 'pendiente' AND pr.fecha >= CURRENT_DATE
             ORDER BY pr.fecha ASC`,
            [conductorId]
        );
        res.json({ programaciones: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo programaciones pendientes' });
    }
});

// POST /api/conductor/programaciones/:id/responder
router.post('/programaciones/:id/responder', authenticateToken, requireRole('conductor'), async (req, res) => {
    const { id } = req.params;
    const { estado, respuesta_conductor } = req.body; // 'aprobado' o 'rechazado'

    if (!['aprobado', 'rechazado'].includes(estado)) {
        return res.status(400).json({ error: 'estado invalido' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE programacion_rutas
             SET estado = $1, respuesta_conductor = $2, respondido_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [estado, respuesta_conductor || null, id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Programacion no encontrada' });
        }

        const pr = resultado.rows[0];
        enviarNotificacionAlumno(
            pr.alumno_id,
            `Cambio de ruta ${estado}`,
            `El conductor ha ${estado} el cambio de ruta para el dia ${pr.fecha}.`
        ).catch(() => {});

        res.json({ mensaje: `Programacion ${estado}`, programacion: pr });
    } catch (error) {
        res.status(500).json({ error: 'Error respondiendo a la programacion' });
    }
});

module.exports = router;
