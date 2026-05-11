const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/asignacionesController');

router.get('/conductor/:conductorId', ctrl.alumnosPorConductor);
router.post('/conductor/:conductorId/alumnos', ctrl.inscribirAlumnoPorConductor);
router.post('/ausencia', ctrl.reportarAusencia);
router.get('/ausencias/:rutaId', ctrl.ausenciasDeLaRuta);
router.post('/abordar', ctrl.marcarAbordado);

module.exports = router;
