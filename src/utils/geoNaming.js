const pool = require('../database');

/**
 * Calcula el nombre geográfico de una ruta basándose en la posición media de sus alumnos
 * relativa a la ubicación del colegio.
 * 
 * @param {number} rutaId - ID de la ruta a nombrar
 * @returns {Promise<string|null>} El nombre sugerido (ej: "Ruta Noreste") o null si no hay datos suficentes
 */
const calcularNombreGeografico = async (rutaId) => {
    try {
        // 1. Obtener la ubicación del colegio y los alumnos de la ruta
        const query = `
            SELECT 
                c.latitude as "colegioLat", 
                c.longitude as "colegioLon",
                AVG(a.latitude) as "avgLat",
                AVG(a.longitude) as "avgLon",
                COUNT(a.id) as "totalAlumnos"
            FROM rutas r
            JOIN colegios c ON c.id = r.colegio_id
            JOIN alumnos a ON a.ruta_id = r.id
            WHERE r.id = $1 AND a.activo = true AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
            GROUP BY c.id
        `;
        
        const res = await pool.query(query, [rutaId]);
        
        if (res.rows.length === 0 || res.rows[0].totalAlumnos === 0) {
            return null;
        }

        const { colegioLat, colegioLon, avgLat, avgLon } = res.rows[0];

        if (!colegioLat || !colegioLon) {
            console.warn(`[GeoNaming] El colegio de la ruta ${rutaId} no tiene ubicación configurada.`);
            return null;
        }

        // 2. Calcular el ángulo relativo al colegio
        // Usamos atan2(deltaLat, deltaLon)
        const dy = parseFloat(avgLat) - parseFloat(colegioLat);
        const dx = parseFloat(avgLon) - parseFloat(colegioLon);
        
        // El ángulo en grados (0 es Este, 90 es Norte, 180 es Oeste, -90 es Sur)
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        
        let direccion = "";

        if (angle >= -22.5 && angle < 22.5) {
            direccion = "Este";
        } else if (angle >= 22.5 && angle < 67.5) {
            direccion = "Noreste";
        } else if (angle >= 67.5 && angle < 112.5) {
            direccion = "Norte";
        } else if (angle >= 112.5 && angle < 157.5) {
            direccion = "Noroeste";
        } else if (angle >= 157.5 || angle < -157.5) {
            direccion = "Oeste";
        } else if (angle >= -157.5 && angle < -112.5) {
            direccion = "Suroeste";
        } else if (angle >= -112.5 && angle < -67.5) {
            direccion = "Sur";
        } else if (angle >= -67.5 && angle < -22.5) {
            direccion = "Sureste";
        }

        return `Ruta ${direccion}`;
    } catch (error) {
        console.error('[GeoNaming] Error calculando nombre:', error);
        return null;
    }
};

/**
 * Actualiza automáticamente el nombre de una ruta en la base de datos
 */
const autoNombrarRuta = async (rutaId) => {
    const nuevoNombre = await calcularNombreGeografico(rutaId);
    if (nuevoNombre) {
        await pool.query('UPDATE rutas SET nombre = $1 WHERE id = $2', [nuevoNombre, rutaId]);
        console.log(`[GeoNaming] Ruta ${rutaId} auto-nombrada como: ${nuevoNombre}`);
        return nuevoNombre;
    }
    return null;
};

module.exports = {
    calcularNombreGeografico,
    autoNombrarRuta
};
