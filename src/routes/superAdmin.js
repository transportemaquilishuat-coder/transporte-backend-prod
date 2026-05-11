require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
    listarColegiosSuperAdmin,
    crearColegioSuperAdmin,
    generarCodigoAdminSuperAdmin,
    eliminarColegioSuperAdmin,
    editarColegioSuperAdmin,
    toggleColegioSuperAdmin,
    asignarAdminSuperAdmin,
    desvincularAdminSuperAdmin,
} = require('../controllers/colegiosSuperAdmin');

const { SESSION_EXPIRES_IN, firmarTokenSesion } = require('../utils/authTokens');

router.use(authenticateToken, requireRole('super_admin'));

const parseHora = (valor) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(valor || '').trim());
    if (!match) return null;

    const hora = Number(match[1]);
    const minuto = Number(match[2]);
    if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null;

    return { hora, minuto };
};

const restarCincoMinutos = (horaTexto) => {
    const parsed = parseHora(horaTexto);
    if (!parsed) return null;

    const fecha = new Date(2026, 0, 1, parsed.hora, parsed.minuto, 0, 0);
    fecha.setMinutes(fecha.getMinutes() - 5);
    return `${fecha.getHours().toString().padStart(2, '0')}:${fecha.getMinutes().toString().padStart(2, '0')}`;
};

const validarDiasSemana = (diasSemana) =>
    Array.isArray(diasSemana) &&
    diasSemana.every((dia) => Number.isInteger(dia) && dia >= 0 && dia <= 6);

const TOTAL_MENSAJES_DIARIOS = 31;

const normalizarMensajesDiarios = (mensajes, diasDelMes = 31) => {
    const diasValidos = Math.min(diasDelMes, TOTAL_MENSAJES_DIARIOS);
    if (!Array.isArray(mensajes) || mensajes.length < diasValidos) {
        return null;
    }

    return mensajes.slice(0, diasValidos).map((mensaje) => String(mensaje || '').trim());
};

const completarMensajesDiarios = (mensajes, diasDelMes = 31) => {
    const valores = Array.isArray(mensajes) ? mensajes : [];
    const diasValidos = Math.min(diasDelMes, TOTAL_MENSAJES_DIARIOS);
    return Array.from({ length: diasValidos }, (_, index) => String(valores[index] || ''));
};

const parseJsonArray = (valor) => {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor;

    try {
        const parsed = JSON.parse(valor || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
};

const obtenerMensajeParaDia = (mensajesDiarios, dia, mensajeFallback) => {
    const mensajeDelDia = String(mensajesDiarios[dia - 1] || '').trim();
    return mensajeDelDia || mensajeFallback;
};

const generarPasswordTemporal = (longitud = 10) => {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';

    for (let i = 0; i < longitud; i += 1) {
        password += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }

    return password;
};

router.get('/dashboard', async (req, res) => {
    try {
        const [colegios, anuncios, superAdmins] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM colegios WHERE activo = true'),
            pool.query('SELECT COUNT(*) FROM anuncios_voz WHERE activo = true'),
            pool.query('SELECT COUNT(*) FROM super_admins'),
        ]);

        res.json({
            totalColegios: parseInt(colegios.rows[0].count, 10),
            totalAnunciosActivos: parseInt(anuncios.rows[0].count, 10),
            totalSuperAdmins: parseInt(superAdmins.rows[0].count, 10),
        });
    } catch (error) {
        console.error('Error dashboard super admin:', error.message);
        res.status(500).json({ error: error.message });
    }
});

router.get('/colegios', listarColegiosSuperAdmin);
router.post('/colegios', crearColegioSuperAdmin);
router.put('/colegios/:colegioId', editarColegioSuperAdmin);
router.patch('/colegios/:colegioId/toggle-activo', toggleColegioSuperAdmin);
router.post('/colegios/:colegioId/codigo', generarCodigoAdminSuperAdmin);
router.delete('/colegios/:colegioId', eliminarColegioSuperAdmin);
router.delete('/colegios/:id', (req, res, next) => {
    req.params.colegioId = req.params.id;
    next();
}, eliminarColegioSuperAdmin);

