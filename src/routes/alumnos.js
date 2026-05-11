const express = require('express');
const router = express.Router();

const alumnos = [
    { id: 1, nombre: 'Pedro García', grado: '3ro primaria', ruta_id: 1, padre: 'Carlos García' },
    { id: 2, nombre: 'María López', grado: '5to primaria', ruta_id: 1, padre: 'Ana López' },
    { id: 3, nombre: 'Juan Martínez', grado: '2do primaria', ruta_id: 2, padre: 'Luis Martínez' },
    { id: 4, nombre: 'Sofía Hernández', grado: '4to primaria', ruta_id: 3, padre: 'Rosa Hernández' },
];

router.get('/', (req, res) => {
    res.json({ alumnos });
});

router.get('/:id', (req, res) => {
    const alumno = alumnos.find(a => a.id === parseInt(req.params.id));
    if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado' });
    res.json({ alumno });
});

module.exports = router;