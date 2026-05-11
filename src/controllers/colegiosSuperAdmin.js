const bcrypt = require('bcryptjs');
const pool = require('../database');

const parseBoolean = (value, defaultValue = true) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
};

const generarCodigo = (longitud = 8) => {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = '';
    for (let i = 0; i < longitud; i++) {
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

const listarColegiosSuperAdmin = async (req, res) => {
    try {
        console.log('[LISTAR COLEGIOS] req.user:', req.user);

        const resultado = await pool.query(`
            SELECT 
                c.id,
                c.nombre,
                c.logo_url,
                c.plan,
                c.activo,
                CASE
                    WHEN c.admin_id IS NOT NULL AND c.activo = true THEN 'activo'
                    WHEN c.admin_id IS NULL THEN 'pendiente_vinculacion'
                    ELSE 'inactivo'
                END as estado_vinculacion,
                c.dias_prueba_restantes,
                c.creado_en,
                c.admin_id,
                (c.admin_id IS NOT NULL) as tiene_admin,
                u.nombre as admin_nombre,
                u.email as admin_email,
                u.telefono as admin_telefono
            FROM colegios c
            LEFT JOIN usuarios u ON u.id = c.admin_id
            ORDER BY c.nombre
        `);

        console.log('[LISTAR COLEGIOS] total:', resultado.rows.length);
        console.log('[LISTAR COLEGIOS] primeros:', resultado.rows.slice(0, 5));

        return res.json({ colegios: resultado.rows });
    } catch (error) {
        console.error('Error listando colegios superadmin:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const crearColegioSuperAdmin = async (req, res) => {
    try {
        console.log('[CREAR COLEGIO] req.user:', req.user);
        console.log('[CREAR COLEGIO] req.body:', req.body);

        const {
            nombre,
            logo_url = null,
            plan = 'trial',
            admin_id = null,
            activo,
            diasPrueba,
            dias_prueba,
        } = req.body;

        const diasPruebaRestantes =
            typeof diasPrueba !== 'undefined'
                ? Number(diasPrueba)
                : typeof dias_prueba !== 'undefined'
                    ? Number(dias_prueba)
                    : plan === 'trial'
                        ? 30
                        : null;

        const payload = {
            nombre,
            logo_url,
            plan,
            activo: parseBoolean(activo, !!admin_id),
            dias_prueba_restantes: Number.isFinite(diasPruebaRestantes) ? diasPruebaRestantes : null,
            admin_id: admin_id || null,
        };

        console.log('[CREAR COLEGIO] payload final:', payload);

        if (!nombre) {
            return res.status(400).json({ error: 'El nombre del colegio es requerido' });
        }

        const columnaAdminId = await pool.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = 'colegios'
              AND column_name = 'admin_id'
            LIMIT 1
        `);

        const nuevoColegio = columnaAdminId.rows.length > 0
            ? await pool.query(
                `INSERT INTO colegios (nombre, logo_url, plan, activo, dias_prueba_restantes, admin_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    payload.nombre,
                    payload.logo_url,
                    payload.plan,
                    payload.activo,
                    payload.dias_prueba_restantes,
                    payload.admin_id,
                ]
            )
            : await pool.query(
                `INSERT INTO colegios (nombre, logo_url, plan, activo, dias_prueba_restantes)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [
                    payload.nombre,
                    payload.logo_url,
                    payload.plan,
                    payload.activo,
                    payload.dias_prueba_restantes,
                ]
            );

        console.log('[CREAR COLEGIO] insert result:', nuevoColegio.rows[0]);

        return res.status(201).json({
            colegio: nuevoColegio.rows[0],
            mensaje: 'Colegio creado correctamente',
        });
    } catch (error) {
        console.error('Error creando colegio superadmin:', {
            message: error.message,
            code: error.code,
            detail: error.detail,
            constraint: error.constraint,
            table: error.table,
            column: error.column,
        });
        return res.status(500).json({ error: error.message || 'Error interno del servidor' });
    }
};

const generarCodigoAdminSuperAdmin = async (req, res) => {
    try {
        console.log('[CODIGO ADMIN] req.user:', req.user);
        console.log('[CODIGO ADMIN] req.params:', req.params);
        console.log('[CODIGO ADMIN] req.body:', req.body);

        const colegioId = Number(req.params.colegioId);
        const maxUsos = Number(req.body?.maxUsos ?? 1);
        const diasValidez = Number(req.body?.diasValidez ?? 7);
        const creadoPor = Number(req.user?.id);

        if (!Number.isInteger(colegioId) || colegioId <= 0) {
            return res.status(400).json({ error: 'colegioId invalido' });
        }

        if (!Number.isInteger(maxUsos) || maxUsos <= 0) {
            return res.status(400).json({ error: 'maxUsos debe ser un entero mayor que cero' });
        }

        if (!Number.isInteger(diasValidez) || diasValidez < 0) {
            return res.status(400).json({ error: 'diasValidez debe ser un entero mayor o igual a cero' });
        }

        if (!Number.isInteger(creadoPor) || creadoPor <= 0) {
            return res.status(401).json({ error: 'Usuario autenticado invalido' });
        }

        const colegioEncontrado = await pool.query(
            'SELECT id, nombre, admin_id FROM colegios WHERE id = $1',
            [colegioId]
        );

        console.log('[CODIGO ADMIN] colegio encontrado:', colegioEncontrado.rows[0] || null);

        if (colegioEncontrado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        if (colegioEncontrado.rows[0].admin_id) {
            return res.status(400).json({ error: 'Este colegio ya tiene un administrador asignado' });
        }

        let codigo;
        let existe = true;
        let intentos = 0;
        do {
            codigo = generarCodigo(8);
            const check = await pool.query(
                'SELECT id FROM codigos_invitacion WHERE codigo = $1',
                [codigo]
            );
            existe = check.rows.length > 0;
            intentos++;
        } while (existe && intentos < 10);

        if (existe) {
            return res.status(500).json({ error: 'No se pudo generar un codigo unico, intenta de nuevo' });
        }

        const expiraEn = Number(diasValidez) > 0
            ? new Date(Date.now() + Number(diasValidez) * 24 * 60 * 60 * 1000)
            : null;

        console.log('[CODIGO ADMIN] codigo generado:', codigo);

        const resultado = await pool.query(
            `INSERT INTO codigos_invitacion (codigo, tipo, entidad_id, creado_por, max_usos, expira_en)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [codigo, 'colegio_admin', colegioId, creadoPor, maxUsos, expiraEn]
        );

        return res.status(201).json({
            mensaje: 'Codigo de invitacion generado correctamente',
            codigo: resultado.rows[0].codigo,
            expira_en: resultado.rows[0].expira_en,
            colegio: colegioEncontrado.rows[0].nombre,
        });
    } catch (error) {
        console.error('Error generando codigo admin superadmin:', {
            message: error.message,
            code: error.code,
            detail: error.detail,
            hint: error.hint,
            table: error.table,
            column: error.column,
            constraint: error.constraint,
        });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const eliminarColegioSuperAdmin = async (req, res) => {
    const colegioId = Number(req.params.colegioId);
    
    if (!Number.isInteger(colegioId) || colegioId <= 0) {
        return res.status(400).json({ error: 'colegioId invalido' });
    }

    console.log(`[ELIMINAR COLEGIO] Iniciando eliminación de colegio ID: ${colegioId}`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verificar si el colegio existe
        const colegio = await client.query('SELECT * FROM colegios WHERE id = $1', [colegioId]);
        if (colegio.rows.length === 0) {
            console.log(`[ELIMINAR COLEGIO] Colegio ${colegioId} no encontrado`);
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        console.log(`[ELIMINAR COLEGIO] Eliminando dependencias de: ${colegio.rows[0].nombre}`);

        // 2. Romper la relación circular con el admin si existe
        await client.query('UPDATE colegios SET admin_id = NULL WHERE id = $1', [colegioId]);

        // 3. Eliminar dependencias profundas (rutas -> alumnos -> ausencias, etc)
        // a0. Relaciones de padres y cambios programados de los alumnos del colegio
        await client.query(`
            DELETE FROM alumno_padres
            WHERE alumno_id IN (
                SELECT a.id FROM alumnos a
                JOIN rutas r ON r.id = a.ruta_id
                WHERE r.colegio_id = $1
            )
        `, [colegioId]);

        await client.query(`
            DELETE FROM programacion_rutas
            WHERE alumno_id IN (
                SELECT a.id FROM alumnos a
                JOIN rutas r ON r.id = a.ruta_id
                WHERE r.colegio_id = $1
            )
        `, [colegioId]);

        // a. Ausencias
        await client.query(`
            DELETE FROM ausencias 
            WHERE alumno_id IN (
                SELECT a.id FROM alumnos a
                JOIN rutas r ON r.id = a.ruta_id
                WHERE r.colegio_id = $1
            )
        `, [colegioId]);

        // b. Puntos de ruta
        await client.query(`
            DELETE FROM puntos_ruta 
            WHERE ruta_id IN (SELECT id FROM rutas WHERE colegio_id = $1)
        `, [colegioId]);

        // b1. Historial de ubicaciones (GPS)
        await client.query(`
            DELETE FROM historial_ubicaciones 
            WHERE ruta_id IN (SELECT id FROM rutas WHERE colegio_id = $1)
        `, [colegioId]);

        // c. Eventos de ruta
        await client.query(`
            DELETE FROM eventos_ruta 
            WHERE ruta_id IN (SELECT id FROM rutas WHERE colegio_id = $1)
        `, [colegioId]);

        // d. Alumnos
        await client.query(`
            DELETE FROM alumnos 
            WHERE ruta_id IN (SELECT id FROM rutas WHERE colegio_id = $1)
        `, [colegioId]);

        // e. Rutas
        await client.query('DELETE FROM rutas WHERE colegio_id = $1', [colegioId]);

        // f. Pagos de usuarios del colegio
        await client.query(`
            DELETE FROM pagos 
            WHERE padre_id IN (SELECT id FROM usuarios WHERE colegio_id = $1)
        `, [colegioId]);

        // g. Tokens push de usuarios del colegio
        await client.query(`
            DELETE FROM tokens_push 
            WHERE usuario_id IN (SELECT id FROM usuarios WHERE colegio_id = $1)
        `, [colegioId]);

        // h. Vinculaciones
        await client.query('DELETE FROM vinculaciones WHERE colegio_id = $1', [colegioId]);

        // i. Anuncios de voz
        await client.query('DELETE FROM anuncios_voz WHERE colegio_id = $1', [colegioId]);

        // j. Avisos informativos
        await client.query('DELETE FROM avisos_informativos WHERE colegio_id = $1', [colegioId]);

        // k. Códigos de invitación
        await client.query(`
            DELETE FROM codigos_invitacion 
            WHERE (tipo IN ('colegio_admin', 'colegio_conductor') AND entidad_id = $1)
               OR (usado_por IN (SELECT id FROM usuarios WHERE colegio_id = $1))
        `, [colegioId]);

        // 4. Para los usuarios vinculados al colegio, les quitamos la vinculación y los desactivamos
        await client.query('UPDATE usuarios SET colegio_id = NULL, activo = false WHERE colegio_id = $1', [colegioId]);

        // 5. Finalmente eliminar el colegio
        const deleteResult = await client.query('DELETE FROM colegios WHERE id = $1 RETURNING id', [colegioId]);

        if (deleteResult.rows.length === 0) {
            throw new Error('No se pudo eliminar el registro del colegio');
        }

        await client.query('COMMIT');
        console.log(`[ELIMINAR COLEGIO] Colegio ${colegioId} eliminado exitosamente`);
        return res.json({ mensaje: 'Colegio y datos de vinculación eliminados correctamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ELIMINAR COLEGIO] Error:', error);

        if (error.code === '23503') {
            return res.status(400).json({
                error: 'No se puede eliminar el colegio porque tiene recursos (rutas, alumnos, pagos) asociados. Por favor, elimine esos recursos primero.',
                detalle: error.detail
            });
        }

        return res.status(500).json({
            error: 'Error interno del servidor al eliminar el colegio',
            detalle: error.message
        });
    } finally {
        client.release();
    }
};

const editarColegioSuperAdmin = async (req, res) => {
    const { colegioId } = req.params;
    const { nombre, logo_url, plan, dias_prueba_restantes, dias_prueba, diasPrueba } = req.body;
    const diasPruebaRestantes =
        dias_prueba_restantes ?? dias_prueba ?? diasPrueba ?? null;

    try {
        const resultado = await pool.query(
            `UPDATE colegios
             SET nombre = COALESCE($1, nombre),
                 logo_url = COALESCE($2, logo_url),
                 plan = COALESCE($3, plan),
                 dias_prueba_restantes = COALESCE($4, dias_prueba_restantes)
             WHERE id = $5
             RETURNING *`,
            [nombre, logo_url, plan, diasPruebaRestantes, colegioId]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        res.json({
            mensaje: 'Colegio actualizado correctamente',
            colegio: resultado.rows[0]
        });
    } catch (error) {
        console.error('Error editando colegio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const toggleColegioSuperAdmin = async (req, res) => {
    const { colegioId } = req.params;
    const { activo } = req.body;

    try {
        const resultado = await pool.query(
            'UPDATE colegios SET activo = $1 WHERE id = $2 RETURNING *',
            [activo, colegioId]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        res.json({
            mensaje: `Colegio ${activo ? 'activado' : 'desactivado'} correctamente`,
            colegio: resultado.rows[0]
        });
    } catch (error) {
        console.error('Error toggle activo colegio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const desvincularAdminSuperAdmin = async (req, res) => {
    const { colegioId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verificar el colegio y su admin actual
        const colegio = await client.query('SELECT admin_id, nombre FROM colegios WHERE id = $1', [colegioId]);
        if (colegio.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        const adminId = colegio.rows[0].admin_id;
        if (!adminId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Este colegio no tiene un administrador vinculado actualmente' });
        }

        // 2. Romper el vínculo en la tabla colegios
        await client.query('UPDATE colegios SET admin_id = NULL, activo = false WHERE id = $1', [colegioId]);

        // 3. Actualizar al usuario admin (quitarle el colegio y desactivarlo o degradarlo)
        // Lo desactivamos por seguridad, el superadmin puede reactivarlo luego si lo desea
        await client.query('UPDATE usuarios SET colegio_id = NULL, activo = false WHERE id = $1', [adminId]);

        // 4. Marcar la vinculación como inactiva
        await client.query(
            `UPDATE vinculaciones 
             SET estado = 'inactivo', actualizado_en = NOW() 
             WHERE entidad_id = $1 AND colegio_id = $2 AND tipo = 'colegio_admin'`,
            [adminId, colegioId]
        );

        await client.query('COMMIT');
        res.json({ 
            mensaje: `Administrador desvinculado de ${colegio.rows[0].nombre} correctamente. El colegio y el usuario han quedado inactivos.` 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error desvinculando admin superadmin:', error);
        res.status(500).json({ error: 'Error interno del servidor al desvincular' });
    } finally {
        client.release();
    }
};

const asignarAdminSuperAdmin = async (req, res) => {
    const { colegioId } = req.params;
    const { email, nombre, password } = req.body;
    const emailNormalizado = String(email || '').trim().toLowerCase();

    if (!emailNormalizado) {
        return res.status(400).json({ error: 'El email del usuario es requerido' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const colegio = await client.query('SELECT * FROM colegios WHERE id = $1', [colegioId]);
        if (colegio.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        if (colegio.rows[0].admin_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Este colegio ya tiene un administrador asignado. Desvinculalo antes de asignar otro.' });
        }

        const superAdminExistente = await client.query(
            'SELECT id FROM super_admins WHERE LOWER(email) = $1 LIMIT 1',
            [emailNormalizado]
        );

        if (superAdminExistente.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No puedes asignar como administrador de colegio un correo que ya pertenece a un superadministrador' });
        }

        const usuario = await client.query('SELECT * FROM usuarios WHERE LOWER(email) = $1', [emailNormalizado]);
        let user = usuario.rows[0] || null;
        let passwordTemporal = null;

        if (!user) {
            passwordTemporal = String(password || '').trim() || generarPasswordTemporal();
            if (passwordTemporal.length < 8) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'La contraseña temporal debe tener al menos 8 caracteres' });
            }

            const nombreAdmin = String(nombre || '').trim() || emailNormalizado.split('@')[0] || 'Administrador';
            const passwordHash = await bcrypt.hash(passwordTemporal, 10);
            const nuevoUsuario = await client.query(
                `INSERT INTO usuarios (nombre, email, password, rol, colegio_id, activo)
                 VALUES ($1, $2, $3, 'admin', $4, true)
                 RETURNING *`,
                [nombreAdmin, emailNormalizado, passwordHash, colegioId]
            );
            user = nuevoUsuario.rows[0];
        }

        // Verificar si ya es admin de otro colegio
        if (user.colegio_id && user.colegio_id !== parseInt(colegioId) && user.rol === 'admin') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Este usuario ya es administrador de otro colegio' });
        }

        // 1. Actualizar el usuario
        await client.query(
            'UPDATE usuarios SET colegio_id = $1, rol = $2, activo = true WHERE id = $3',
            [colegioId, 'admin', user.id]
        );

        // 2. Actualizar el colegio
        await client.query(
            'UPDATE colegios SET admin_id = $1, activo = true WHERE id = $2',
            [user.id, colegioId]
        );

        // 3. Registrar o actualizar vinculación
        await client.query(
            `INSERT INTO vinculaciones (tipo, entidad_id, vinculado_por, colegio_id, estado)
             VALUES ('colegio_admin', $1, $2, $3, 'activo')
             ON CONFLICT DO NOTHING`,
            [user.id, req.user.id, colegioId]
        );

        await client.query('COMMIT');

        res.json({
            mensaje: passwordTemporal
                ? 'Administrador creado y asignado correctamente'
                : 'Administrador asignado correctamente',
            usuario: {
                id: user.id,
                nombre: user.nombre,
                email: user.email,
                rol: 'admin'
            },
            credenciales: passwordTemporal
                ? { email: user.email, passwordTemporal }
                : null
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error asignando admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
};

module.exports = {
    listarColegiosSuperAdmin,
    crearColegioSuperAdmin,
    generarCodigoAdminSuperAdmin,
    eliminarColegioSuperAdmin,
    editarColegioSuperAdmin,
    toggleColegioSuperAdmin,
    desvincularAdminSuperAdmin,
    asignarAdminSuperAdmin,
};
