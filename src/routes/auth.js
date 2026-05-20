require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../database');
const validate = require('deep-email-validator').default;
const { authenticateToken } = require('../middleware/auth');
const { SESSION_EXPIRES_IN, firmarTokenSesion } = require('../utils/authTokens');

const ROLES_VALIDOS_USUARIO = ['padre', 'conductor', 'admin'];

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, correo, password, contrasena } = req.body;
    const valorEmail = email || correo;
    const valorPassword = password || contrasena || req.body['contrase\u00f1a'];
    const emailNormalizado = String(valorEmail || '').trim().toLowerCase();

    console.log(`[LOGIN] Intento para: ${emailNormalizado}`);

    if (!emailNormalizado || !valorPassword) {
        return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    try {
        // 1. Primero buscar en super_admins (menos filas, más privilegio)
        console.log(`[LOGIN] Buscando en super_admins: ${emailNormalizado}`);
        const resultadoSuperAdmin = await pool.query(
            'SELECT * FROM super_admins WHERE LOWER(email) = $1',
            [emailNormalizado]
        );

        if (resultadoSuperAdmin.rows.length > 0) {
            console.log(`[LOGIN] Superadmin encontrado: ${emailNormalizado}. Verificando password...`);
            const superAdmin = resultadoSuperAdmin.rows[0];
            const passwordValida = await bcrypt.compare(valorPassword, superAdmin.password);

            if (!passwordValida) {
                console.log(`[LOGIN] Superadmin ${emailNormalizado}: Password incorrecta`);
                return res.status(401).json({ error: 'Credenciales incorrectas' });
            }

            console.log(`[LOGIN] Superadmin ${emailNormalizado}: Éxito total`);
            const token = firmarTokenSesion({
                id: superAdmin.id,
                email: superAdmin.email,
                rol: 'super_admin',
                tipo: 'super_admin',
            });

            return res.json({
                token,
                expiresIn: SESSION_EXPIRES_IN,
                usuario: {
                    id: superAdmin.id,
                    nombre: superAdmin.nombre,
                    email: superAdmin.email,
                    rol: 'super_admin',
                }
            });
        }

        // 2. Si no es superadmin, buscar en usuarios normales
        const resultadoUsuarios = await pool.query(
            `SELECT u.*, c.logo_url AS colegio_logo_url, c.nombre AS colegio_nombre
             FROM usuarios u
             LEFT JOIN colegios c ON c.id = u.colegio_id
             WHERE LOWER(u.email) = $1`,
            [emailNormalizado]
        );

        if (resultadoUsuarios.rows.length === 0) {
            console.log(`[LOGIN] Usuario ${emailNormalizado}: No encontrado`);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const usuario = resultadoUsuarios.rows[0];

        // Verificar si está activo
        if (usuario.activo === false) {
            console.log(`[LOGIN] Usuario ${emailNormalizado}: Inactivo`);
            return res.status(403).json({ error: 'Usuario inactivo. Contacte al administrador.' });
        }

        const passwordValida = await bcrypt.compare(valorPassword, usuario.password);
        if (!passwordValida) {
            console.log(`[LOGIN] Usuario ${emailNormalizado}: Password incorrecta`);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        console.log(`[LOGIN] Usuario ${emailNormalizado} (${usuario.rol}): Éxito`);
        const token = firmarTokenSesion({
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            tipo: 'usuario',
            colegio_id: usuario.colegio_id,
            colegioId: usuario.colegio_id,
            colegio_nombre: usuario.colegio_nombre || null,
        });

        return res.json({
            token,
            expiresIn: SESSION_EXPIRES_IN,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                telefono: usuario.telefono,
                colegioId: usuario.colegio_id,
                colegioNombre: usuario.colegio_nombre || null,
                logoUrl: usuario.colegio_logo_url || null,
            }
        });

    } catch (error) {
        console.error('[LOGIN] Error crítico:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

const { obtenerCodigoValido, resolverDestinoVinculacion, validarRolParaCodigo, propagarColegioAConductorYPadres } = require('./vinculaciones-logic'); // Separar la lógica para reutilizarla

// POST /api/auth/registro
router.post('/registro', async (req, res) => {
    const {
        nombre, email, correo, password, contrasena, contraseña, rol, telefono, dui, licencia, placa,
        fechaInicio, fechaFin, codigo, alumnoNombre, alumnoGrado, colegioNombre, direccion,
        turno_estudio, turnoEstudio
    } = req.body;
    
    const valorEmail = email || correo;
    const valorPassword = password || contrasena || req.body['contrase\u00f1a'];
    const emailNormalizado = String(valorEmail || '').trim().toLowerCase();

    if (!nombre || !emailNormalizado || !valorPassword || !rol) {
        return res.status(400).json({ error: 'Nombre, email, password y rol son requeridos' });
    }

    if (!ROLES_VALIDOS_USUARIO.includes(rol)) {
        return res.status(400).json({ error: 'Rol inválido para registro' });
    }

    // 0. Validación de Email (Regex estándar para máxima compatibilidad)
    const esFormatoValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado);
    if (!esFormatoValido) {
        return res.status(400).json({ 
            error: 'Email con formato inválido', 
            detalle: 'Asegúrese de que el correo esté bien escrito (ejemplo@dominio.com).',
            codigo: 'EMAIL_VALIDATION_FAILED'
        });
    }
    console.log(`[REGISTRO] Formato validado para ${emailNormalizado}. Procediendo con el alta.`);

    try {
        await pool.ensureReady();
    } catch (error) {
        return res.status(503).json({
            error: 'Base de datos no disponible',
            detalle: 'No se pudo preparar el esquema para registrar alumnos'
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar existencia
        const existe = await client.query(
            `SELECT email FROM usuarios WHERE email = $1 UNION SELECT email FROM super_admins WHERE email = $1`,
            [emailNormalizado]
        );
        if (existe.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'El correo ya está registrado' });
        }

        // 2. Procesar Código de Vinculación (si existe)
        let colegioId = null;
        let conductorId = null;
        let alumnoVinculadoId = null;
        let codigoData = null;

        if (codigo) {
            const verificacion = await obtenerCodigoValido(codigo);
            if (!verificacion.valido) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: verificacion.error });
            }

            codigoData = verificacion.codigo;
            const destino = await resolverDestinoVinculacion(client, codigoData);
            colegioId = destino.colegioId;
            conductorId = destino.conductorId;
            alumnoVinculadoId = destino.alumnoId;

            if (!validarRolParaCodigo(rol, codigoData.tipo)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El código ingresado no corresponde a tu rol' });
            }
        }

        // 3. Crear Usuario
        const passwordHash = await bcrypt.hash(valorPassword, 10);
        const resultadoUsuario = await client.query(
            `INSERT INTO usuarios (nombre, email, password, rol, telefono, dui, licencia, placa, colegio_id, fecha_inicio_servicio, fecha_fin_servicio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, nombre, email, rol, telefono, colegio_id`,
            [nombre, emailNormalizado, passwordHash, rol, telefono, dui, licencia, placa, colegioId, fechaInicio || null, fechaFin || null]
        );
        const usuario = resultadoUsuario.rows[0];

        // 4. Crear Alumno (si es padre y envió datos)
        let nuevoAlumno = null;
        if (rol === 'padre' && alumnoNombre) {
            let rutaId = null;
            if (conductorId) {
                const { obtenerOCrearRutaConductor } = require('../controllers/asignacionesController');
                const rutas = await obtenerOCrearRutaConductor(conductorId);
                if (rutas && rutas.length > 0) {
                    rutaId = rutas[0].id;
                }
            }

            const turnoRaw = turno_estudio || turnoEstudio || 'matutino';
            const turnoMapeado = (turnoRaw === 'mañana') ? 'matutino' : (turnoRaw === 'tarde') ? 'vespertino' : turnoRaw;

            const alumnoRes = await client.query(
                `INSERT INTO alumnos (nombre, grado, padre_id, ruta_id, colegio_id, colegio_nombre, turno_estudio, padre_email, parada)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [alumnoNombre, alumnoGrado || null, usuario.id, rutaId, colegioId, colegioNombre || null, turnoMapeado, emailNormalizado, direccion || null]
            );
            nuevoAlumno = alumnoRes.rows[0];

            await client.query(
                `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
                 VALUES ($1, $2, 'principal')
                 ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
                [nuevoAlumno.id, usuario.id]
            );

            // Sincronizar punto si el alumno ya tuviera geoposición (en registro es raro, pero por consistencia)
            if (nuevoAlumno.latitude && nuevoAlumno.longitude && rutaId) {
                const { sincronizarPuntoAlumno } = require('../utils/rutaPuntos');
                await sincronizarPuntoAlumno(nuevoAlumno.id, client);
            }
        }

        // 4.5. Vincular Alumnos Huérfanos por Email
        if (rol === 'padre') {
            const huerfanos = await client.query(
                `UPDATE alumnos SET padre_id = $1 WHERE LOWER(padre_email) = $2 AND padre_id IS NULL RETURNING id`,
                [usuario.id, emailNormalizado]
            );
            for (const huerfano of huerfanos.rows) {
                await client.query(
                    `INSERT INTO alumno_padres (alumno_id, padre_id, rol) VALUES ($1, $2, 'principal') ON CONFLICT DO NOTHING`,
                    [huerfano.id, usuario.id]
                );
            }
        }

        // 5. Finalizar Vinculación por Código
        if (codigoData) {
            await client.query('UPDATE codigos_invitacion SET usos_actuales = usos_actuales + 1, usado_por = $1, usado_en = NOW() WHERE id = $2', [usuario.id, codigoData.id]);
            await client.query(
                `INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, conductor_id, codigo_usado, estado)
                 VALUES ($1, $2, $3, $4, $5, $6, 'activo')`,
                [codigoData.tipo, usuario.id, codigoData.creado_por || 0, colegioId, conductorId, codigo.toUpperCase()]
            );

            if (codigoData.tipo === 'colegio_admin' && colegioId) {
                await client.query('UPDATE colegios SET admin_id = $1, activo = true WHERE id = $2', [usuario.id, colegioId]);
            }
            if (codigoData.tipo === 'padre_compartido' && alumnoVinculadoId) {
                await client.query(`INSERT INTO alumno_padres (alumno_id, padre_id, rol) VALUES ($1, $2, 'compartido') ON CONFLICT DO NOTHING`, [alumnoVinculadoId, usuario.id]);
            }
        }

        await client.query('COMMIT');

        const token = firmarTokenSesion({
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            tipo: 'usuario',
            colegio_id: usuario.colegio_id,
            colegioId: usuario.colegio_id,
        });

        res.status(201).json({
            mensaje: 'Usuario registrado y vinculado correctamente',
            token,
            usuario: { ...usuario, colegioId: usuario.colegio_id },
            alumno: nuevoAlumno
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[REGISTRO] Error crítico en la transacción:', {
            mensaje: error.message,
            stack: error.stack,
            detail: error.detail, // PG specific
            code: error.code     // PG specific
        });
        res.status(500).json({ 
            error: 'Error interno del servidor',
            detalle: error.message 
        });
    } finally {
        client.release();
    }
});

