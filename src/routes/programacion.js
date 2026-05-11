const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/programacion/mis-hijos-cambios
// Lista todas las programaciones futuras para los hijos del padre autenticado
router.get('/mis-hijos-cambios', authenticateToken, requireRole('padre'), async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT pr.*, a.nombre as alumno_nombre, r.nombre as ruta_nombre
             FROM programacion_rutas pr
             JOIN alumnos a ON a.id = pr.alumno_id
             JOIN alumno_padres ap ON ap.alumno_id = a.id
             LEFT JOIN rutas r ON r.id = pr.ruta_id
             WHERE ap.padre_id = $1 AND pr.fecha >= CURRENT_DATE
             ORDER BY pr.fecha ASC`,
            [req.user.id]
        );
        res.json({ programaciones: resultado.rows, cambios: resultado.rows });
    } catch (error) {
        console.error('Error obteniendo programaciones:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/programacion
// Crea una nueva programación de cambio de ruta/parada
router.post('/', authenticateToken, requireRole('padre'), async (req, res) => {
    const { alumno_id, fecha, ruta_id, parada, latitude, longitude, tipo, nota } = req.body;

    if (!alumno_id || !fecha) {
        return res.status(400).json({ error: 'alumno_id y fecha son requeridos' });
    }

    try {
        // Verificar que el alumno pertenece al padre
        const vinculacion = await pool.query(
            'SELECT 1 FROM alumno_padres WHERE alumno_id = $1 AND padre_id = $2',
            [alumno_id, req.user.id]
        );

        if (vinculacion.rows.length === 0) {
            return res.status(403).json({ error: 'No tienes permiso para programar cambios para este alumno' });
        }

        const resultado = await pool.query(
            `INSERT INTO programacion_rutas 
                (alumno_id, fecha, ruta_id, parada, latitude, longitude, tipo, nota, creado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (alumno_id, fecha, tipo) 
             DO UPDATE SET 
                ruta_id = EXCLUDED.ruta_id,
                parada = EXCLUDED.parada,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                nota = EXCLUDED.nota,
                creado_en = NOW()
             RETURNING *`,
            [alumno_id, fecha, ruta_id || null, parada || null, latitude || null, longitude || null, tipo || 'ambos', nota || null, req.user.id]
        );

        res.status(201).json({
            mensaje: 'Programación guardada correctamente',
            programacion: resultado.rows[0]
        });
    } catch (error) {
        console.error('Error creando programación:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/programacion/:id
// Cancela una programación
router.delete('/:id', authenticateToken, requireRole('padre'), async (req, res) => {
    try {
        const check = await pool.query(
            `SELECT pr.id 
             FROM programacion_rutas pr
             JOIN alumno_padres ap ON ap.alumno_id = pr.alumno_id
             WHERE pr.id = $1 AND ap.padre_id = $2`,
            [req.params.id, req.user.id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Programación no encontrada o no tienes permiso' });
        }

        await pool.query('DELETE FROM programacion_rutas WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Programación cancelada correctamente' });
    } catch (error) {
        console.error('Error eliminando programación:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
