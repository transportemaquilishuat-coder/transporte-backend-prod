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

const alumnosPorConductor = async (req, res) => {
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

const reportarAusencia = async (req, res) => {
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
        const hoy = new Date();
        const inicio = alumno.fecha_inicio_servicio ? new Date(alumno.fecha_inicio_servicio) : null;
        const fin = alumno.fecha_fin_servicio ? new Date(alumno.fecha_fin_servicio) : null;

        if (inicio && hoy < inicio) return res.status(403).json({ error: 'El servicio aún no ha comenzado' });
        if (fin && hoy > fin) return res.status(403).json({ error: 'El servicio ha finalizado' });

        const existente = await pool.query(
            `SELECT * FROM ausencias WHERE alumno_id = $1 AND fecha = CURRENT_DATE`,
            [alumnoId]
        );

        if (existente.rows.length > 0) {
            return res.json({ mensaje: 'Ya reportado', ausencia: existente.rows[0] });
        }

        const resultado = await pool.query(
            `INSERT INTO ausencias (alumno_id, padre_id, motivo, fecha, hora)
             VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME)
             RETURNING *`,
            [alumnoId, alumno.padre_id, motivo || 'Sin especificar']
        );

        if (req.io && alumno.ruta_id) {
            req.io.to(`ruta:${alumno.ruta_id}`).emit('alumno:ausencia', { alumnoId, ausente: true });
        }

        res.json({ mensaje: 'Ausencia reportada', ausencia: resultado.rows[0] });
    } catch (error) {
        console.error('Error reportarAusencia:', error.message);
        res.status(500).json({ error: 'Error reportando ausencia' });
    }
};

const ausenciasDeLaRuta = async (req, res) => {
    const rutaId = Number(req.params.rutaId);
    if (!Number.isInteger(rutaId)) return res.status(400).json({ error: 'rutaId invalido' });

    try {
        const resultado = await pool.query(
            `SELECT au.*, a.nombre AS alumno_nombre
             FROM ausencias au
             INNER JOIN alumnos a ON a.id = au.alumno_id
             WHERE a.ruta_id = $1 AND au.fecha = CURRENT_DATE`,
            [rutaId]
        );
        res.json({ ausencias: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
};

const marcarAbordado = async (req, res) => {
    const { alumnoId } = req.body;
    if (!alumnoId) return res.status(400).json({ error: 'alumnoId requerido' });

    try {
        const alumnoResult = await pool.query('SELECT id, nombre, ruta_id FROM alumnos WHERE id = $1', [alumnoId]);
        if (alumnoResult.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const alumno = alumnoResult.rows[0];

        await pool.query(
            `INSERT INTO eventos_ruta (ruta_id, tipo, descripcion)
             VALUES ($1, 'abordado', $2)`,
            [alumno.ruta_id, `alumnoId:${alumno.id}`]
        );

        enviarNotificacionAlumno(alumno.id, 'Abordaje confirmado', `${alumno.nombre} ha subido.`).catch(() => {});

        if (req.io && alumno.ruta_id) {
            req.io.to(`ruta:${alumno.ruta_id}`).emit('alumno:abordado', { alumnoId: alumno.id });
        }
        res.json({ mensaje: 'Marcado como abordado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
};

const inscribirAlumnoPorConductor = async (req, res) => {
    const conductorId = Number(req.params.conductorId);
    const { nombre, grado, ruta_id, padreEmail, parada, turnoEstudio } = req.body;

    try {
        const rutaResult = await pool.query('SELECT id, colegio_id FROM rutas WHERE id = $1 AND conductor_id = $2', [ruta_id, conductorId]);
        if (rutaResult.rows.length === 0) return res.status(403).json({ error: 'Sin permiso' });

        const emailNormalizado = padreEmail ? String(padreEmail).trim().toLowerCase() : null;
        let padreId = null;
        if (emailNormalizado) {
            const p = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = $1 AND rol = $2', [emailNormalizado, 'padre']);
            padreId = p.rows[0]?.id || null;
        }

        const resultado = await pool.query(
            `INSERT INTO alumnos (nombre, grado, ruta_id, padre_id, padre_email, parada, colegio_id, turno_estudio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [nombre, grado, ruta_id, padreId, emailNormalizado, parada, rutaResult.rows[0].colegio_id, turnoEstudio || 'matutino']
        );

        if (padreId) {
            await pool.query('INSERT INTO alumno_padres (alumno_id, padre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [resultado.rows[0].id, padreId]);
        }

        res.status(201).json({ mensaje: 'Inscrito', id: resultado.rows[0].id });
    } catch (error) { res.status(500).json({ error: error.message }); }
};

const reportarAusenciaMultiple = async (req, res) => {
    const { alumnosIds, motivo, dias = 1 } = req.body;
    try {
        for (const id of alumnosIds) {
            const a = await pool.query('SELECT padre_id, ruta_id FROM alumnos WHERE id = $1', [id]);
            if (a.rows.length > 0) {
                await pool.query('INSERT INTO ausencias (alumno_id, padre_id, motivo, fecha) VALUES ($1, $2, $3, CURRENT_DATE)', [id, a.rows[0].padre_id, motivo]);
            }
        }
        res.json({ mensaje: 'Ausencias reportadas' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
};

const desvincularAlumnoPorConductor = async (req, res) => {
    const { alumnoId, conductorId } = req.params;
    try {
        await pool.query('UPDATE alumnos SET ruta_id = NULL WHERE id = $1', [alumnoId]);
        res.json({ mensaje: 'Desvinculado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
};

module.exports = {
    obtenerOCrearRutaConductor,
    alumnosPorConductor,
    reportarAusencia,
    ausenciasDeLaRuta,
    marcarAbordado,
    inscribirAlumnoPorConductor,
    reportarAusenciaMultiple,
    desvincularAlumnoPorConductor,
};
