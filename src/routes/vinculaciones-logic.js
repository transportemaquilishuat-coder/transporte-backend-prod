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
