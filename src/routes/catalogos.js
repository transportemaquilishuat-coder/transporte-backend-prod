const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/catalogos/colegios?q=...
// Realiza una búsqueda difusa en el catálogo oficial de sedes educativas
router.get('/colegios', async (req, res) => {
    const { q } = req.query;
    
    if (!q || String(q).trim().length < 3) {
        return res.json({ sedes: [] });
    }

    try {
        const query = `
            SELECT id, codigo_infraestructura, nombre_oficial, departamento, municipio
            FROM sedes_educativas
            WHERE nombre_oficial ILIKE $1 OR codigo_infraestructura ILIKE $1
            ORDER BY nombre_oficial
            LIMIT 20
        `;
        const result = await pool.query(query, [`%${String(q).trim()}%`]);
        res.json({ sedes: result.rows });
    } catch (error) {
        console.error('Error en catálogo de colegios:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