// GET /api/auth/perfil/:id
router.get('/perfil/:id', async (req, res) => {
    try {
        const resultado = await pool.query(
            'SELECT id, nombre, email, telefono, dui, licencia, placa, rol FROM usuarios WHERE id = $1',
            [req.params.id]
        );
        if (resultado.rows.length === 0)
            return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(resultado.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/auth/perfil/:id
router.put('/perfil/:id', async (req, res) => {
    const { nombre, telefono, dui, licencia, placa } = req.body;
    try {
        const resultado = await pool.query(
            `UPDATE usuarios SET nombre=$1, telefono=$2, dui=$3, licencia=$4, placa=$5
       WHERE id=$6 RETURNING id, nombre, email, telefono, dui, licencia, placa`,
            [nombre, telefono, dui, licencia, placa, req.params.id]
        );
        res.json(resultado.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/auth/cambiar-password
router.post('/cambiar-password', async (req, res) => {
    const { usuarioId, passwordActual, passwordNueva } = req.body;
    try {
        const resultado = await pool.query(
            'SELECT * FROM usuarios WHERE id = $1', [usuarioId]
        );
        if (resultado.rows.length === 0)
            return res.status(404).json({ error: 'Usuario no encontrado' });

        const valida = await bcrypt.compare(passwordActual, resultado.rows[0].password);
        if (!valida)
            return res.status(401).json({ error: 'Contraseña actual incorrecta' });

        const hash = await bcrypt.hash(passwordNueva, 10);
        await pool.query('UPDATE usuarios SET password=$1 WHERE id=$2', [hash, usuarioId]);
        res.json({ mensaje: 'Contraseña actualizada correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/auth/me
// Verifica el token y devuelve los datos del usuario actual
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const { id, rol, tipo } = req.user;

        if (tipo === 'super_admin') {
            const result = await pool.query('SELECT id, nombre, email FROM super_admins WHERE id = $1', [id]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Superadmin no encontrado' });
            return res.json({
                usuario: {
                    ...result.rows[0],
                    rol: 'super_admin'
                }
            });
        }

        const result = await pool.query(
            `SELECT u.*, c.nombre as colegio_nombre, c.logo_url as colegio_logo_url
             FROM usuarios u
             LEFT JOIN colegios c ON c.id = u.colegio_id
             WHERE u.id = $1`,
            [id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const usuario = result.rows[0];
        res.json({
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                telefono: usuario.telefono,
                colegioId: usuario.colegio_id,
                colegioNombre: usuario.colegio_nombre || null,
                logoUrl: usuario.colegio_logo_url || null,
            }
        });
    } catch (error) {
        console.error('Error en /me:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