router.post('/colegios/:colegioId/asignar-admin', asignarAdminSuperAdmin);
router.post('/colegios/:colegioId/desvincular-admin', desvincularAdminSuperAdmin);
router.delete('/colegios/:colegioId/desvincular-admin', desvincularAdminSuperAdmin);

// POST /api/super-admin/colegios/:colegioId/impersonate
// Permite al superadmin obtener un token para entrar al panel de un colegio como administrador
router.post('/colegios/:colegioId/impersonate', async (req, res) => {
    const { colegioId } = req.params;

    try {
        const resultado = await pool.query(
            `SELECT c.*, u.id as admin_user_id, u.email as admin_email, u.nombre as admin_nombre
             FROM colegios c
             LEFT JOIN usuarios u ON u.id = c.admin_id
             WHERE c.id = $1`,
            [colegioId]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        const colegio = resultado.rows[0];

        // Construir el payload del token. 
        // Si hay un admin real, usamos sus datos, si no, generamos un acceso administrativo "fantasma"
        const payload = {
            id: colegio.admin_user_id || req.user.id,
            email: colegio.admin_email || `superadmin+${colegio.id}@transporte.local`,
            nombre: `[SA] ${colegio.admin_nombre || 'Admin Temporal'}`,
            rol: 'admin', // IMPORTANTE: El rol debe ser 'admin' para que el frontend y los controladores lo acepten
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

router.get('/colegios/:colegioId/usuarios', async (req, res) => {
    const { colegioId } = req.params;

    try {
        const colegio = await pool.query(
            `SELECT c.id, c.nombre, c.activo, c.admin_id, u.nombre AS admin_nombre, u.email AS admin_email
             FROM colegios c
             LEFT JOIN usuarios u ON u.id = c.admin_id
             WHERE c.id = $1`,
            [colegioId]
        );

        if (colegio.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        const usuarios = await pool.query(
            `SELECT id, nombre, email, rol, telefono, dui, licencia, placa, activo, colegio_id, creado_en
             FROM usuarios
             WHERE colegio_id = $1
             ORDER BY rol, nombre`,
            [colegioId]
        );

        res.json({
            colegio: colegio.rows[0],
            usuarios: usuarios.rows,
        });
    } catch (error) {
        console.error('Error listando usuarios del colegio:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/colegios/:colegioId/reset-admin-password', async (req, res) => {
    const { colegioId } = req.params;
    const nuevaPassword = String(req.body?.password || '').trim() || generarPasswordTemporal();

    if (nuevaPassword.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    try {
        const colegio = await pool.query(
            `SELECT c.id, c.nombre, c.admin_id, u.nombre AS admin_nombre, u.email AS admin_email
             FROM colegios c
             LEFT JOIN usuarios u ON u.id = c.admin_id
             WHERE c.id = $1`,
            [colegioId]
        );

        if (colegio.rows.length === 0) {
            return res.status(404).json({ error: 'Colegio no encontrado' });
        }

        const adminId = colegio.rows[0].admin_id;
        if (!adminId) {
            return res.status(400).json({ error: 'Este colegio no tiene administrador asignado' });
        }

        const passwordHash = await bcrypt.hash(nuevaPassword, 10);

        await pool.query(
            `UPDATE usuarios
             SET password = $1, activo = true
             WHERE id = $2 AND colegio_id = $3 AND rol = 'admin'`,
            [passwordHash, adminId, colegioId]
        );

        res.json({
            mensaje: 'Contraseña del administrador reiniciada correctamente',
            colegio: colegio.rows[0],
            credenciales: {
                email: colegio.rows[0].admin_email,
                passwordTemporal: nuevaPassword,
            },
        });
    } catch (error) {
        console.error('Error reseteando password del admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/anuncios', async (req, res) => {
    const { colegioId } = req.query;

    try {
        const valores = [];
        let whereClause = '';

        if (colegioId) {
            valores.push(colegioId);
            whereClause = `WHERE a.colegio_id = $${valores.length}`;
        }

        const resultado = await pool.query(
            `SELECT a.*, c.nombre AS colegio_nombre
             FROM anuncios_voz a
             LEFT JOIN colegios c ON c.id = a.colegio_id
             ${whereClause}
             ORDER BY c.nombre, a.orden, a.id`,
            valores
        );

        res.json({ anuncios: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/anuncios', async (req, res) => {
    const { colegio_id, titulo, mensaje, orden = 1, activo = true } = req.body;

    if (!titulo || !mensaje) {
        return res.status(400).json({ error: 'titulo y mensaje son requeridos' });
    }

    try {
        const resultado = await pool.query(
            `INSERT INTO anuncios_voz (colegio_id, titulo, mensaje, orden, activo, creado_por)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [colegio_id || null, titulo, mensaje, orden, activo, req.user.email]
        );

        res.status(201).json({
            mensaje: 'Anuncio creado correctamente',
            anuncio: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/anuncios/:id', async (req, res) => {
    const { colegio_id, titulo, mensaje, orden, activo } = req.body;

    try {
        const actual = await pool.query('SELECT * FROM anuncios_voz WHERE id = $1', [req.params.id]);

        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Anuncio no encontrado' });
        }

        const anuncioActual = actual.rows[0];
        const resultado = await pool.query(
            `UPDATE anuncios_voz
             SET colegio_id = $1,
                 titulo = $2,
                 mensaje = $3,
                 orden = $4,
                 activo = $5
             WHERE id = $6
             RETURNING *`,
            [
                colegio_id ?? anuncioActual.colegio_id,
                titulo ?? anuncioActual.titulo,
                mensaje ?? anuncioActual.mensaje,
                orden ?? anuncioActual.orden,
                activo ?? anuncioActual.activo,
                req.params.id,
            ]
        );

        res.json({
            mensaje: 'Anuncio actualizado correctamente',
            anuncio: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/anuncios/:id', async (req, res) => {
    try {
        const resultado = await pool.query(
            'DELETE FROM anuncios_voz WHERE id = $1 RETURNING id, titulo',
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Anuncio no encontrado' });
        }

        res.json({
            mensaje: 'Anuncio eliminado correctamente',
            anuncio: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/usuarios', async (req, res) => {
    const { nombre, email, password } = req.body;

    if (!nombre || !email || !password) {
        return res.status(400).json({ error: 'nombre, email y password son requeridos' });
    }

    try {
        const existe = await pool.query(
            'SELECT id FROM super_admins WHERE email = $1',
            [email.toLowerCase()]
        );

        if (existe.rows.length > 0) {
            return res.status(400).json({ error: 'El correo ya está registrado como super admin' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const resultado = await pool.query(
            `INSERT INTO super_admins (nombre, email, password)
             VALUES ($1, $2, $3)
             RETURNING id, nombre, email, creado_en`,
            [nombre, email.toLowerCase(), passwordHash]
        );

        res.status(201).json({
            mensaje: 'Super admin creado correctamente',
            superAdmin: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/alertas/recogida-5min', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT *
             FROM alertas_configuracion
             WHERE tipo = 'recogida_5min'
             LIMIT 1`
        );

        res.json({
            configuracion: resultado.rows[0] || null,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/mensajes-diarios', async (req, res) => {
    const hoy = new Date();
    const mes = Number(req.query.mes || hoy.getMonth() + 1);
    const anio = Number(req.query.anio || hoy.getFullYear());
    const diasDelMes = new Date(anio, mes, 0).getDate();

    try {
        const resultado = await pool.query(
            `SELECT mensajes_diarios
             FROM alertas_configuracion
             WHERE tipo = 'recogida_5min'
             LIMIT 1`
        );

        const mensajes = completarMensajesDiarios(resultado.rows[0]?.mensajes_diarios, diasDelMes);
        res.json({ mensajes, diasDelMes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/mensajes-diarios', async (req, res) => {
    const hoy = new Date();
    const mes = Number(req.body?.mes || hoy.getMonth() + 1);
    const anio = Number(req.body?.anio || hoy.getFullYear());
    const diasDelMes = new Date(anio, mes, 0).getDate();

    const mensajes = normalizarMensajesDiarios(req.body?.mensajes, diasDelMes);

    if (!mensajes) {
        return res.status(400).json({ error: `mensajes debe ser un array de ${diasDelMes} textos` });
    }

    try {
        const resultado = await pool.query(
            `INSERT INTO alertas_configuracion
                (tipo, activo, modo, titulo, mensaje, mensajes_diarios, hora_recogida, hora_alerta, dias_semana, canal, actualizado_por, actualizado_en)
             VALUES
                ('recogida_5min', true, 'mensual', 'Recogida en 5 minutos', $1, $2::jsonb, '06:45', '06:40', '[1,2,3,4,5]'::jsonb, 'push', $3, NOW())
             ON CONFLICT (tipo)
             DO UPDATE SET
                mensajes_diarios = EXCLUDED.mensajes_diarios,
                actualizado_por = EXCLUDED.actualizado_por,
                actualizado_en = NOW()
             RETURNING *`,
            [
                'El transporte escolar llegara en 5 minutos al punto de recogida.',
                JSON.stringify(mensajes),
                req.user.email,
            ]
        );

        res.json({
            mensaje: 'Mensajes diarios actualizados',
            mensajes: completarMensajesDiarios(resultado.rows[0].mensajes_diarios, diasDelMes),
            configuracion: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/alertas/recogida-5min', async (req, res) => {
    const {
        activo = true,
        modo = 'mensual',
        titulo = 'Recogida en 5 minutos',
        mensaje,
        horaRecogida,
        diasSemana = [1, 2, 3, 4, 5],
        canal = 'push',
    } = req.body;

    if (!mensaje || !horaRecogida) {
        return res.status(400).json({ error: 'mensaje y horaRecogida son requeridos' });
    }

    if (!['diaria', 'mensual'].includes(modo)) {
        return res.status(400).json({ error: 'modo invalido' });
    }

    if (!validarDiasSemana(diasSemana)) {
        return res.status(400).json({ error: 'diasSemana invalido' });
    }

    const horaAlerta = restarCincoMinutos(horaRecogida);
    if (!horaAlerta) {
        return res.status(400).json({ error: 'horaRecogida invalida. Usa formato HH:MM' });
    }

    try {
        const resultado = await pool.query(
            `INSERT INTO alertas_configuracion
                (tipo, activo, modo, titulo, mensaje, hora_recogida, hora_alerta, dias_semana, canal, actualizado_por, actualizado_en)
             VALUES
                ('recogida_5min', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW())
             ON CONFLICT (tipo)
             DO UPDATE SET
                activo = EXCLUDED.activo,
                modo = EXCLUDED.modo,
                titulo = EXCLUDED.titulo,
                mensaje = EXCLUDED.mensaje,
                hora_recogida = EXCLUDED.hora_recogida,
                hora_alerta = EXCLUDED.hora_alerta,
                dias_semana = EXCLUDED.dias_semana,
                canal = EXCLUDED.canal,
                actualizado_por = EXCLUDED.actualizado_por,
                actualizado_en = NOW()
             RETURNING *`,
            [
                activo,
                modo,
                titulo,
                mensaje,
                horaRecogida,
                horaAlerta,
                JSON.stringify(diasSemana),
                canal,
                req.user.email,
            ]
        );

        res.json({
            mensaje: 'Configuracion actualizada',
            configuracion: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/alertas/recogida-5min/generar-mes', async (req, res) => {
    const hoy = new Date();
    const mes = Number(req.body.mes || hoy.getMonth() + 1);
    const anio = Number(req.body.anio || hoy.getFullYear());

    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio)) {
        return res.status(400).json({ error: 'mes o anio invalido' });
    }

    try {
        const configResult = await pool.query(
            `SELECT * FROM alertas_configuracion WHERE tipo = 'recogida_5min' LIMIT 1`
        );

        if (configResult.rows.length === 0) {
            return res.status(404).json({ error: 'No existe configuracion de alerta de recogida' });
        }

        const config = configResult.rows[0];
        const hora = parseHora(config.hora_alerta);
        const diasSemana = parseJsonArray(config.dias_semana);
        const mensajesDiarios = parseJsonArray(config.mensajes_diarios);

        if (!hora) {
            return res.status(400).json({ error: 'La configuracion tiene una hora_alerta invalida' });
        }

        const primerDia = new Date(anio, mes - 1, 1, hora.hora, hora.minuto, 0, 0);
        const ultimoDia = new Date(anio, mes, 0, hora.hora, hora.minuto, 0, 0);

        await pool.query(
            `DELETE FROM alertas_programadas
             WHERE tipo = 'recogida_5min'
               AND DATE_PART('month', fecha_programada) = $1
               AND DATE_PART('year', fecha_programada) = $2`,
            [mes, anio]
        );

        const generadas = [];
        for (let dia = 1; dia <= ultimoDia.getDate(); dia += 1) {
            const fecha = new Date(anio, mes - 1, dia, hora.hora, hora.minuto, 0, 0);
            if (!diasSemana.includes(fecha.getDay())) continue;

            const resultado = await pool.query(
                `INSERT INTO alertas_programadas
                    (configuracion_id, tipo, titulo, mensaje, fecha_programada, canal, activo, enviada, actualizado_en)
                 VALUES
                    ($1, 'recogida_5min', $2, $3, $4, $5, $6, false, NOW())
                 RETURNING *`,
                [
                    config.id,
                    config.titulo,
                    obtenerMensajeParaDia(mensajesDiarios, dia, config.mensaje),
                    fecha,
                    config.canal,
                    config.activo,
                ]
            );

            generadas.push(resultado.rows[0]);
        }

        res.json({
            mensaje: 'Agenda mensual generada',
            total: generadas.length,
            alertas: generadas,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/alertas/recogida-5min/agenda', async (req, res) => {
    const hoy = new Date();
    const mes = Number(req.query.mes || hoy.getMonth() + 1);
    const anio = Number(req.query.anio || hoy.getFullYear());

    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio)) {
        return res.status(400).json({ error: 'mes o anio invalido' });
    }

    try {
        const resultado = await pool.query(
            `SELECT *
             FROM alertas_programadas
             WHERE tipo = 'recogida_5min'
               AND DATE_PART('month', fecha_programada) = $1
               AND DATE_PART('year', fecha_programada) = $2
             ORDER BY fecha_programada`,
            [mes, anio]
        );

        res.json({ alertas: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/alertas/recogida-5min/agenda', async (req, res) => {
    const hoy = new Date();
    const mes = Number(req.query.mes || hoy.getMonth() + 1);
    const anio = Number(req.query.anio || hoy.getFullYear());

    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio)) {
        return res.status(400).json({ error: 'mes o anio invalido' });
    }

    try {
        const resultado = await pool.query(
            `DELETE FROM alertas_programadas
             WHERE tipo = 'recogida_5min'
               AND DATE_PART('month', fecha_programada) = $1
               AND DATE_PART('year', fecha_programada) = $2
             RETURNING id`,
            [mes, anio]
        );

        res.json({
            mensaje: 'Agenda eliminada',
            totalEliminadas: resultado.rows.length,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- GESTIÓN DE AVISOS INFORMATIVOS ---

router.get('/avisos', async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT a.*, c.nombre AS colegio_nombre
             FROM avisos_informativos a
             LEFT JOIN colegios c ON c.id = a.colegio_id
             ORDER BY a.actualizado_en DESC`
        );
        res.json({ avisos: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/avisos', async (req, res) => {
    const { colegio_id, titulo, contenido, tipo = 'politica_comunicacion', activo = true } = req.body;

    if (!titulo || !contenido) {
        return res.status(400).json({ error: 'titulo y contenido son requeridos' });
    }

    try {
        const resultado = await pool.query(
            `INSERT INTO avisos_informativos (colegio_id, titulo, contenido, tipo, activo)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [colegio_id || null, titulo, contenido, tipo, activo]
        );

        res.status(201).json({
            mensaje: 'Aviso informativo creado correctamente',
            aviso: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/avisos/:id', async (req, res) => {
    const { colegio_id, titulo, contenido, tipo, activo } = req.body;

    try {
        const resultado = await pool.query(
            `UPDATE avisos_informativos
             SET colegio_id = COALESCE($1, colegio_id),
                 titulo = COALESCE($2, titulo),
                 contenido = COALESCE($3, contenido),
                 tipo = COALESCE($4, tipo),
                 activo = COALESCE($5, activo),
                 actualizado_en = NOW()
             WHERE id = $6
             RETURNING *`,
            [colegio_id, titulo, contenido, tipo, activo, req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Aviso no encontrado' });
        }

        res.json({
            mensaje: 'Aviso actualizado correctamente',
            aviso: resultado.rows[0],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/avisos/:id', async (req, res) => {
    try {
        const resultado = await pool.query(
            'DELETE FROM avisos_informativos WHERE id = $1 RETURNING id',
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Aviso no encontrado' });
        }

        res.json({ mensaje: 'Aviso eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
