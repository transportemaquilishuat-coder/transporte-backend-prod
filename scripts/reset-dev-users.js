require('dotenv').config({ quiet: true });

const bcrypt = require('bcryptjs');
const pool = require('../src/database');

const DEV_PASSWORD = process.env.DEV_USERS_PASSWORD || 'Pruebas2026!';
const DEV_COLEGIO = 'Colegio Desarrollo';
const DEV_RUTA = 'Ruta Desarrollo';
const DEV_ALUMNO = 'Alumno Desarrollo';
const DEV_PARADA = 'Parada Desarrollo';

const DEV_PROFILES = {
    super_admin: {
        nombre: 'Paula Superadmin',
        oldEmail: 'superadmin@tuapp.com',
        email: 'superadmin.pruebas@transporte.local',
    },
    admin: {
        nombre: 'Marta Admin',
        oldEmail: 'admin@test.com',
        email: 'admin.pruebas@transporte.local',
        rol: 'admin',
        telefono: '7000-0101',
    },
    conductor: {
        nombre: 'Diego Conductor',
        oldEmail: 'conductor@test.com',
        email: 'conductor.pruebas@transporte.local',
        rol: 'conductor',
        telefono: '7000-0102',
        dui: '01010101-1',
        licencia: 'PRUEBAS-2026',
        placa: 'PRB-426',
    },
    padre: {
        nombre: 'Sofia Padre',
        oldEmail: 'padre@test.com',
        email: 'padre.pruebas@transporte.local',
        rol: 'padre',
        telefono: '7000-0103',
        dui: '02020202-2',
    },
};

const getByEmail = async (client, table, email) => {
    const resultado = await client.query(
        `SELECT * FROM ${table} WHERE email = $1 LIMIT 1`,
        [email]
    );
    return resultado.rows[0] || null;
};

const upsertUsuario = async (client, usuario, passwordHash, colegioId) => {
    const resultado = await client.query(
        `INSERT INTO usuarios
            (nombre, email, password, rol, telefono, dui, licencia, placa, colegio_id, activo)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (email)
         DO UPDATE SET
            nombre = EXCLUDED.nombre,
            password = EXCLUDED.password,
            rol = EXCLUDED.rol,
            telefono = EXCLUDED.telefono,
            dui = EXCLUDED.dui,
            licencia = EXCLUDED.licencia,
            placa = EXCLUDED.placa,
            colegio_id = EXCLUDED.colegio_id,
            activo = true
         RETURNING id, nombre, email, rol, colegio_id, activo`,
        [
            usuario.nombre,
            usuario.email,
            passwordHash,
            usuario.rol,
            usuario.telefono || null,
            usuario.dui || null,
            usuario.licencia || null,
            usuario.placa || null,
            colegioId,
        ]
    );

    return resultado.rows[0];
};

const reasignarReferenciasUsuario = async (client, origenId, destinoId) => {
    const updates = [
        ['UPDATE colegios SET admin_id = $1 WHERE admin_id = $2', [destinoId, origenId]],
        ['UPDATE rutas SET conductor_id = $1 WHERE conductor_id = $2', [destinoId, origenId]],
        ['UPDATE alumnos SET padre_id = $1 WHERE padre_id = $2', [destinoId, origenId]],
        ['UPDATE ausencias SET padre_id = $1 WHERE padre_id = $2', [destinoId, origenId]],
        ['UPDATE eventos_ruta SET conductor_id = $1 WHERE conductor_id = $2', [destinoId, origenId]],
        ['UPDATE pagos SET padre_id = $1 WHERE padre_id = $2', [destinoId, origenId]],
        ['UPDATE tokens_push SET usuario_id = $1 WHERE usuario_id = $2', [destinoId, origenId]],
        ['UPDATE codigos_invitacion SET usado_por = $1 WHERE usado_por = $2', [destinoId, origenId]],
        ['UPDATE codigos_invitacion SET creado_por = $1 WHERE creado_por = $2', [destinoId, origenId]],
        ['UPDATE vinculaciones SET conductor_id = $1 WHERE conductor_id = $2', [destinoId, origenId]],
        ['UPDATE vinculaciones SET vinculado_por = $1 WHERE vinculado_por = $2', [destinoId, origenId]],
    ];

    for (const [query, params] of updates) {
        await client.query(query, params);
    }
};

