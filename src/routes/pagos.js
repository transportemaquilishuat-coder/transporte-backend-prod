const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pagosController');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/pagos - Listar todos los pagos (Admin/SuperAdmin)
router.get('/', authenticateToken, requireRole('admin', 'super_admin'), ctrl.listarPagos);

// GET /api/pagos/pendientes - Listar pagos pendientes
router.get('/pendientes', authenticateToken, requireRole('admin', 'super_admin'), ctrl.obtenerPagosPendientes);

// POST /api/pagos/generar-mensual - Generar cargos manualmente
router.post('/generar-mensual', authenticateToken, requireRole('admin', 'super_admin'), ctrl.procesarGeneracionManual);

// PUT /api/pagos/:id/estado - Actualizar estado de un pago (Admin)
router.put('/:id/estado', authenticateToken, requireRole('admin', 'super_admin'), ctrl.actualizarEstadoPago);

// POST /api/pagos/confirmar-pago - Padre confirma su pago realizado por Google Pay
router.post('/confirmar-pago', authenticateToken, requireRole('padre'), ctrl.confirmarPagoPadre);

module.exports = router;
