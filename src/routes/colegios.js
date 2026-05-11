const express = require('express');
const router = express.Router();
const pool = require('../database');

router.get('/:id', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT id, nombre, logo_url AS "logoUrl", plan, activo, dias_prueba_restantes, creado_en
             FROM colegios
             WHERE id = $1`,
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        res.json({ colegio: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id/logo', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT id, nombre, logo_url AS "logoUrl"
             FROM colegios
             WHERE id = $1`,
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        res.json({
            logo: {
                colegioId: resultado.rows[0].id,
                nombre: resultado.rows[0].nombre,
                logoUrl: resultado.rows[0].logoUrl,
            },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