const asegurarPerfilUsuario = async (client, perfil, passwordHash, colegioId) => {
    const usuarioNuevo = await getByEmail(client, 'usuarios', perfil.email);
    const usuarioAnterior = await getByEmail(client, 'usuarios', perfil.oldEmail);

    if (usuarioNuevo) {
        const actualizado = await client.query(
            `UPDATE usuarios
             SET nombre = $1,
                 password = $2,
                 rol = $3,
                 telefono = $4,
                 dui = $5,
                 licencia = $6,
                 placa = $7,
                 colegio_id = $8,
                 activo = true
             WHERE id = $9
             RETURNING id, nombre, email, rol, colegio_id, activo`,
            [
                perfil.nombre,
                passwordHash,
                perfil.rol,
                perfil.telefono || null,
                perfil.dui || null,
                perfil.licencia || null,
                perfil.placa || null,
                colegioId,
                usuarioNuevo.id,
            ]
        );

        if (usuarioAnterior && usuarioAnterior.id !== usuarioNuevo.id) {
            await reasignarReferenciasUsuario(client, usuarioAnterior.id, usuarioNuevo.id);
            await client.query('DELETE FROM usuarios WHERE id = $1', [usuarioAnterior.id]);
        }

        return actualizado.rows[0];
    }

    if (usuarioAnterior) {
        const actualizado = await client.query(
            `UPDATE usuarios
             SET nombre = $1,
                 email = $2,
                 password = $3,
                 rol = $4,
                 telefono = $5,
                 dui = $6,
                 licencia = $7,
                 placa = $8,
                 colegio_id = $9,
                 activo = true
             WHERE id = $10
             RETURNING id, nombre, email, rol, colegio_id, activo`,
            [
                perfil.nombre,
                perfil.email,
                passwordHash,
                perfil.rol,
                perfil.telefono || null,
                perfil.dui || null,
                perfil.licencia || null,
                perfil.placa || null,
                colegioId,
                usuarioAnterior.id,
            ]
        );

        return actualizado.rows[0];
    }

    return upsertUsuario(client, perfil, passwordHash, colegioId);
};

const asegurarSuperAdmin = async (client, perfil, passwordHash) => {
    const superAdminNuevo = await getByEmail(client, 'super_admins', perfil.email);
    const superAdminAnterior = await getByEmail(client, 'super_admins', perfil.oldEmail);

    if (superAdminNuevo) {
        const actualizado = await client.query(
            `UPDATE super_admins
             SET nombre = $1,
                 password = $2
             WHERE id = $3
             RETURNING id, nombre, email`,
            [perfil.nombre, passwordHash, superAdminNuevo.id]
        );

        if (superAdminAnterior && superAdminAnterior.id !== superAdminNuevo.id) {
            await client.query('DELETE FROM super_admins WHERE id = $1', [superAdminAnterior.id]);
        }

        return actualizado.rows[0];
    }

    if (superAdminAnterior) {
        const actualizado = await client.query(
            `UPDATE super_admins
             SET nombre = $1,
                 email = $2,
                 password = $3
             WHERE id = $4
             RETURNING id, nombre, email`,
            [perfil.nombre, perfil.email, passwordHash, superAdminAnterior.id]
        );
        return actualizado.rows[0];
    }

    const creado = await client.query(
        `INSERT INTO super_admins (nombre, email, password)
         VALUES ($1, $2, $3)
         ON CONFLICT (email)
         DO UPDATE SET nombre = EXCLUDED.nombre, password = EXCLUDED.password
         RETURNING id, nombre, email`,
        [perfil.nombre, perfil.email, passwordHash]
    );
    return creado.rows[0];
};

const obtenerOCrearColegio = async (client) => {
    const existente = await client.query(
        'SELECT id FROM colegios WHERE nombre = $1 ORDER BY id LIMIT 1',
        [DEV_COLEGIO]
    );

    if (existente.rows.length > 0) {
        await client.query(
            `UPDATE colegios
             SET plan = 'activo', activo = true, dias_prueba_restantes = 30
             WHERE id = $1`,
            [existente.rows[0].id]
        );
        return existente.rows[0].id;
    }

    const creado = await client.query(
        `INSERT INTO colegios (nombre, plan, activo, dias_prueba_restantes)
         VALUES ($1, 'activo', true, 30)
         RETURNING id`,
        [DEV_COLEGIO]
    );

    return creado.rows[0].id;
};

