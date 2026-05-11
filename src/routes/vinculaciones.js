require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { SESSION_EXPIRES_IN, firmarTokenSesion } = require('../utils/authTokens');
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

// ============================================
// UTILIDADES
// ============================================

const generarCodigo = (longitud = 8) => {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = '';
    for (let i = 0; i < longitud; i += 1) {
        codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    return codigo;
};

const generarPasswordTemporal = (longitud = 10) => {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < longitud; i += 1) {
        password += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    return password;
};

const normalizarCodigo = (codigo) =>
    String(codigo || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

const verificarCodigoInterno = async (codigo, tipoRequerido) => {
    const resultado = await pool.query(
        `SELECT c.*,
      (c.usos_actuales >= c.max_usos) as usado_completamente,
      (c.expira_en IS NOT NULL AND c.expira_en < NOW()) as expirado
     FROM codigos_invitacion c
     WHERE c.codigo = $1 AND c.activo = true`,
        [codigo.toUpperCase()]
    );

    if (resultado.rows.length === 0) {
        return { valido: false, error: 'Código no encontrado' };
    }

    const codigoData = resultado.rows[0];

    if (codigoData.usado_completamente) {
        return { valido: false, error: 'Código ya fue usado el máximo de veces permitido' };
    }

    if (codigoData.expirado) {
        return { valido: false, error: 'Código expirado' };
    }

    if (codigoData.tipo !== tipoRequerido) {
        return { valido: false, error: 'Código no válido para este tipo de vinculación' };
    }

    return { valido: true, codigo: codigoData };
};

const TIPOS_CODIGO = ['colegio_admin', 'colegio_conductor', 'conductor_padre', 'padre_compartido'];

const obtenerCodigoValido = async (codigo) => {
    const codigoNormalizado = normalizarCodigo(codigo);
    if (!codigoNormalizado) return { valido: false, error: 'Codigo invalido' };

    for (const tipo of TIPOS_CODIGO) {
        const verificacion = await verificarCodigoInterno(codigoNormalizado, tipo);
        if (verificacion.valido) {
            return verificacion;
        }
    }

    return { valido: false, error: 'Codigo no encontrado, expirado o invalido' };
};

const propagarColegioAConductorYPadres = async (client, conductorId, colegioId) => {
    if (!conductorId || !colegioId) return [];

    await client.query(
        'UPDATE usuarios SET colegio_id = $1, activo = true WHERE id = $2',
        [colegioId, conductorId]
    );

    await client.query(
        'UPDATE rutas SET colegio_id = $1 WHERE conductor_id = $2',
        [colegioId, conductorId]
    );

    const padresResult = await client.query(
        `SELECT DISTINCT entidad_id
         FROM vinculaciones
         WHERE conductor_id = $1
           AND tipo = 'conductor_padre'
           AND estado = 'activo'`,
        [conductorId]
    );

    const padresIds = padresResult.rows
        .map((row) => Number(row.entidad_id))
        .filter(Number.isInteger);

    if (padresIds.length > 0) {
        await client.query(
            'UPDATE usuarios SET colegio_id = $1, activo = true WHERE id = ANY($2::int[])',
            [colegioId, padresIds]
        );
    }

    await client.query(
        `UPDATE vinculaciones
         SET colegio_id = $1, actualizado_en = NOW()
         WHERE conductor_id = $2
           AND tipo = 'conductor_padre'
           AND estado = 'activo'`,
        [colegioId, conductorId]
    );

    return padresIds;
};

const resolverDestinoVinculacion = async (client, codigoData) => {
    switch (codigoData.tipo) {
        case 'colegio_admin':
            return {
                rol: 'admin',
                colegioId: codigoData.entidad_id,
                conductorId: null
            };
        case 'colegio_conductor':
            return {
                rol: 'conductor',
                colegioId: codigoData.entidad_id,
                conductorId: null
            };
        case 'conductor_padre': {
            const conductor = await client.query(
                'SELECT colegio_id FROM usuarios WHERE id = $1 AND rol = $2 LIMIT 1',
                [codigoData.entidad_id, 'conductor']
            );

            const rutaCond = await client.query(
                'SELECT colegio_id FROM rutas WHERE conductor_id = $1 AND colegio_id IS NOT NULL LIMIT 1',
                [codigoData.entidad_id]
            );

            return {
                rol: 'padre',
                colegioId: conductor.rows[0]?.colegio_id || rutaCond.rows[0]?.colegio_id || null,
                conductorId: codigoData.entidad_id
            };
        }
        case 'padre_compartido': {
            const alumno = await client.query(
                'SELECT colegio_id FROM alumnos a LEFT JOIN rutas r ON r.id = a.ruta_id WHERE a.id = $1',
                [codigoData.entidad_id]
            );
            return {
                rol: 'padre',
                colegioId: alumno.rows[0]?.colegio_id || null,
                alumnoId: codigoData.entidad_id
            };
        }
        default:
            throw new Error('Tipo de codigo no valido');
    }
};

const tipoCodigoEsperadoPorRol = {
    admin: ['colegio_admin'],
    conductor: ['colegio_conductor'],
    padre: ['conductor_padre', 'padre_compartido'],
};

const validarRolParaCodigo = (rol, tipoCodigo) =>
    (tipoCodigoEsperadoPorRol[rol] || []).includes(tipoCodigo);

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
// 2. REGISTRO Y VINCULACIÓN GENERAL
// ============================================

const registroConCodigoHandler = async (req, res) => {
    const { nombre, email, correo, password, contrasena, telefono, dui, licencia, placa, codigo, rol } = req.body;
    const valorEmail = email || correo;
    const valorPassword = password || contrasena || req.body['contrase\u00f1a'];
    const emailNormalizado = String(valorEmail || '').trim().toLowerCase();

    if (!nombre || !emailNormalizado || !valorPassword || !rol) {
        return res.status(400).json({ error: 'Campos requeridos incompletos' });
    }

    try {
        const existeEmail = await pool.query(
            'SELECT id FROM usuarios WHERE email = $1 UNION SELECT id FROM super_admins WHERE email = $1',
            [emailNormalizado]
        );
        if (existeEmail.rows.length > 0) {
            return res.status(400).json({ error: 'El correo ya esta registrado' });
        }

        let colegioId = null;
        let conductorId = null;
        let alumnoId = null;
        let codigoData = null;

        if (codigo) {
            const verificacion = await obtenerCodigoValido(codigo);
            if (!verificacion.valido) return res.status(400).json({ error: verificacion.error });

            codigoData = verificacion.codigo;
            const destino = await resolverDestinoVinculacion(pool, codigoData);
            colegioId = destino.colegioId;
            conductorId = destino.conductorId;
            alumnoId = destino.alumnoId;

            if (!validarRolParaCodigo(rol, codigoData.tipo)) {
                return res.status(400).json({ error: 'Codigo no valido para tu rol' });
            }

            if (codigoData.tipo === 'colegio_admin' && colegioId) {
                const colegio = await pool.query('SELECT admin_id FROM colegios WHERE id = $1', [colegioId]);
                if (colegio.rows[0]?.admin_id) {
                    return res.status(400).json({ error: 'Este colegio ya tiene un administrador asignado' });
                }
            }
        }

        const passwordHash = await bcrypt.hash(valorPassword, 10);
        const resultado = await pool.query(
            `INSERT INTO usuarios (nombre, email, password, rol, telefono, dui, licencia, placa, colegio_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [nombre, emailNormalizado, passwordHash, rol, telefono, dui, licencia, placa, colegioId]
        );
        const nuevoUsuario = resultado.rows[0];

        if (codigoData) {
            await pool.query(
                'UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE id = $2',
                [nuevoUsuario.id, codigoData.id]
            );
            await pool.query(
                `INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado)
                 VALUES ($1, $2, $3, $4, $5, $6, 'activo')`,
                [codigoData.tipo, nuevoUsuario.id, codigoData.creado_por || 0, colegioId, conductorId, normalizarCodigo(codigo)]
            );

            if (codigoData.tipo === 'colegio_admin' && colegioId) {
                await pool.query('UPDATE colegios SET admin_id = $1, activo = true WHERE id = $2', [nuevoUsuario.id, colegioId]);
            }

            if (codigoData.tipo === 'padre_compartido' && alumnoId) {
                await pool.query(
                    `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
                     VALUES ($1, $2, 'compartido')
                     ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
                    [alumnoId, nuevoUsuario.id]
                );
            }
        }

        const token = firmarTokenSesion({
            id: nuevoUsuario.id,
            email: nuevoUsuario.email,
            rol: nuevoUsuario.rol,
            tipo: 'usuario',
            colegio_id: nuevoUsuario.colegio_id,
            colegioId: nuevoUsuario.colegio_id,
        });
        return res.status(201).json({ mensaje: 'Usuario registrado correctamente', token, usuario: nuevoUsuario });
    } catch (error) {
        console.error('Error registro:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

router.post('/registro-con-codigo', registroConCodigoHandler);

router.post('/registro-con-codigo-legacy', async (req, res) => {
    const { nombre, email, correo, password, contrasena, contraseña, telefono, dui, licencia, placa, codigo, rol } = req.body;
    const valorEmail = email || correo;
    const valorPassword = password || contrasena || req.body['contrase\u00f1a'];
    const emailNormalizado = String(valorEmail || '').trim().toLowerCase();

    if (!nombre || !emailNormalizado || !valorPassword || !rol) {
        return res.status(400).json({ error: 'Campos requeridos incompletos' });
    }

    try {
        const existeEmail = await pool.query('SELECT id FROM usuarios WHERE email = $1 UNION SELECT id FROM super_admins WHERE email = $1', [emailNormalizado]);
        if (existeEmail.rows.length > 0) return res.status(400).json({ error: 'El correo ya está registrado' });

        let colegioId = null;
        let conductorId = null;

        if (codigo) {
            const verificacion = await obtenerCodigoValido(codigo);
            if (!verificacion.valido) return res.status(400).json({ error: verificacion.error });
            const destino = await resolverDestinoVinculacion(pool, verificacion.codigo);
            colegioId = destino.colegioId;
            conductorId = destino.conductorId;
            
            if (!tipoCodigoEsperadoPorRol[rol].includes(verificacion.codigo.tipo)) {
                return res.status(400).json({ error: 'Código no válido para tu rol' });
            }
        }

        const passwordHash = await bcrypt.hash(valorPassword, 10);
        const resultado = await pool.query(
            `INSERT INTO usuarios (nombre, email, password, rol, telefono, dui, licencia, placa, colegio_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [nombre, emailNormalizado, passwordHash, rol, telefono, dui, licencia, placa, colegioId]
        );
        const nuevoUsuario = resultado.rows[0];

        if (codigo) {
            await pool.query('UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE codigo = $2', [nuevoUsuario.id, normalizarCodigo(codigo)]);
            await pool.query(`INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado) VALUES ($1, $2, $3, $4, $5, $6, 'activo')`, 
                [rol === 'admin' ? 'colegio_admin' : (rol === 'conductor' ? 'colegio_conductor' : 'conductor_padre'), nuevoUsuario.id, 0, colegioId, conductorId, codigo]);
            
            if (rol === 'admin' && colegioId) {
                await pool.query('UPDATE colegios SET admin_id = $1, activo = true WHERE id = $2', [nuevoUsuario.id, colegioId]);
            }
        }

        const token = firmarTokenSesion({ id: nuevoUsuario.id, email: nuevoUsuario.email, rol: nuevoUsuario.rol, tipo: 'usuario' });
        res.status(201).json({ mensaje: 'Usuario registrado correctamente', token, usuario: nuevoUsuario });
    } catch (error) {
        console.error('Error registro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
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

        const { rol, colegioId, conductorId, alumnoId } = await resolverDestinoVinculacion(client, verificacion.codigo);

        if (!validarRolParaCodigo(req.user.rol, verificacion.codigo.tipo) || req.user.rol !== rol) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Codigo no valido para el rol de tu cuenta' });
        }

        await client.query(
            'UPDATE usuarios SET colegio_id = COALESCE($1, colegio_id), activo = true WHERE id = $2',
            [colegioId, req.user.id]
        );

        if (req.user.rol === 'conductor' && colegioId) {
            await propagarColegioAConductorYPadres(client, req.user.id, colegioId);
        }

        if (verificacion.codigo.tipo === 'colegio_admin' && colegioId) {
            const colegio = await client.query('SELECT admin_id FROM colegios WHERE id = $1', [colegioId]);
            if (colegio.rows[0]?.admin_id && Number(colegio.rows[0].admin_id) !== Number(req.user.id)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Este colegio ya tiene un administrador asignado' });
            }

            await client.query('UPDATE colegios SET admin_id = $1, activo = true WHERE id = $2', [req.user.id, colegioId]);
        }

        if (verificacion.codigo.tipo === 'padre_compartido' && alumnoId) {
            await client.query(
                `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
                 VALUES ($1, $2, 'compartido')
                 ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
                [alumnoId, req.user.id]
            );
        }

        await client.query(
            `INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado)
             VALUES ($1, $2, $3, $4, $5, $6, 'activo')`,
            [verificacion.codigo.tipo, req.user.id, verificacion.codigo.creado_por, colegioId, conductorId, normalizarCodigo(codigo)]
        );

        await client.query(
            'UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE id = $2',
            [req.user.id, verificacion.codigo.id]
        );

        await client.query('COMMIT');
        return res.json({ mensaje: 'Vinculacion exitosa' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error vinculando con codigo:', error);
        return res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
};

router.post('/vincular-con-codigo', authenticateToken, vincularConCodigoHandler);

router.post('/vincular-con-codigo-legacy', authenticateToken, async (req, res) => {
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

        const { rol, colegioId, conductorId } = await resolverDestinoVinculacion(client, verificacion.codigo);
        
        await client.query('UPDATE usuarios SET colegio_id = COALESCE($1, colegio_id), activo = true WHERE id = $2', [colegioId, req.user.id]);
        
        if (req.user.rol === 'conductor' && colegioId) {
            await propagarColegioAConductorYPadres(client, req.user.id, colegioId);
        }

        await client.query(`INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado) VALUES ($1, $2, $3, $4, $5, $6, 'activo')`,
            [verificacion.codigo.tipo, req.user.id, verificacion.codigo.creado_por, colegioId, conductorId, normalizarCodigo(codigo)]);

        await client.query('UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE id = $2', [req.user.id, verificacion.codigo.id]);

        await client.query('COMMIT');
        res.json({ mensaje: 'Vinculación exitosa' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

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
        const codigo = generarCodigo(8);
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
        const codigo = generarCodigo(8);
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
        const resultado = await pool.query(`SELECT c.*, co.nombre as colegio_nombre, u.nombre as conductor_nombre FROM codigos_invitacion c LEFT JOIN colegios co ON co.id = c.entidad_id LEFT JOIN usuarios u ON u.id = c.entidad_id WHERE c.codigo = $1 AND c.activo = true`, [normalizarCodigo(req.params.codigo)]);
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json({ valido: true, ...resultado.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

router.get('/padre/mis-conductores', authenticateToken, requireRole('padre'), async (req, res) => {
    try {
        const resultado = await pool.query(`SELECT u.* FROM usuarios u JOIN vinculaciones v ON v.conductor_id = u.id WHERE v.entidad_id = $1 AND v.tipo = 'conductor_padre' AND v.estado = 'activo'`, [req.user.id]);
        res.json({ conductores: resultado.rows });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

module.exports = router;
