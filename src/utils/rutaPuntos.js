const pool = require('../database');

const normalizarNumero = (valor) => {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
};

const sincronizarPuntoAlumno = async (alumnoId) => {
    const resultado = await pool.query(
        `SELECT id, ruta_id, nombre, parada, latitude, longitude, orden
         FROM alumnos
         WHERE id = $1`,
        [alumnoId]
    );

    if (resultado.rows.length === 0) return null;

    const alumno = resultado.rows[0];
    const rutaId = alumno.ruta_id;
    const latitud = normalizarNumero(alumno.latitude);
    const longitud = normalizarNumero(alumno.longitude);

    await pool.query(
        `DELETE FROM puntos_ruta
         WHERE alumno_id = $1
           AND tipo = 'recogida'
           AND ($2::integer IS NULL OR ruta_id <> $2)`,
        [alumno.id, rutaId || null]
    );

    if (!rutaId || latitud === null || longitud === null) {
        await pool.query(
            `DELETE FROM puntos_ruta
             WHERE alumno_id = $1
               AND tipo = 'recogida'`,
            [alumno.id]
        );
        return null;
    }

    const nombreParada = alumno.parada || `Punto de ${alumno.nombre}`;
    const orden = Number.isInteger(Number(alumno.orden)) ? Number(alumno.orden) : 1000;

    const punto = await pool.query(
        `INSERT INTO puntos_ruta (ruta_id, alumno_id, tipo, latitud, longitud, orden, nombre_parada)
         VALUES ($1, $2, 'recogida', $3, $4, $5, $6)
         ON CONFLICT (alumno_id, tipo)
         DO UPDATE SET
             ruta_id = EXCLUDED.ruta_id,
             latitud = EXCLUDED.latitud,
             longitud = EXCLUDED.longitud,
             orden = EXCLUDED.orden,
             nombre_parada = EXCLUDED.nombre_parada
         RETURNING *`,
        [rutaId, alumno.id, latitud, longitud, orden, nombreParada]
    );

    return punto.rows[0] || null;
};

const sincronizarPuntosRuta = async (rutaId) => {
    if (!rutaId) return [];

    const alumnos = await pool.query(
        `SELECT id
         FROM alumnos
         WHERE ruta_id = $1
           AND activo = true`,
        [rutaId]
    );

    const puntos = [];
    for (const alumno of alumnos.rows) {
        const punto = await sincronizarPuntoAlumno(alumno.id);
        if (punto) puntos.push(punto);
    }

    await pool.query(
        `DELETE FROM puntos_ruta pr
         WHERE pr.ruta_id = $1
           AND pr.tipo = 'recogida'
           AND pr.alumno_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
               FROM alumnos a
               WHERE a.id = pr.alumno_id
                 AND a.ruta_id = pr.ruta_id
                 AND a.activo = true
           )`,
        [rutaId]
    );

    return puntos;
};

module.exports = {
    sincronizarPuntoAlumno,
    sincronizarPuntosRuta,
};
