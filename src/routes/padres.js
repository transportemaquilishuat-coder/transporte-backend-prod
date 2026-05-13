const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { autoNombrarRuta } = require('../utils/geoNaming');
const { sincronizarPuntoAlumno } = require('../utils/rutaPuntos');
const { generarCodigoAleatorio } = require('../utils/codigos');

const CONFIG_UI_POR_DEFECTO = {
    mostrarTotalAlumnosHistorial: false,
    mostrarLogoColegioInicio: true,
};

const tieneTexto = (valor) => valor !== null && valor !== undefined && String(valor).trim() !== '';
const coordenadaIgual = (actual, nueva) => {
    if (actual === null || actual === undefined || nueva === null || nueva === undefined) return false;
    return Math.abs(Number(actual) - Number(nueva)) < 0.000001;
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
                COALESCE(a.colegio_nombre, c_fix.nombre) as "colegioNombre",
                COALESCE(pr.parada, a.parada) as parada, 
                COALESCE(pr.latitude, a.latitude) as latitude, 
                COALESCE(pr.longitude, a.longitude) as longitude,
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
                -- Promedios semanales (HH:MM) - Usamos intervalos para promediar tiempos en Postgres
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
                ORDER BY CASE WHEN tipo = 'ambos' THEN 1 ELSE 2 END
                LIMIT 1
            ) pr ON true
            LEFT JOIN rutas r ON r.id = a.ruta_id
            LEFT JOIN colegios c_fix ON c_fix.id = a.colegio_id
            LEFT JOIN usuarios u ON u.id = r.conductor_id
            LEFT JOIN rutas nr ON nr.id = pr.ruta_id
            LEFT JOIN usuarios nu ON nu.id = nr.conductor_id
            WHERE ap.padre_id = $1 AND a.activo = true
            ORDER BY a.nombre`,
            [padreId]
        );

        res.json({ hijos: resultado.rows });
    } catch (error) {
        console.error('Error obteniendo hijos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

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
             WHERE a.id = $1 AND ap.padre_id = $2 AND a.activo = true`,
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
             SET nombre = COALESCE($1, nombre),
                 grado = COALESCE($2, grado),
                 colegio_nombre = COALESCE($3, colegio_nombre),
                 parada = CASE
                    WHEN (parada IS NULL OR BTRIM(parada) = '') AND $4 IS NOT NULL THEN $4
                    ELSE parada
                 END
             WHERE id = $5
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

// PUT /api/padres/hijos/:alumnoId/punto-recogida
// El padre fija el punto una sola vez. Cambios posteriores deben gestionarse con conductor/admin.
router.put('/hijos/:alumnoId/punto-recogida', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);
    const { parada, latitude, longitude, aplicarATodos = false } = req.body;

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'latitude y longitude son requeridos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar que el alumno pertenece al padre
        const actual = await client.query(
            `SELECT a.id, a.nombre, a.ruta_id, a.parada, a.latitude, a.longitude
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.id = $1 AND ap.padre_id = $2 AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Alumno no encontrado para este padre' });
        }

        // 2. Identificar qué alumnos actualizar
        let idsAActualizar = [alumnoId];
        if (aplicarATodos) {
            const otrosHijos = await client.query(
                `SELECT a.id AS alumno_id
                 FROM alumnos a
                 JOIN alumno_padres ap ON ap.alumno_id = a.id
                 WHERE ap.padre_id = $1 AND a.activo = true`,
                [padreId]
            );
            idsAActualizar = otrosHijos.rows.map(h => h.alumno_id);
        }

        const paradaSolicitada = tieneTexto(parada) ? String(parada) : null;
        const paradaGenerada = `Punto ${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;

        const alumnosAActualizar = aplicarATodos
            ? await client.query(
                `SELECT id, nombre, parada, latitude, longitude
                 FROM alumnos
                 WHERE id = ANY($1::int[])`,
                [idsAActualizar]
            )
            : actual;

        const cambiosBloqueados = alumnosAActualizar.rows.filter((alumno) => {
            const cambiaParada = paradaSolicitada !== null && tieneTexto(alumno.parada) && paradaSolicitada !== alumno.parada;
            const cambiaLatitud = alumno.latitude !== null && !coordenadaIgual(alumno.latitude, latitude);
            const cambiaLongitud = alumno.longitude !== null && !coordenadaIgual(alumno.longitude, longitude);
            return cambiaParada || cambiaLatitud || cambiaLongitud;
        });

        if (cambiosBloqueados.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'El cambio de punto de recogida requiere coordinacion con el conductor',
                codigo: 'CAMBIO_PUNTO_RECOGIDA_REQUIERE_APROBACION',
                mensaje: 'La primera configuracion de direccion y geoposicion no requiere aprobacion. Para modificar un punto ya definido, coordina el cambio con el conductor.',
                alumnos: cambiosBloqueados.map((alumno) => ({
                    id: alumno.id,
                    nombre: alumno.nombre
                }))
            });
        }

        // 3. Actualizar alumnos
        await client.query(
            `UPDATE alumnos 
             SET parada = CASE
                    WHEN $1 IS NOT NULL THEN $1
                    WHEN parada IS NULL OR BTRIM(parada) = '' THEN $2
                    ELSE parada
                 END,
                 latitude = COALESCE(latitude, $3),
                 longitude = COALESCE(longitude, $4)
             WHERE id = ANY($5::int[])`,
            [paradaSolicitada, paradaGenerada, latitude, longitude, idsAActualizar]
        );

        // 4. Sincronizar puntos y rutas
        for (const id of idsAActualizar) {
            await sincronizarPuntoAlumno(id);
            
            // Obtener ruta_id para auto-nombrar
            const rId = await client.query('SELECT ruta_id FROM alumnos WHERE id = $1', [id]);
            if (rId.rows[0]?.ruta_id) {
                autoNombrarRuta(rId.rows[0].ruta_id).catch(e => console.error('Error auto-nombrando:', e));
            }
        }

        await client.query('COMMIT');

        res.json({
            mensaje: aplicarATodos 
                ? 'Punto de recogida actualizado para todos los hijos' 
                : 'Punto de recogida definido correctamente',
            idsActualizados: idsAActualizar
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error guardando punto de recogida:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
                 WHERE ap.padre_id = $1
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
