require('dotenv').config({ quiet: true });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const seed = async () => {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL no esta configurada en .env');
    }

    const password = process.env.SUPERADMIN_SEED_PASSWORD || process.env.DEV_USERS_PASSWORD || 'Pruebas2026!';
    const passwordHash = await bcrypt.hash(password, 10);
    const admins = [
        ['Daniel Guzman (Principal)', 'danielguzman_13@hotmail.com'],
        ['Daniel Guzman (Respaldo)', '13.guzman@gmail.com'],
        ['Paula Superadmin', 'superadmin.pruebas@transporte.local'],
    ];

    for (const [nombre, email] of admins) {
        console.log(`Insertando/actualizando ${email}...`);
        await pool.query(
            `INSERT INTO super_admins (nombre, email, password)
             VALUES ($1, $2, $3)
             ON CONFLICT (email)
             DO UPDATE SET nombre = EXCLUDED.nombre, password = EXCLUDED.password`,
            [nombre, email, passwordHash]
        );
    }

    console.log('Listo. Password sembrado:', password);
};

seed()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
