require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../database');
const { obtenerMensajeDiarioHoy, personalizarMensajeParaPadre } = require('../utils/alertas');

const obtenerColegioPorRuta = async (rutaId) => {
    if (!rutaId) {
        return null;
    }

    const resultado = await pool.query(
        'SELECT colegio_id FROM rutas WHERE id = $1',
        [rutaId]
    );

    if (resultado.rows.length === 0) {
        return null;
    }

    return resultado.rows[0].colegio_id || null;
};

const construirMensajeAlerta = async ({ colegioId, minutosRestantes }) => {
    const minutos = Number(minutosRestantes);
    const esLlegadaInminente = minutos <= 1;

    let titulo = esLlegadaInminente
        ? 'El bus está llegando'
        : `El bus llega en ${minutos} minutos`;

    let cuerpo = esLlegadaInminente
        ? 'El bus escolar está llegando a tu parada'
        : `Prepara a tu hijo, el bus escolar llegará en ${minutos} minutos`;

    let anuncio = null;

    if (colegioId && Number(minutos) === 5) {
        const resultado = await pool.query(
            `SELECT id, titulo, mensaje, orden
             FROM anuncios_voz
             WHERE (colegio_id = $1 OR colegio_id IS NULL) AND activo = true
             ORDER BY COALESCE(colegio_id, 0) DESC, orden ASC, RANDOM()
             LIMIT 1`,
            [colegioId]
        );

        if (resultado.rows.length > 0) {
            anuncio = resultado.rows[0];
            titulo = anuncio.titulo || titulo;
            cuerpo = anuncio.mensaje;
        }
    }

    return { titulo, cuerpo, anuncio };
};

router.post('/token', async (req, res) => {
    const { usuarioId, token, plataforma } = req.body;

    if (!usuarioId || !token) {
        return res.status(400).json({ error: 'usuarioId y token son requeridos' });
    }

    try {
        const actualizado = await pool.query(
            `UPDATE tokens_push
             SET usuario_id = $1, plataforma = $2, activo = true
             WHERE token = $3
             RETURNING id`,
            [usuarioId, token, plataforma]
        );

        if (actualizado.rows.length === 0) {
            await pool.query(
                `INSERT INTO tokens_push (usuario_id, token, plataforma, activo)
                 VALUES ($1, $2, $3, true)`,
                [usuarioId, token, plataforma]
            );
        }

        res.json({ mensaje: 'Token registrado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/token', async (req, res) => {
    const { usuarioId, token } = req.body;

    if (!usuarioId || !token) {
        return res.status(400).json({ error: 'usuarioId y token son requeridos' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE tokens_push
             SET activo = false
             WHERE usuario_id = $1 AND token = $2
             RETURNING id`,
            [usuarioId, token]
        );

        res.json({
            mensaje: 'Token desactivado correctamente',
            desactivados: resultado.rows.length,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/enviar', async (req, res) => {
    const { usuarioId, titulo, mensaje } = req.body;
    try {
        const tokens = await pool.query(
            'SELECT token FROM tokens_push WHERE usuario_id = $1 AND activo = true',
            [usuarioId]
        );

        if (tokens.rows.length === 0) {
            return res.json({ mensaje: 'No hay tokens registrados para este usuario' });
        }

        const mensajes = tokens.rows.map((t) => ({
            to: t.token,
            title: titulo,
            body: mensaje,
            sound: 'default',
            priority: 'high',
            channelId: 'transporte',
        }));

        const respuesta = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(mensajes),
        });

        const resultado = await respuesta.json();
        res.json({ mensaje: 'Notificación enviada', resultado });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/alerta-bus', async (req, res) => {
    const { rutaId, minutosRestantes, colegioId } = req.body;

    try {
        const colegioRelacionadoId = colegioId || await obtenerColegioPorRuta(rutaId);

        // 1. Obtener padres con los nombres de sus hijos vinculados a esta ruta (que no estén ausentes hoy)
        const padresHijos = await pool.query(
            `SELECT ap.padre_id, string_agg(a.nombre, ', ') as hijos_nombres
             FROM alumnos a
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             WHERE a.ruta_id = $1 
               AND a.activo = true
               AND NOT EXISTS (
                 SELECT 1 FROM ausencias au 
                 WHERE au.alumno_id = a.id 
                 AND CURRENT_DATE BETWEEN au.fecha AND COALESCE(au.fecha_fin, au.fecha)
               )
             GROUP BY ap.padre_id`,
            [rutaId]
        );

        const mapaHijos = {};
        padresHijos.rows.forEach(p => {
            mapaHijos[p.padre_id] = p.hijos_nombres;
        });

        // 2. Obtener tokens de push vinculados a esos padres
        const tokensPush = await pool.query(
            `SELECT tp.token, tp.usuario_id
             FROM tokens_push tp
             WHERE tp.usuario_id = ANY($1) AND tp.activo = true`,
            [padresHijos.rows.map((p) => p.padre_id)]
        );

        // 3. Determinar el mensaje base (Prioridad: Mensaje Diario > Anuncio Voz > Default)
        let { titulo, cuerpo, anuncio } = await construirMensajeAlerta({
            colegioId: colegioRelacionadoId,
            minutosRestantes,
        });

        const mensajeDiario = await obtenerMensajeDiarioHoy();
        if (mensajeDiario && Number(minutosRestantes) === 5) {
            cuerpo = mensajeDiario;
        }

        if (tokensPush.rows.length === 0) {
            return res.json({
                mensaje: 'No hay tokens registrados',
                mensajeAudio: cuerpo,
                anuncio,
                colegioId: colegioRelacionadoId,
            });
        }

        // 4. Construir mensajes personalizados para cada token
        const mensajes = tokensPush.rows.map((t) => {
            const nombresHijos = mapaHijos[t.usuario_id] || 'tu hijo';
            const cuerpoPersonalizado = personalizarMensajeParaPadre(cuerpo, nombresHijos);

            return {
                to: t.token,
                title: titulo,
                body: cuerpoPersonalizado,
                sound: 'default',
                priority: 'high',
                channelId: 'transporte',
                data: {
                    alumnoNombres: nombresHijos,
                    tipo: 'alerta_bus'
                }
            };
        });

        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mensajes),
        });

        res.json({
            mensaje: `Alerta enviada a ${tokensPush.rows.length} padres`,
            mensajeAudio: cuerpo, // El audio base se mantiene para el front si lo usa para TTS genérico
            anuncio,
            colegioId: colegioRelacionadoId,
        });
    } catch (error) {
        console.error('Error en alerta-bus:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
