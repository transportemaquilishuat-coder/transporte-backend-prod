const pool = require('../database');

const normalizarNumero = (valor) => {
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
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

    const { turno = 'matutino', sentido = 'recogida' } = opciones;

    // 1. Obtener datos base (Alumnos activos de la ruta)
    // Filtramos alumnos que tengan ausencia AUTORIZADA para hoy
    const alumnosResult = await client.query(
        `SELECT a.id, a.nombre, a.parada, a.latitude, a.longitude, a.orden,
                c.latitude as colegio_lat, c.longitude as colegio_lng, c.nombre as colegio_nombre
         FROM alumnos a
         LEFT JOIN colegios c ON c.id = a.colegio_id
         WHERE a.ruta_id = $1
           AND a.activo = true
           AND NOT EXISTS (
               SELECT 1 FROM ausencias au
               WHERE au.alumno_id = a.id
                 AND au.estado = 'autorizado'
                 AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
           )`,
        [rutaId]
    );

    if (alumnosResult.rows.length === 0) {
        // Si no hay alumnos, limpiamos la ruta y salimos
        await client.query(`DELETE FROM puntos_ruta WHERE ruta_id = $1`, [rutaId]);
        return [];
    }

    const colegio = {
        lat: normalizarNumero(alumnosResult.rows[0].colegio_lat),
        lng: normalizarNumero(alumnosResult.rows[0].colegio_lng),
        nombre: alumnosResult.rows[0].colegio_nombre || 'Colegio'
    };

    // 2. Buscar cambios temporales APROBADOS para hoy
    const cambiosResult = await client.query(
        `SELECT * FROM programacion_rutas
         WHERE ruta_id = $1 AND fecha = CURRENT_DATE AND estado = 'aprobado'`,
        [rutaId]
    );
    const cambiosMap = new Map(cambiosResult.rows.map(c => [Number(c.alumno_id), c]));

    // 3. Construir lista de paradas "Vivas"
    let paradas = alumnosResult.rows.map(alumno => {
        const cambio = cambiosMap.get(Number(alumno.id));
        
        // Si hay un cambio aprobado que aplique a este sentido o sea 'ambos'
        if (cambio && (cambio.tipo === 'ambos' || cambio.tipo === sentido)) {
            return {
                alumno_id: alumno.id,
                nombre: alumno.nombre,
                parada: cambio.parada || alumno.parada,
                lat: normalizarNumero(cambio.latitude),
                lng: normalizarNumero(cambio.longitude),
                orden: alumno.orden || 1000
            };
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
    }

    // 5. Guardar en la tabla puntos_ruta (la que usa el mapa y el detector de desvíos)
    await client.query(`DELETE FROM puntos_ruta WHERE ruta_id = $1`, [rutaId]);

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
};
