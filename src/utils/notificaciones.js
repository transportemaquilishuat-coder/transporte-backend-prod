const pool = require('../database');

/**
 * Envía una notificación push a un usuario específico
 * Utiliza el objeto fetch global (disponible en Node 18+)
 */
const enviarNotificacionPush = async (usuarioId, titulo, mensaje, data = {}) => {
    try {
        const tokens = await pool.query(
            'SELECT token FROM tokens_push WHERE usuario_id = $1 AND activo = true',
            [usuarioId]
        );

        if (tokens.rows.length === 0) {
            return { success: false, mensaje: 'No hay tokens registrados' };
        }

        const mensajes = tokens.rows.map((t) => ({
            to: t.token,
            title: titulo,
            body: mensaje,
            data,
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
        return { success: true, resultado };
    } catch (error) {
        console.error('Error enviando push:', error);
        return { success: false, error: error.message };
    }
};

const enviarNotificacionPushUsuarios = async (usuarioIds, titulo, mensaje, data = {}) => {
    const ids = [...new Set((usuarioIds || []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) {
        return { success: false, mensaje: 'No hay usuarios destino' };
    }

    try {
        const tokens = await pool.query(
            `SELECT token
             FROM tokens_push
             WHERE usuario_id = ANY($1::int[])
               AND activo = true`,
            [ids]
        );

        if (tokens.rows.length === 0) {
            return { success: false, mensaje: 'No hay tokens registrados' };
        }

        const mensajes = tokens.rows.map((t) => ({
            to: t.token,
            title: titulo,
            body: mensaje,
            data,
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
        return { success: true, resultado };
    } catch (error) {
        console.error('Error enviando push masivo:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Envía una notificación push a todos los padres vinculados a un alumno
 */
const enviarNotificacionAlumno = async (alumnoId, titulo, mensaje, data = {}) => {
    try {
        const padres = await pool.query(
            `SELECT padre_id FROM alumno_padres WHERE alumno_id = $1`,
            [alumnoId]
        );

        if (padres.rows.length === 0) {
            // Fallback: buscar el padre_id directo en la tabla alumnos si no hay vinculaciones nuevas
            const alumno = await pool.query('SELECT padre_id FROM alumnos WHERE id = $1', [alumnoId]);
            if (alumno.rows.length > 0 && alumno.rows[0].padre_id) {
                return await enviarNotificacionPush(alumno.rows[0].padre_id, titulo, mensaje, data);
            }
            return { success: false, mensaje: 'No hay padres vinculados a este alumno' };
        }

        const padreIds = padres.rows.map(p => p.padre_id);
        return await enviarNotificacionPushUsuarios(padreIds, titulo, mensaje, data);
    } catch (error) {
        console.error('Error enviando push a padres de alumno:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    enviarNotificacionPush,
    enviarNotificacionPushUsuarios,
    enviarNotificacionAlumno,
};
