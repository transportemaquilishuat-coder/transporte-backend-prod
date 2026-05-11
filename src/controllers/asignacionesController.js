const pool = require('../database');
const { enviarNotificacionPush, enviarNotificacionAlumno } = require('../utils/notificaciones');
const { autoNombrarRuta } = require('../utils/geoNaming');
const { sincronizarPuntoAlumno } = require('../utils/rutaPuntos');

const CONFIG_UI_POR_DEFECTO = {
    mostrarAvisoAbordaje: false,
    requiereUbicacionRecogida: false,
    mostrarAvisoAusentesRuta: false,
    permitirInscripcionConductor: true,
};

const obtenerConfiguracionUi = async () => {
    const resultado = await pool.query(
        `SELECT clave, valor
         FROM configuracion
         WHERE clave = ANY($1::text[])`,
        [[
            'mostrar_aviso_abordaje',
            'requiere_ubicacion_recogida',
            'mostrar_aviso_ausentes_ruta',
            'permitir_inscripcion_conductor',
        ]]
    );

    const configuracion = { ...CONFIG_UI_POR_DEFECTO };
    for (const item of resultado.rows) {
        const valor = String(item.valor).toLowerCase() === 'true';
        if (item.clave === 'mostrar_aviso_abordaje') configuracion.mostrarAvisoAbordaje = valor;
        if (item.clave === 'requiere_ubicacion_recogida') configuracion.requiereUbicacionRecogida = valor;
        if (item.clave === 'mostrar_aviso_ausentes_ruta') configuracion.mostrarAvisoAusentesRuta = valor;
        if (item.clave === 'permitir_inscripcion_conductor') configuracion.permitirInscripcionConductor = valor;
    }

    return configuracion;
};

const obtenerOCrearRutaConductor = async (conductorId) => {
    const rutasResult = await pool.query(
        `SELECT r.id, r.nombre, r.conductor_id AS "conductorId", u.nombre AS conductor_nombre
         FROM rutas r
         LEFT JOIN usuarios u ON u.id = r.conductor_id
         WHERE r.conductor_id = $1 AND r.activa = true
         ORDER BY r.nombre`,
        [conductorId]
    );

    if (rutasResult.rows.length > 0) {
        return rutasResult.rows;
    }

    const usuario = await pool.query(
        'SELECT nombre, colegio_id FROM usuarios WHERE id = $1 AND rol = $2 AND activo = true',
        [conductorId, 'conductor']
    );

    if (usuario.rows.length === 0) {
        return null;
    }

    const conductor = usuario.rows[0];
    const nuevaRuta = await pool.query(
        `INSERT INTO rutas (nombre, conductor_id, colegio_id, activa)
         VALUES ($1, $2, $3, true)
         RETURNING id, nombre, conductor_id AS "conductorId"`,
        [`Ruta de ${conductor.nombre}`, conductorId, conductor.colegio_id]
    );

    return nuevaRuta.rows.map((ruta) => ({
        ...ruta,
        conductor_nombre: conductor.nombre,
    }));
};

exports.alumnosPorConductor = async (req, res) => {
    const conductorId = Number(req.params.conductorId);

    if (!Number.isInteger(conductorId)) {
        return res.status(400).json({ error: 'conductorId invalido' });
    }

    try {
        const configuracionUi = await obtenerConfiguracionUi();
        const rutas = await obtenerOCrearRutaConductor(conductorId);

        if (!rutas) {
            return res.status(404).json({ error: 'Conductor no encontrado' });
        }

        const alumnosResult = await pool.query(
            `SELECT
                a.id,
                a.nombre,
                a.grado,
                COALESCE(pr.ruta_id, a.ruta_id) AS "rutaId",
                COALESCE(pr.parada, a.parada) AS parada,
                COALESCE(pr.latitude, a.latitude) AS latitude,
                COALESCE(pr.longitude, a.longitude) AS longitude,
                a.orden,
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM eventos_ruta er
                        WHERE er.tipo = 'abordado'
                          AND er.descripcion = CONCAT('alumnoId:', a.id)
                          AND DATE(er.creado_en) = CURRENT_DATE
                    ) THEN 'abordado'
                    ELSE 'pendiente'
                END AS estado,
                EXISTS (
                    SELECT 1
                    FROM ausencias au
                    WHERE au.alumno_id = a.id
                      AND au.fecha = CURRENT_DATE
                ) AS ausente,
                pr.nota as "notaProgramacion",
                (pr.id IS NOT NULL) as "esCambioTemporal"
             FROM alumnos a
             LEFT JOIN LATERAL (
                SELECT * FROM programacion_rutas 
                WHERE alumno_id = a.id AND fecha = CURRENT_DATE
                ORDER BY CASE WHEN tipo = 'ambos' THEN 1 ELSE 2 END
                LIMIT 1
             ) pr ON true
             WHERE a.activo = true
               AND (
                 (pr.id IS NULL AND a.ruta_id = ANY($1::int[])) OR
                 (pr.id IS NOT NULL AND pr.ruta_id = ANY($1::int[]))
               )
            ORDER BY a.orden, a.nombre`,
            [rutas.map((ruta) => ruta.id)]
        );

        res.json({
            rutas: rutas.map((ruta) => ({
                id: ruta.id,
                nombre: ruta.nombre,
                conductorId: ruta.conductorId,
                conductor_nombre: ruta.conductor_nombre,
            })),
            alumnos: alumnosResult.rows,
            totalAlumnos: alumnosResult.rows.length,
            ausentes: alumnosResult.rows.filter((alumno) => alumno.ausente).length,
            configuracionUi,
        });
    } catch (error) {
        console.error('Error alumnosPorConductor:', error.message);
        res.status(500).json({ error: 'Error obteniendo asignaciones del conductor' });
    }
};