const obtenerOCrearRuta = async (client, colegioId, conductorId) => {
    const existente = await client.query(
        `SELECT id
         FROM rutas
         WHERE nombre = $1
           AND colegio_id = $2
         ORDER BY id
         LIMIT 1`,
        [DEV_RUTA, colegioId]
    );

    if (existente.rows.length > 0) {
        await client.query(
            `UPDATE rutas
             SET conductor_id = $1, activa = true
             WHERE id = $2`,
            [conductorId, existente.rows[0].id]
        );
        return existente.rows[0].id;
    }

    const creado = await client.query(
        `INSERT INTO rutas (nombre, conductor_id, colegio_id, activa)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [DEV_RUTA, conductorId, colegioId]
    );

    return creado.rows[0].id;
};

const obtenerOCrearAlumno = async (client, rutaId, padreId) => {
    const existente = await client.query(
        `SELECT id
         FROM alumnos
         WHERE nombre = $1
           AND padre_id = $2
         ORDER BY id
         LIMIT 1`,
        [DEV_ALUMNO, padreId]
    );

    if (existente.rows.length > 0) {
        await client.query(
            `UPDATE alumnos
             SET ruta_id = $1,
                 grado = 'Primer grado',
                 parada = $2,
                 latitude = 13.69294,
                 longitude = -89.21819,
                 orden = 1,
                 activo = true
             WHERE id = $3`,
            [rutaId, DEV_PARADA, existente.rows[0].id]
        );
        return existente.rows[0].id;
    }

    const creado = await client.query(
        `INSERT INTO alumnos
            (nombre, grado, ruta_id, padre_id, parada, latitude, longitude, orden, activo)
         VALUES
            ($1, 'Primer grado', $2, $3, $4, 13.69294, -89.21819, 1, true)
         RETURNING id`,
        [DEV_ALUMNO, rutaId, padreId, DEV_PARADA]
    );

    return creado.rows[0].id;
};

const resetDevUsers = async () => {
    console.log('--- RESET DEV USERS ---');
    await pool.ready;
    const client = await pool.connect();

    try {
        const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
        console.log('Password hash generado con éxito.');

        await client.query('BEGIN');

        console.log('Asegurando Super Admin...');
        const superAdmin = await asegurarSuperAdmin(client, DEV_PROFILES.super_admin, passwordHash);
        
        console.log('Asegurando Colegio...');
        const colegioId = await obtenerOCrearColegio(client);

        console.log('Asegurando Administrador...');
        const admin = await asegurarPerfilUsuario(client, DEV_PROFILES.admin, passwordHash, colegioId);

        await client.query(
            'UPDATE colegios SET admin_id = $1 WHERE id = $2',
            [admin.id, colegioId]
        );

        console.log('Asegurando Conductor...');
        const conductor = await asegurarPerfilUsuario(client, DEV_PROFILES.conductor, passwordHash, colegioId);
        
        console.log('Asegurando Padre...');
        const padre = await asegurarPerfilUsuario(client, DEV_PROFILES.padre, passwordHash, colegioId);

        console.log('Asegurando Ruta...');
        const rutaId = await obtenerOCrearRuta(client, colegioId, conductor.id);
        
        console.log('Asegurando Alumno...');
        const alumnoId = await obtenerOCrearAlumno(client, rutaId, padre.id);

        await client.query(
            `INSERT INTO alumno_padres (alumno_id, padre_id, rol)
             VALUES ($1, $2, 'principal')
             ON CONFLICT (alumno_id, padre_id) DO NOTHING`,
            [alumnoId, padre.id]
        );

        await client.query('COMMIT');

        console.log('\n✅ Perfiles de prueba actualizados correctamente:');
        console.table([
            { rol: 'super_admin', email: superAdmin.email, password: DEV_PASSWORD },
            { rol: admin.rol, email: admin.email, password: DEV_PASSWORD },
            { rol: conductor.rol, email: conductor.email, password: DEV_PASSWORD },
            { rol: padre.rol, email: padre.email, password: DEV_PASSWORD },
        ]);
        console.log(`\nColegio ID: ${colegioId}`);
        console.log(`Ruta ID: ${rutaId}`);
        console.log(`Alumno ID: ${alumnoId}`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error durante el reset de usuarios:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

resetDevUsers().catch((error) => {
    console.error('Error actualizando perfiles de prueba:', error);
    process.exit(1);
});
