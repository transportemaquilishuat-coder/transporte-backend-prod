const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/avisos
// Obtiene los avisos informativos activos para el colegio del usuario o globales
router.get('/', authenticateToken, async (req, res) => {
    const { colegio_id } = req.user;

    try {
        const resultado = await pool.query(
            `SELECT id, titulo, contenido, tipo, actualizado_en
             FROM avisos_informativos
             WHERE activo = true 
               AND (colegio_id = $1 OR colegio_id IS NULL)
             ORDER BY colegio_id DESC, actualizado_en DESC`,
            [colegio_id || null]
        );

        res.json({ avisos: resultado.rows });
    } catch (error) {
        console.error('Error obteniendo avisos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/avisos/politica-comunicacion
// Obtiene específicamente la política de comunicación
router.get('/politica-comunicacion', authenticateToken, async (req, res) => {
    const { colegio_id } = req.user;

    try {
        const resultado = await pool.query(
            `SELECT id, titulo, contenido, actualizado_en
             FROM avisos_informativos
             WHERE activo = true 
               AND tipo = 'politica_comunicacion'
               AND (colegio_id = $1 OR colegio_id IS NULL)
             ORDER BY colegio_id DESC, actualizado_en DESC
             LIMIT 1`,
            [colegio_id || null]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Política de comunicación no encontrada' });
        }

        res.json({ aviso: resultado.rows[0] });
    } catch (error) {
        console.error('Error obteniendo política de comunicación:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