exports.reportarAusencia = async (req, res) => {
    const { alumnoId, padreNombre, motivo } = req.body;

    if (!alumnoId) {
        return res.status(400).json({ error: 'alumnoId es requerido' });
    }

    try {
        const alumnoResult = await pool.query(
            `SELECT a.id, a.padre_id, a.ruta_id, COALESCE(u.nombre, 'Padre') AS padre_nombre,
                    u.fecha_inicio_servicio, u.fecha_fin_servicio
             FROM alumnos a
             LEFT JOIN usuarios u ON u.id = a.padre_id
             WHERE a.id = $1`,
            [alumnoId]
        );

        if (alumnoResult.rows.length === 0) {
            return res.status(404).json({ error: 'Alumno no encontrado' });
        }

        const alumno = alumnoResult.rows[0];

        // VALIDACIÓN DE FECHAS DE SERVICIO
        const hoy = new Date();
        const inicio = alumno.fecha_inicio_servicio ? new Date(alumno.fecha_inicio_servicio) : null;
        const fin = alumno.fecha_fin_servicio ? new Date(alumno.fecha_fin_servicio) : null;

        if (inicio && hoy < inicio) {
            return res.status(403).json({ error: 'El servicio aún no ha comenzado para este periodo' });
        }
        if (fin && hoy > fin) {
            return res.status(403).json({ error: 'El servicio para este periodo ha finalizado' });
        }

        const existente = await pool.query(
            `SELECT * FROM ausencias
             WHERE alumno_id = $1 AND fecha = CURRENT_DATE`,
            [alumnoId]
        );

        if (existente.rows.length > 0) {
            return res.json({
                mensaje: 'La ausencia ya estaba reportada para hoy',
                ausencia: {
                    id: existente.rows[0].id,
                    alumnoId,
                    padreNombre: padreNombre || alumno.padre_nombre,
                    motivo: existente.rows[0].motivo,
                    fecha: existente.rows[0].fecha,
                    hora: existente.rows[0].hora,
                },
            });
        }

        const resultado = await pool.query(
            `INSERT INTO ausencias (alumno_id, padre_id, motivo, fecha, hora)
             VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME)
             RETURNING id, alumno_id, padre_id, motivo, fecha, hora`,
            [alumnoId, alumno.padre_id, motivo || 'Sin especificar']
        );

        const ausencia = resultado.rows[0];

        // Emitir evento por socket para actualización en tiempo real
        if (req.io && alumno.ruta_id) {
            req.io.to(`ruta:${alumno.ruta_id}`).emit('alumno:ausencia', {
                alumnoId,
                ausente: true,
                mensaje: `Ausencia reportada: ${alumno.nombre}`
            });
        }

        res.json({
            mensaje: 'Ausencia reportada correctamente',
            ausencia: {
                id: ausencia.id,
                alumnoId: ausencia.alumno_id,
                padreNombre: padreNombre || alumno.padre_nombre,
                motivo: ausencia.motivo,
                fecha: ausencia.fecha,
                hora: ausencia.hora,
            },
        });
    } catch (error) {
        console.error('Error reportarAusencia:', error.message);
        res.status(500).json({ error: 'Error reportando ausencia' });
    }
};

exports.ausenciasDeLaRuta = async (req, res) => {
    const rutaId = Number(req.params.rutaId);

    if (!Number.isInteger(rutaId)) {
        return res.status(400).json({ error: 'rutaId invalido' });
    }

    try {
        const resultado = await pool.query(
            `SELECT
                au.id,
                au.alumno_id AS "alumnoId",
                a.nombre AS alumno_nombre,
                au.padre_id AS "padreId",
                au.motivo,
                au.fecha,
                au.hora
             FROM ausencias au
             INNER JOIN alumnos a ON a.id = au.alumno_id
             WHERE a.ruta_id = $1
               AND au.fecha = CURRENT_DATE
             ORDER BY au.creado_en DESC`,
            [rutaId]
        );

        res.json({ ausencias: resultado.rows, total: resultado.rows.length });
    } catch (error) {
        console.error('Error ausenciasDeLaRuta:', error.message);
        res.status(500).json({ error: 'Error obteniendo ausencias de la ruta' });
    }
};

