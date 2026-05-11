const express = require('express');
const router = express.Router();
const pool = require('../database');

const { authenticateToken, requireRole } = require('../middleware/auth');

router.get('/', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT r.*, u.nombre AS conductor_nombre, c.nombre AS colegio_nombre,
                    COUNT(a.id) AS total_alumnos
             FROM rutas r
             LEFT JOIN usuarios u ON u.id = r.conductor_id
             LEFT JOIN colegios c ON c.id = r.colegio_id
             LEFT JOIN alumnos a ON a.ruta_id = r.id AND a.activo = true
             WHERE r.activa = true
             GROUP BY r.id, u.nombre, c.nombre
             ORDER BY r.nombre`
        );

        res.json({ rutas: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/rutas/mi-ruta
// Devuelve la ruta asignada al conductor autenticado. 
// Si es un conductor independiente y no tiene ruta, se le crea una por defecto.
router.get('/mi-ruta', authenticateToken, requireRole('conductor'), async (req, res) => {
    try {
        const conductorId = req.user.id;
        
        // 1. Buscar si ya tiene una ruta
        let resultado = await pool.query(
            `SELECT r.*, c.nombre as colegio_nombre
             FROM rutas r
             LEFT JOIN colegios c ON c.id = r.colegio_id
             WHERE r.conductor_id = $1 AND r.activa = true
             LIMIT 1`,
            [conductorId]
        );

        if (resultado.rows.length > 0) {
            return res.json({ ruta: resultado.rows[0] });
        }

        // 2. Si no tiene ruta, verificar si es independiente (sin colegio_id)
        const usuario = await pool.query('SELECT nombre, colegio_id FROM usuarios WHERE id = $1', [conductorId]);
        
        if (usuario.rows.length === 0) return res.status(404).json({ error: 'Conductor no encontrado' });

        const conductor = usuario.rows[0];

        // Solo creamos ruta automatica si es independiente o si el admin no le ha creado una
        // (En este caso, la creamos como 'Ruta de [Nombre]')
        const nuevaRuta = await pool.query(
            `INSERT INTO rutas (nombre, conductor_id, colegio_id, activa)
             VALUES ($1, $2, $3, true)
             RETURNING *`,
            [`Ruta de ${conductor.nombre}`, conductorId, conductor.colegio_id]
        );

        res.json({ 
            mensaje: 'Ruta personal creada automáticamente',
            ruta: nuevaRuta.rows[0] 
        });

    } catch (error) {
        console.error('Error en /mi-ruta:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT r.*, u.nombre AS conductor_nombre, c.nombre AS colegio_nombre,
                    COUNT(a.id) AS total_alumnos
             FROM rutas r
             LEFT JOIN usuarios u ON u.id = r.conductor_id
             LEFT JOIN colegios c ON c.id = r.colegio_id
             LEFT JOIN alumnos a ON a.ruta_id = r.id AND a.activo = true
             WHERE r.id = $1
             GROUP BY r.id, u.nombre, c.nombre`,
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Ruta no encontrada' });
        }

        res.json({ ruta: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
