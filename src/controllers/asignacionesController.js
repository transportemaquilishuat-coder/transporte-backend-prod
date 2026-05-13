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
    const { turno, turno_estudio, turnoEstudio } = req.query; 

    if (!Number.isInteger(conductorId)) {
        return res.status(400).json({ error: 'conductorId invalido' });
    }

    try {
        const configuracionUi = await obtenerConfiguracionUi();
        const rutas = await obtenerOCrearRutaConductor(conductorId);

        if (!rutas) {
            return res.status(404).json({ error: 'Conductor no encontrado' });
        }

        const rutasIds = rutas.map((ruta) => ruta.id);

        const turnoRaw = turno_estudio || turnoEstudio || turno;
        const turnoMapeado = (turnoRaw === 'mañana') ? 'matutino' : (turnoRaw === 'tarde') ? 'vespertino' : (turnoRaw || null);

        // Ajustar la consulta para considerar el turno si se proporciona
        // El turno filtra tanto la ruta base como los cambios programados
        const alumnosResult = await pool.query(
            `SELECT
                a.id,
                a.nombre,
                a.grado,
                a.turno_estudio,
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
                      AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
                ) AS ausente,
                pr.nota as "notaProgramacion",
                (pr.id IS NOT NULL) as "esCambioTemporal",
                pr.tipo as "turnoProgramado"
             FROM alumnos a
             LEFT JOIN LATERAL (
                SELECT * FROM programacion_rutas 
                WHERE alumno_id = a.id AND fecha = CURRENT_DATE
                AND ($2::text IS NULL OR tipo = $2 OR tipo = 'ambos')
                ORDER BY CASE WHEN tipo = 'ambos' THEN 2 ELSE 1 END
                LIMIT 1
             ) pr ON true
             WHERE a.activo = true
               AND (
                 (pr.id IS NULL AND a.ruta_id = ANY($1::int[])) OR
                 (pr.id IS NOT NULL AND pr.ruta_id = ANY($1::int[]))
               )
               AND ($2::text IS NULL OR a.turno_estudio = $2)
            ORDER BY a.orden, a.nombre`,
            [rutasIds, turnoMapeado]
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
            turnoActual: turnoMapeado || 'todos'
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
        padreEmail,
        parada,
        orden,
        latitude,
        longitude,
        turno_estudio,
        turnoEstudio,
    } = req.body;
    const conductorId = Number(req.params.conductorId);

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
            `SELECT id, nombre, colegio_id
             FROM rutas
             WHERE id = $1 AND conductor_id = $2 AND activa = true`,
            [ruta_id, conductorId]
        );

        if (rutaResult.rows.length === 0) {
            return res.status(403).json({ error: 'El conductor no tiene permisos sobre esta ruta' });
        }

        const colegioId = rutaResult.rows[0].colegio_id;

        // Intentar vincular por email si se proporciona
        let padreIdFinal = padre_id || null;
        const emailNormalizado = padreEmail ? String(padreEmail).trim().toLowerCase() : null;

        if (!padreIdFinal && emailNormalizado) {
            const padreRes = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = $1 AND rol = $2', [emailNormalizado, 'padre']);
            if (padreRes.rows.length > 0) {
                padreIdFinal = padreRes.rows[0].id;
            }
        }

        const turnoRaw = turno_estudio || turnoEstudio || 'matutino';
        const turnoMapeado = (turnoRaw === 'mañana') ? 'matutino' : (turnoRaw === 'tarde') ? 'vespertino' : turnoRaw;

        const resultado = await pool.query(
            `INSERT INTO alumnos (nombre, grado, ruta_id, padre_id, padre_email, parada, latitude, longitude, orden, turno_estudio, colegio_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, nombre, grado, ruta_id AS "rutaId", padre_id AS "padreId", padre_email AS "padreEmail", parada, latitude, longitude, orden, activo, creado_en, turno_estudio`,
            [
                nombre,
                grado ?? null,
                ruta_id,
                padreIdFinal,
                emailNormalizado,
                parada ?? null,
                latitude ?? null,
                longitude ?? null,
                orden ?? null,
                turnoMapeado,
                colegioId
            ]
        );

        if (padreIdFinal) {
            await pool.query(
                `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
                 VALUES ($1, $2, 'principal')
                 ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
                [resultado.rows[0].id, padreIdFinal]
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

exports.reportarAusenciaMultiple = async (req, res) => {
    const { alumnosIds, motivo, dias = 1 } = req.body;

    if (!Array.isArray(alumnosIds) || alumnosIds.length === 0) {
        return res.status(400).json({ error: 'alumnosIds debe ser un array no vacío' });
    }

    try {
        const idsValidos = alumnosIds.filter(id => Number.isInteger(Number(id)));
        if (idsValidos.length === 0) return res.status(400).json({ error: 'IDs invalidos' });

        const fechaInicio = new Date();
        const fechaFin = new Date();
        fechaFin.setDate(fechaFin.getDate() + (Number(dias) - 1));

        const resultados = [];
        for (const alumnoId of idsValidos) {
            // Verificar existencia
            const alumnoRes = await pool.query('SELECT padre_id, ruta_id, nombre FROM alumnos WHERE id = $1', [alumnoId]);
            if (alumnoRes.rows.length === 0) continue;

            const alumno = alumnoRes.rows[0];

            // Insertar o actualizar ausencia
            const resIns = await pool.query(
                `INSERT INTO ausencias (alumno_id, padre_id, motivo, fecha, fecha_fin, hora)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIME)
                 RETURNING *`,
                [alumnoId, alumno.padre_id, motivo || 'Ausencia múltiple', fechaInicio, fechaFin]
            );

            resultados.push({
                alumnoId,
                nombre: alumno.nombre,
                fechaInicio,
                fechaFin
            });

            // Emitir por socket si aplica
            if (req.io && alumno.ruta_id) {
                req.io.to(`ruta:${alumno.ruta_id}`).emit('alumno:ausencia', {
                    alumnoId,
                    ausente: true,
                    mensaje: `Ausencia programada: ${alumno.nombre} (${dias} días)`
                });
            }
        }

        res.json({
            mensaje: `Ausencia reportada para ${resultados.length} alumnos por ${dias} días`,
            detalles: resultados
        });
    } catch (error) {
        console.error('Error reportarAusenciaMultiple:', error.message);
        res.status(500).json({ error: 'Error reportando ausencias múltiples' });
    }
};

exports.desvincularAlumnoPorConductor = async (req, res) => {
    const conductorId = Number(req.params.conductorId);
    const alumnoId = Number(req.params.alumnoId);

    if (!Number.isInteger(conductorId) || !Number.isInteger(alumnoId)) {
        return res.status(400).json({ error: 'IDs invalidos' });
    }

    try {
        // 1. Verificar que el alumno pertenece a una ruta del conductor
        const checkResult = await pool.query(
            `SELECT a.id, a.nombre, a.ruta_id
             FROM alumnos a
             JOIN rutas r ON r.id = a.ruta_id
             WHERE a.id = $1 AND r.conductor_id = $2 AND a.activo = true`,
            [alumnoId, conductorId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(403).json({ error: 'No tienes permiso para desvincular a este alumno o no pertenece a tu ruta' });
        }

        const alumno = checkResult.rows[0];
        const rutaId = alumno.ruta_id;

        // 2. Desvincular (quitar ruta_id)
        await pool.query(
            'UPDATE alumnos SET ruta_id = NULL WHERE id = $1',
            [alumnoId]
        );

        // 3. Sincronizar y auto-nombrar ruta
        if (rutaId) {
            autoNombrarRuta(rutaId).catch(err => console.error('Error auto-nombrando ruta tras desvincular:', err));
        }

        res.json({
            mensaje: `Alumno ${alumno.nombre} desvinculado de la ruta correctamente`,
            alumnoId
        });
    } catch (error) {
        console.error('Error desvincularAlumnoPorConductor:', error.message);
        res.status(500).json({ error: 'Error desvinculando alumno' });
    }
};
