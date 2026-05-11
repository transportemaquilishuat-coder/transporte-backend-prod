const jwt = require('jsonwebtoken');
const pool = require('../database');

async function authenticateToken(req, res, next) {
    console.log('--- AUTH CHECK ---');
    console.log('method:', req.method);
    console.log('path:', req.originalUrl);
    console.log('authorization header:', req.headers.authorization);

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    console.log('token exists:', !!token);
    console.log('token preview:', token ? `${token.slice(0, 16)}...` : 'null');

    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        console.log('decoded payload:', payload);

        req.user = {
            ...payload,
            colegio_id: payload.colegio_id ?? payload.colegioId ?? null,
        };

        if (req.user.tipo !== 'super_admin' && req.user.id && !req.user.colegio_id) {
            const usuario = await pool.query(
                `SELECT colegio_id, nombre, telefono
                 FROM usuarios
                 WHERE id = $1`,
                [req.user.id]
            );

            if (usuario.rows[0]) {
                req.user.colegio_id = usuario.rows[0].colegio_id;
                req.user.colegioId = usuario.rows[0].colegio_id;
                req.user.nombre = req.user.nombre || usuario.rows[0].nombre;
                req.user.telefono = req.user.telefono || usuario.rows[0].telefono;
            }
        }

        next();
    } catch (error) {
        console.error('jwt verify failed:', error.message);
        return res.status(401).json({ error: `Token requerido: ${error.message}` });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Usuario no autenticado' });
        }

        // El super_admin tiene acceso a TODO por diseño de gobernanza
        if (req.user.rol === 'super_admin' || roles.includes(req.user.rol)) {
            return next();
        }

        return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    };
}

module.exports = {
    authenticateToken,
    requireRole,
};
