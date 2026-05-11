const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { autoNombrarRuta } = require('../utils/geoNaming');
const { sincronizarPuntoAlumno } = require('../utils/rutaPuntos');

const CONFIG_UI_POR_DEFECTO = {
    mostrarTotalAlumnosHistorial: false,
    mostrarLogoColegioInicio: true,
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
                    AND er.descripcion = 'alumnoId:' || a.id 
                    AND DATE(er.creado_en) = CURRENT_DATE
                ) as abordado,
                (pr.id IS NOT NULL) as "tieneProgramacionHoy"
            FROM alumnos a
            JOIN alumno_padres ap ON ap.alumno_id = a.id
            LEFT JOIN LATERAL (
                SELECT * FROM programacion_rutas 
                WHERE alumno_id = a.id AND fecha = CURRENT_DATE
                ORDER BY CASE WHEN tipo = 'ambos' THEN 1 ELSE 2 END
                LIMIT 1
            ) pr ON true
            LEFT JOIN rutas r ON r.id = a.ruta_id
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

// PUT /api/padres/hijos/:alumnoId/punto-recogida
// El padre fija el punto una sola vez. Cambios posteriores deben gestionarse con conductor/admin.
router.put('/hijos/:alumnoId/punto-recogida', authenticateToken, requireRole('padre'), async (req, res) => {
    const padreId = req.user.id;
    const alumnoId = Number(req.params.alumnoId);
    const { parada, latitude, longitude } = req.body;

    if (!Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'alumnoId invalido' });
    }

    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'latitude y longitude son requeridos' });
    }

    try {
        const actual = await pool.query(
            `SELECT a.id, a.nombre, a.ruta_id, a.latitude, a.longitude
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.id = $1
               AND ap.padre_id = $2
               AND a.activo = true`,
            [alumnoId, padreId]
        );

        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Alumno no encontrado para este padre' });
        }

        const alumno = actual.rows[0];

        if (alumno.latitude !== null && alumno.longitude !== null) {
            return res.status(409).json({
                error: 'El punto de recogida ya fue definido. Para cambiarlo, notifica al conductor.',
            });
        }

        const resultado = await pool.query(
            `UPDATE alumnos
             SET parada = $1,
                 latitude = $2,
                 longitude = $3
             WHERE id = $4
             RETURNING id, nombre, grado, ruta_id AS "rutaId", padre_id AS "padreId", parada, latitude, longitude, orden, activo`,
            [parada || `Punto ${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`, latitude, longitude, alumnoId]
        );

        await sincronizarPuntoAlumno(alumnoId);

        if (alumno.ruta_id) {
            autoNombrarRuta(alumno.ruta_id).catch(err => console.error('Error auto-nombrando ruta:', err));
        }

        res.json({
            mensaje: 'Punto de recogida definido',
            alumno: resultado.rows[0],
        });
    } catch (error) {
        console.error('Error guardando punto de recogida:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
        const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let codigo = '';
        for (let i = 0; i < 8; i++) {
            codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
        }

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