exports.marcarAbordado = async (req, res) => {
    const { alumnoId } = req.body;

    if (!alumnoId) {
        return res.status(400).json({ error: 'alumnoId es requerido' });
    }

    try {
        const alumnoResult = await pool.query(
            `SELECT id, nombre, ruta_id, padre_id
             FROM alumnos
             WHERE id = $1 AND activo = true`,
            [alumnoId]
        );

        if (alumnoResult.rows.length === 0) {
            return res.status(404).json({ error: 'Alumno no encontrado' });
        }

        const alumno = alumnoResult.rows[0];

        const eventoExistente = await pool.query(
            `SELECT id
             FROM eventos_ruta
             WHERE tipo = 'abordado'
               AND descripcion = $1
               AND DATE(creado_en) = CURRENT_DATE`,
            [`alumnoId:${alumno.id}`]
        );

        if (eventoExistente.rows.length === 0) {
            await pool.query(
                `INSERT INTO eventos_ruta (ruta_id, conductor_id, tipo, descripcion)
                 VALUES ($1, $2, 'abordado', $3)`,
                [alumno.ruta_id, null, `alumnoId:${alumno.id}`]
            );

            // Notificar a todos los padres de forma asíncrona
            enviarNotificacionAlumno(
                alumno.id,
                'Abordaje confirmado',
                `${alumno.nombre} ha subido al transporte escolar.`,
                { tipo: 'abordado', alumnoId: alumno.id }
            ).catch(err => console.error('Error notificacion abordaje:', err));

            // Emitir evento por socket para actualización en tiempo real (para el conductor y otros padres)
            if (req.io && alumno.ruta_id) {
                req.io.to(`ruta:${alumno.ruta_id}`).emit('alumno:abordado', {
                    alumnoId: alumno.id,
                    estado: 'abordado',
                    mensaje: `${alumno.nombre} ha subido al bus`
                });
            }
        }

        res.json({
            mensaje: `${alumno.nombre} marcado como abordado`,
            alumno: {
                id: alumno.id,
                nombre: alumno.nombre,
                estado: 'abordado',
            },
        });
    } catch (error) {
        console.error('Error marcarAbordado:', error.message);
        res.status(500).json({ error: 'Error marcando abordaje' });
    }
};

exports.inscribirAlumnoPorConductor = async (req, res) => {
    const conductorId = Number(req.params.conductorId);
    const {
        nombre,
        grado,
        ruta_id,
        padre_id,
        parada,
        orden,
        latitude,
        longitude,
    } = req.body;

    if (!Number.isInteger(conductorId)) {
        return res.status(400).json({ error: 'conductorId invalido' });
    }

    if (!nombre || !ruta_id) {
        return res.status(400).json({ error: 'nombre y ruta_id son requeridos' });
    }

    try {
        const configuracionUi = await obtenerConfiguracionUi();
        if (!configuracionUi.permitirInscripcionConductor) {
            return res.status(403).json({ error: 'La inscripcion de alumnos por conductor esta deshabilitada' });
        }

        const rutaResult = await pool.query(
            `SELECT id, nombre
             FROM rutas
             WHERE id = $1 AND conductor_id = $2 AND activa = true`,
            [ruta_id, conductorId]
        );

        if (rutaResult.rows.length === 0) {
            return res.status(403).json({ error: 'El conductor no tiene permisos sobre esta ruta' });
        }

        const resultado = await pool.query(
            `INSERT INTO alumnos (nombre, grado, ruta_id, padre_id, parada, latitude, longitude, orden)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, nombre, grado, ruta_id AS "rutaId", padre_id AS "padreId", parada, latitude, longitude, orden, activo, creado_en`,
            [
                nombre,
                grado ?? null,
                ruta_id,
                padre_id ?? null,
                parada ?? null,
                latitude ?? null,
                longitude ?? null,
                orden ?? null,
            ]
        );

        if (padre_id) {
            await pool.query(
                `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
                 VALUES ($1, $2, 'principal')
                 ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
                [resultado.rows[0].id, padre_id]
            );
        }

        await sincronizarPuntoAlumno(resultado.rows[0].id);

        // Auto-nombrar ruta basado en la geoposición de los alumnos
        autoNombrarRuta(ruta_id).catch(err => console.error('Error auto-nombrando ruta:', err));

        res.status(201).json({
            mensaje: 'Alumno inscrito correctamente por el conductor',
            alumno: resultado.rows[0],
            ruta: rutaResult.rows[0],
        });
    } catch (error) {
        console.error('Error inscribirAlumnoPorConductor:', error.message);
        res.status(500).json({ error: 'Error inscribiendo alumno para el conductor' });
    }
};
