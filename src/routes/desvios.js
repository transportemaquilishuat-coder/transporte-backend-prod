require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../database');
const { sincronizarPuntosRuta } = require('../utils/rutaPuntos');
const { enviarNotificacionPushUsuarios } = require('../utils/notificaciones');

// Calcula distancia entre dos puntos GPS en metros
const calcularDistancia = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Encuentra la distancia mínima del punto actual a la ruta programada
const distanciaALaRuta = (latActual, lonActual, puntos) => {
    let minDistancia = Infinity;
    for (const punto of puntos) {
        const dist = calcularDistancia(
            latActual, lonActual,
            parseFloat(punto.latitud),
            parseFloat(punto.longitud)
        );
        if (dist < minDistancia) minDistancia = dist;
    }
    return minDistancia;
};

const obtenerPuntosProgramados = async (rutaId) => {
    await sincronizarPuntosRuta(rutaId);

    const resultado = await pool.query(
        `SELECT latitud, longitud, orden, nombre_parada, tipo
         FROM puntos_ruta
         WHERE ruta_id = $1
         UNION ALL
         SELECT c.latitude AS latitud,
                c.longitude AS longitud,
                99999 AS orden,
                c.nombre AS nombre_parada,
                'colegio' AS tipo
         FROM rutas r
         INNER JOIN colegios c ON c.id = r.colegio_id
         WHERE r.id = $1
           AND c.latitude IS NOT NULL
           AND c.longitude IS NOT NULL
         ORDER BY orden`,
        [rutaId]
    );

    return resultado.rows;
};

const obtenerUsuariosParaAlertaDesvio = async (rutaId) => {
    const resultado = await pool.query(
        `SELECT DISTINCT usuario_id
         FROM (
             SELECT ap.padre_id AS usuario_id
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.ruta_id = $1
               AND a.activo = true
             UNION
             SELECT c.admin_id AS usuario_id
             FROM rutas r
             INNER JOIN colegios c ON c.id = r.colegio_id
             WHERE r.id = $1
               AND c.admin_id IS NOT NULL
         ) destinos`,
        [rutaId]
    );

    return resultado.rows.map((row) => row.usuario_id);
};

const hayAlertaDesvioReciente = async (rutaId, conductorId) => {
    const resultado = await pool.query(
        `SELECT id
         FROM eventos_ruta
         WHERE ruta_id = $1
           AND conductor_id = $2
           AND tipo = 'desvio'
           AND creado_en > NOW() - INTERVAL '5 minutes'
         LIMIT 1`,
        [rutaId, conductorId]
    );

    return resultado.rows.length > 0;
};

// POST /api/desvios/verificar
router.post('/verificar', async (req, res) => {
    const { conductorId, rutaId, latitude, longitude } = req.body;

    if (!conductorId || !rutaId || !latitude || !longitude)
        return res.status(400).json({ error: 'Datos incompletos' });

    try {
        const puntos = await obtenerPuntosProgramados(rutaId);

        if (puntos.length === 0)
            return res.json({ desviado: false, mensaje: 'Sin ruta programada' });

        const distancia = distanciaALaRuta(latitude, longitude, puntos);
        const LIMITE_METROS = 200;
        const desviado = distancia > LIMITE_METROS;

        // Si está desviado, guardar alerta
        if (desviado) {
            const alertaReciente = await hayAlertaDesvioReciente(rutaId, conductorId);

            if (!alertaReciente) {
                const mensajeDesvio = `Bus desviado ${Math.round(distancia)} metros de la ruta`;

                await pool.query(
                    `INSERT INTO eventos_ruta (ruta_id, conductor_id, tipo, descripcion, latitud, longitud)
         VALUES ($1, $2, 'desvio', $3, $4, $5)`,
                    [
                        rutaId,
                        conductorId,
                        mensajeDesvio,
                        latitude,
                        longitude
                    ]
                );

                const usuariosDestino = await obtenerUsuariosParaAlertaDesvio(rutaId);
                enviarNotificacionPushUsuarios(
                    usuariosDestino,
                    'Alerta de desvio',
                    mensajeDesvio,
                    { tipo: 'desvio', rutaId, conductorId, distanciaMetros: Math.round(distancia) }
                ).catch(err => console.error('Error notificando desvio:', err));
            }
        }

        res.json({
            desviado,
            distanciaMetros: Math.round(distancia),
            limiteMetros: LIMITE_METROS,
            mensaje: desviado
                ? `⚠️ Bus desviado ${Math.round(distancia)} metros de la ruta`
                : '✅ Bus en ruta correcta',
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/desvios/alertas/:rutaId
router.get('/alertas/:rutaId', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT * FROM eventos_ruta
       WHERE ruta_id = $1 AND tipo = 'desvio'
       AND DATE(creado_en) = CURRENT_DATE
       ORDER BY creado_en DESC`,
            [req.params.rutaId]
        );
        res.json({ alertas: resultado.rows, total: resultado.rows.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/desvios/puntos/:rutaId
router.get('/puntos/:rutaId', async (req, res) => {
    try {
        const resultado = await pool.query(
            'SELECT * FROM puntos_ruta WHERE ruta_id = $1 ORDER BY orden',
            [req.params.rutaId]
        );
        res.json({ puntos: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
