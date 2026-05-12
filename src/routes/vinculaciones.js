require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { SESSION_EXPIRES_IN, firmarTokenSesion } = require('../utils/authTokens');
const { generarCodigoAleatorio, normalizarCodigo } = require('../utils/codigos');
const {
    listarColegiosSuperAdmin,
    crearColegioSuperAdmin,
    generarCodigoAdminSuperAdmin,
    eliminarColegioSuperAdmin,
    editarColegioSuperAdmin,
    toggleColegioSuperAdmin,
    desvincularAdminSuperAdmin,
    asignarAdminSuperAdmin,
} = require('../controllers/colegiosSuperAdmin');

const {
    obtenerCodigoValido,
    resolverDestinoVinculacion,
    validarRolParaCodigo,
    propagarColegioAConductorYPadres
} = require('./vinculaciones-logic');

// ============================================
// UTILIDADES
// ============================================

const generarPasswordTemporal = (longitud = 10) => {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < longitud; i += 1) {
        password += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    return password;
};

// ============================================
// 1. SUPERADMIN: Gestionar Colegios y Códigos
// ============================================


router.get('/superadmin/colegios', authenticateToken, requireRole('super_admin'), listarColegiosSuperAdmin);
router.post('/superadmin/colegios', authenticateToken, requireRole('super_admin'), crearColegioSuperAdmin);
router.put('/superadmin/colegios/:colegioId', authenticateToken, requireRole('super_admin'), editarColegioSuperAdmin);
router.patch('/superadmin/colegios/:colegioId/estado', authenticateToken, requireRole('super_admin'), toggleColegioSuperAdmin);
router.delete('/superadmin/colegios/:colegioId', authenticateToken, requireRole('super_admin'), eliminarColegioSuperAdmin);
router.post('/superadmin/colegios/:colegioId/codigo', authenticateToken, requireRole('super_admin'), generarCodigoAdminSuperAdmin);
router.post('/superadmin/colegios/:colegioId/asignar-admin', authenticateToken, requireRole('super_admin'), asignarAdminSuperAdmin);
router.post('/superadmin/colegios/:colegioId/desvincular-admin', authenticateToken, requireRole('super_admin'), desvincularAdminSuperAdmin);
router.delete('/superadmin/colegios/:colegioId/desvincular-admin', authenticateToken, requireRole('super_admin'), desvincularAdminSuperAdmin);

