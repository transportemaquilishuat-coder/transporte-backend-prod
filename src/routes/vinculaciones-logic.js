const pool = require('../database');
const { normalizarCodigo } = require('../utils/codigos');

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

    if (tipoRequerido && codigoData.tipo !== tipoRequerido) {
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

const resolverDestinoVinculacion = async (client, codigoData) => {
    switch (codigoData.tipo) {
        case 'colegio_admin':
            return {
                rol: 'admin',
                colegioId: codigoData.entidad_id,
                conductorId: null,
                desc: 'Administrador de Colegio'
            };
        case 'colegio_conductor':
            return {
                rol: 'conductor',
                colegioId: codigoData.entidad_id,
                conductorId: null,
                desc: 'Vinculación a Colegio'
            };
        case 'conductor_padre': {
            // El código apunta al conductor que lo generó
            const conductor = await client.query(
                'SELECT u.id, u.nombre, u.colegio_id, r.id as ruta_id FROM usuarios u LEFT JOIN rutas r ON r.conductor_id = u.id WHERE u.id = $1 AND u.rol = $2 LIMIT 1',
                [codigoData.entidad_id, 'conductor']
            );

            if (conductor.rows.length === 0) throw new Error('Conductor no encontrado');

            return {
                rol: 'padre',
                colegioId: conductor.rows[0].colegio_id,
                conductorId: conductor.rows[0].id,
                rutaId: conductor.rows[0].ruta_id,
                desc: `Ruta de ${conductor.rows[0].nombre}`
            };
        }
        case 'padre_compartido': {
            const alumno = await client.query(
                'SELECT a.id, a.nombre, a.colegio_id, a.ruta_id FROM alumnos a WHERE a.id = $1',
                [codigoData.entidad_id]
            );
            if (alumno.rows.length === 0) throw new Error('Alumno no encontrado');

            return {
                rol: 'padre',
                colegioId: alumno.rows[0].colegio_id,
                alumnoId: alumno.rows[0].id,
                rutaId: alumno.rows[0].ruta_id,
                desc: `Seguimiento de ${alumno.rows[0].nombre}`
            };
        }
        default:
            throw new Error('Tipo de código no válido');
    }
};

const tipoCodigoEsperadoPorRol = {
    admin: ['colegio_admin'],
    conductor: ['colegio_conductor'],
    padre: ['conductor_padre', 'padre_compartido'],
};

const validarRolParaCodigo = (rol, tipoCodigo) =>
    (tipoCodigoEsperadoPorRol[rol] || []).includes(tipoCodigo);

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

module.exports = {
    verificarCodigoInterno,
    obtenerCodigoValido,
    resolverDestinoVinculacion,
    validarRolParaCodigo,
    propagarColegioAConductorYPadres
};
