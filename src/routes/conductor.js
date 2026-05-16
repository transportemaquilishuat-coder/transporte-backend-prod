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

module.exports = router;