// POST /api/vinculaciones/superadmin/colegios/:colegioId/impersonate
router.post('/superadmin/colegios/:colegioId/impersonate', authenticateToken, requireRole('super_admin'), async (req, res) => {
    const { colegioId } = req.params;
    try {
        const resultado = await pool.query(
            `SELECT c.*, u.id as admin_user_id, u.email as admin_email, u.nombre as admin_nombre
             FROM colegios c
             LEFT JOIN usuarios u ON u.id = c.admin_id
             WHERE c.id = $1`,
            [colegioId]
        );
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'Colegio no encontrado' });
        const colegio = resultado.rows[0];
        const payload = {
            id: colegio.admin_user_id || req.user.id,
            email: colegio.admin_email || `superadmin+${colegio.id}@transporte.local`,
            nombre: `[SA] ${colegio.admin_nombre || 'Admin Temporal'}`,
            rol: 'admin',
            tipo: 'usuario',
            colegio_id: colegio.id,
            colegio_nombre: colegio.nombre,
            colegio_logo: colegio.logo_url,
            isImpersonated: true,
            superAdminId: req.user.id
        };
        const token = firmarTokenSesion(payload);
        res.json({
            mensaje: `Acceso concedido al panel de ${colegio.nombre}`,
            token,
            expiresIn: SESSION_EXPIRES_IN,
            usuario: {
                id: payload.id,
                nombre: payload.nombre,
                email: payload.email,
                rol: 'admin',
                colegioId: colegio.id,
                colegioNombre: colegio.nombre,
                logoUrl: colegio.logo_url
            }
        });
    } catch (error) {
        console.error('Error en impersonation:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/superadmin/colegios/:colegioId/usuarios', authenticateToken, requireRole('super_admin'), async (req, res) => {
    const { colegioId } = req.params;
    try {
        const usuarios = await pool.query(
            `SELECT id, nombre, email, rol, telefono, dui, licencia, placa, activo, colegio_id, creado_en
             FROM usuarios WHERE colegio_id = $1 ORDER BY rol, nombre`,
            [colegioId]
        );
        res.json({ usuarios: usuarios.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/superadmin/colegios/:colegioId/reset-admin-password', authenticateToken, requireRole('super_admin'), async (req, res) => {
    const { colegioId } = req.params;
    const nuevaPassword = String(req.body?.password || '').trim() || generarPasswordTemporal();
    try {
        const colegio = await pool.query('SELECT admin_id FROM colegios WHERE id = $1', [colegioId]);
        if (colegio.rows.length === 0 || !colegio.rows[0].admin_id) return res.status(404).json({ error: 'Colegio o admin no encontrado' });
        const passwordHash = await bcrypt.hash(nuevaPassword, 10);
        await pool.query('UPDATE usuarios SET password = $1 WHERE id = $2', [passwordHash, colegio.rows[0].admin_id]);
        res.json({ mensaje: 'Password reseteado', passwordTemporal: nuevaPassword });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.get('/superadmin/codigos', authenticateToken, requireRole('super_admin'), async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT c.*, co.nombre as colegio_nombre, COALESCE(sa.nombre, u.nombre, 'Sistema') as creado_por_nombre
            FROM codigos_invitacion c
            LEFT JOIN colegios co ON co.id = c.entidad_id
            LEFT JOIN super_admins sa ON sa.id = c.creado_por
            LEFT JOIN usuarios u ON u.id = c.creado_por
            ORDER BY c.creado_en DESC
        `);
        res.json({ codigos: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// 2. REGISTRO Y VINCULACIÓN GENERAL (DEPRECADO)
// ============================================

// El registro ahora se centraliza en /api/auth/registro
router.post('/registro-con-codigo', (req, res) => {
    res.status(410).json({ error: 'Endpoint deprecado. Use /api/auth/registro para todos los registros.' });
});

const vincularConCodigoHandler = async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'El codigo es requerido' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const verificacion = await obtenerCodigoValido(codigo);
        if (!verificacion.valido) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: verificacion.error });
        }

        const destino = await resolverDestinoVinculacion(client, verificacion.codigo);

        if (!validarRolParaCodigo(req.user.rol, verificacion.codigo.tipo)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Codigo no valido para el rol de tu cuenta' });
        }

        const { colegioId, conductorId, rutaId, alumnoId } = destino;

        // 1. Actualizar Colegio del Usuario
        if (colegioId) {
            await client.query(
                'UPDATE usuarios SET colegio_id = COALESCE($1, colegio_id), activo = true WHERE id = $2',
                [colegioId, req.user.id]
            );
        }

        // 2. Lógica de Descubrimiento y Vinculación según Rol
        if (req.user.rol === 'padre') {
            // Vincular TODOS los hijos del padre a la ruta descubierta
            const hijos = await client.query('SELECT id FROM alumnos WHERE padre_id = $1', [req.user.id]);
            if (hijos.rows.length > 0 && rutaId) {
                const hijosIds = hijos.rows.map(h => h.id);
                await client.query(
                    'UPDATE alumnos SET ruta_id = $1, colegio_id = COALESCE($2, colegio_id) WHERE id = ANY($3::int[])',
                    [rutaId, colegioId, hijosIds]
                );
            }
        } else if (req.user.rol === 'conductor' && colegioId) {
            // El conductor se vincula al colegio y propaga a sus alumnos
            await client.query('UPDATE rutas SET colegio_id = $1 WHERE conductor_id = $2', [colegioId, req.user.id]);
            await client.query('UPDATE alumnos SET colegio_id = $1 WHERE ruta_id IN (SELECT id FROM rutas WHERE conductor_id = $2)', [colegioId, req.user.id]);
            await client.query('UPDATE usuarios SET colegio_id = $1 WHERE id IN (SELECT padre_id FROM alumnos WHERE ruta_id IN (SELECT id FROM rutas WHERE conductor_id = $2))', [colegioId, req.user.id]);
        }

        // 3. Registrar la Vinculación
        await client.query(
            `INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado)
             VALUES ($1, $2, $3, $4, $5, $6, 'activo')`,
            [verificacion.codigo.tipo, req.user.id, verificacion.codigo.creado_por, colegioId, conductorId, normalizarCodigo(codigo)]
        );

        // 4. Incrementar usos del código
        await client.query(
            'UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE id = $2',
            [req.user.id, verificacion.codigo.id]
        );

        await client.query('COMMIT');
        return res.json({ 
            mensaje: 'Vinculación exitosa',
            desc: destino.desc,
            colegioId,
            rutaId
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error vinculando con descubrimiento:', error);
        return res.status(500).json({ error: 'Error interno en la vinculación' });
    } finally {
        client.release();
    }
};

router.post('/vincular-con-codigo', authenticateToken, vincularConCodigoHandler);

// ============================================
// 3. ADMIN: Gestión de Conductores y Padres
// ============================================


router.get('/admin/conductores', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT * FROM usuarios WHERE colegio_id = $1 AND rol = 'conductor' AND activo = true`, [req.user.colegio_id]);
        res.json({ conductores: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.post('/admin/conductores/codigo', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const codigo = generarCodigoAleatorio(8);
        const expiraEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(`INSERT INTO codigos_invitacion (codigo, tipo, entidad_id, creado_por, max_usos, expira_en) VALUES ($1, 'colegio_conductor', $2, $3, 1, $4)`,
            [codigo, req.user.colegio_id, req.user.id, expiraEn]);
        res.status(201).json({ codigo });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.post('/admin/conductores/directo', authenticateToken, requireRole('admin'), async (req, res) => {
    const { email, nombre, password, telefono, dui, licencia, placa } = req.body;
    try {
        const passwordHash = await bcrypt.hash(password || '12345678', 10);
        const result = await pool.query(`INSERT INTO usuarios (nombre, email, password, rol, colegio_id, telefono, dui, licencia, placa, activo) 
            VALUES ($1, $2, $3, 'conductor', $4, $5, $6, $7, $8, true) ON CONFLICT (email) DO UPDATE SET rol = 'conductor', colegio_id = $4 RETURNING id`,
            [nombre, email.toLowerCase(), passwordHash, req.user.colegio_id, telefono, dui, licencia, placa]);
        res.status(201).json({ mensaje: 'Conductor vinculado', id: result.rows[0].id });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.delete('/admin/conductores/:conductorId', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        await pool.query(`UPDATE usuarios SET colegio_id = NULL WHERE id = $1 AND colegio_id = $2`, [req.params.conductorId, req.user.colegio_id]);
        await pool.query(`DELETE FROM vinculaciones WHERE entidad_id = $1 AND colegio_id = $2 AND tipo = 'colegio_conductor'`, [req.params.conductorId, req.user.colegio_id]);
        res.json({ mensaje: 'Desvinculado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.get('/admin/padres', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT u.*, (SELECT nombre FROM usuarios WHERE id = v.conductor_id) as conductor_nombre 
            FROM usuarios u LEFT JOIN vinculaciones v ON v.entidad_id = u.id 
            WHERE (u.colegio_id = $1 OR v.colegio_id = $1) AND u.rol = 'padre' AND u.activo = true`, [req.user.colegio_id]);
        res.json({ padres: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.post('/admin/padres/directo', authenticateToken, requireRole('admin'), async (req, res) => {
    const { email, nombre, password, telefono, dui } = req.body;
    try {
        const passwordHash = await bcrypt.hash(password || '12345678', 10);
        const result = await pool.query(`INSERT INTO usuarios (nombre, email, password, rol, colegio_id, telefono, dui, activo) 
            VALUES ($1, $2, $3, 'padre', $4, $5, $6, true) ON CONFLICT (email) DO UPDATE SET rol = 'padre', colegio_id = $4 RETURNING id`,
            [nombre, email.toLowerCase(), passwordHash, req.user.colegio_id, telefono, dui]);
        res.status(201).json({ mensaje: 'Padre vinculado', id: result.rows[0].id });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.delete('/admin/padres/:padreId', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        await pool.query(`UPDATE usuarios SET colegio_id = NULL WHERE id = $1 AND colegio_id = $2`, [req.params.padreId, req.user.colegio_id]);
        res.json({ mensaje: 'Desvinculado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// ============================================
// 4. CONDUCTOR: Gestión de Padres
// ============================================

router.get('/conductor/padres', authenticateToken, requireRole('conductor'), async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT u.* FROM usuarios u JOIN vinculaciones v ON v.entidad_id = u.id WHERE v.conductor_id = $1 AND v.tipo = 'conductor_padre' AND v.estado = 'activo'`, [req.user.id]);
        res.json({ padres: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.post('/conductor/padres/codigo', authenticateToken, requireRole('conductor'), async (req, res) => {
    try {
        const codigo = generarCodigoAleatorio(8);
        const expiraEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(`INSERT INTO codigos_invitacion (codigo, tipo, entidad_id, creado_por, max_usos, expira_en) VALUES ($1, 'conductor_padre', $2, $2, 1, $3)`,
            [codigo, req.user.id, expiraEn]);
        res.status(201).json({ codigo });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.post('/conductor/padres/directo', authenticateToken, requireRole('conductor'), async (req, res) => {
    const { email, nombre, password, telefono, dui } = req.body;
    try {
        const passwordHash = await bcrypt.hash(password || '12345678', 10);
        const result = await pool.query(`INSERT INTO usuarios (nombre, email, password, rol, activo, telefono, dui) 
            VALUES ($1, $2, $3, 'padre', true, $4, $5) ON CONFLICT (email) DO UPDATE SET rol = 'padre' RETURNING id`,
            [nombre, email.toLowerCase(), passwordHash, telefono, dui]);
        const padreId = result.rows[0].id;
        await pool.query(`INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, conductor_id, estado) VALUES ('conductor_padre', $1, $2, $2, 'activo') ON CONFLICT DO NOTHING`, [padreId, req.user.id]);
        res.status(201).json({ mensaje: 'Padre vinculado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.delete('/conductor/padres/:padreId', authenticateToken, requireRole('conductor'), async (req, res) => {
    try {
        await pool.query(`UPDATE vinculaciones SET estado = 'inactivo' WHERE entidad_id = $1 AND conductor_id = $2 AND tipo = 'conductor_padre'`, [req.params.padreId, req.user.id]);
        res.json({ mensaje: 'Desvinculado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// ============================================
// 5. GENERAL
// ============================================

router.get('/verificar-codigo/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const verificacion = await obtenerCodigoValido(codigo);

        if (!verificacion.valido) {
            return res.status(404).json({ error: verificacion.error || 'Código no encontrado' });
        }

        const c = verificacion.codigo;
        let extraInfo = {};

        // Obtener información descriptiva según el tipo
        if (c.tipo === 'colegio_admin' || c.tipo === 'colegio_conductor') {
            const colegio = await pool.query('SELECT nombre FROM colegios WHERE id = $1', [c.entidad_id]);
            extraInfo.colegio_nombre = colegio.rows[0]?.nombre || 'Colegio desconocido';
        } else if (c.tipo === 'conductor_padre') {
            const conductor = await pool.query('SELECT nombre FROM usuarios WHERE id = $1', [c.entidad_id]);
            extraInfo.conductor_nombre = conductor.rows[0]?.nombre || 'Conductor desconocido';
        } else if (c.tipo === 'padre_compartido') {
            const alumno = await pool.query('SELECT nombre FROM alumnos WHERE id = $1', [c.entidad_id]);
            extraInfo.alumno_nombre = alumno.rows[0]?.nombre || 'Alumno desconocido';
        }

        res.json({
            valido: true,
            ...c,
            ...extraInfo
        });
    } catch (error) {
        console.error('Error verificando código:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/padre/mis-conductores', authenticateToken, requireRole('padre'), async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT u.* FROM usuarios u JOIN vinculaciones v ON v.conductor_id = u.id WHERE v.entidad_id = $1 AND v.tipo = 'conductor_padre' AND v.estado = 'activo'`, [req.user.id]);
        res.json({ conductores: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

module.exports = router;
