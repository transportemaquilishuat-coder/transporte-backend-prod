const pool = require('../database');

const TOTAL_MENSAJES_DIARIOS = 31;

const normalizarMensajesDiarios = (mensajes, diasDelMes = 31) => {
    const diasValidos = Math.min(diasDelMes, TOTAL_MENSAJES_DIARIOS);
    if (!Array.isArray(mensajes) || mensajes.length < diasValidos) {
        return null;
    }

    return mensajes.slice(0, diasValidos).map((mensaje) => String(mensaje || '').trim());
};

const completarMensajesDiarios = (mensajes, diasDelMes = 31) => {
    const valores = Array.isArray(mensajes) ? mensajes : [];
    const diasValidos = Math.min(diasDelMes, TOTAL_MENSAJES_DIARIOS);
    return Array.from({ length: diasValidos }, (_, index) => String(valores[index] || ''));
};

const obtenerMensajeParaDia = (mensajesDiarios, dia, mensajeFallback) => {
    const mensajes = Array.isArray(mensajesDiarios) ? mensajesDiarios : [];
    const mensajeDelDia = String(mensajes[dia - 1] || '').trim();
    return mensajeDelDia || mensajeFallback;
};

/**
 * Obtiene el mensaje diario configurado para el día de hoy (tipo recogida_5min)
 */
const obtenerMensajeDiarioHoy = async () => {
    try {
        const resultado = await pool.query(
            `SELECT mensajes_diarios, mensaje as mensaje_base
             FROM alertas_configuracion
             WHERE tipo = 'recogida_5min'
             LIMIT 1`
        );

        if (resultado.rows.length === 0) return null;

        const config = resultado.rows[0];
        const hoy = new Date().getDate();
        
        // El campo mensajes_diarios en DB es jsonb (un array)
        return obtenerMensajeParaDia(config.mensajes_diarios, hoy, config.mensaje_base);
    } catch (error) {
        console.error('Error obteniendo mensaje diario hoy:', error);
        return null;
    }
};

/**
 * Personaliza un mensaje reemplazando palabras clave por los nombres de los hijos
 */
const personalizarMensajeParaPadre = (mensaje, nombresHijos) => {
    if (!mensaje || !nombresHijos) return mensaje;

    // Palabras clave a reemplazar (insensible a mayúsculas/minúsculas)
    const regexHijo = /hijo|hijos|alumno|alumnos/gi;
    
    return mensaje.replace(regexHijo, nombresHijos);
};

module.exports = {
    TOTAL_MENSAJES_DIARIOS,
    normalizarMensajesDiarios,
    completarMensajesDiarios,
    obtenerMensajeParaDia,
    obtenerMensajeDiarioHoy,
    personalizarMensajeParaPadre,
};
