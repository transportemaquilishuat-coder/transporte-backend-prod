const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL no está definida en las variables de entorno.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false }
});

// Estado global de la DB para el healthcheck
let dbStatus = {
    connected: false,
    schemaOk: false,
    error: null,
    version: '2.0.0-PROD'
};

const asegurarEsquema = async () => {
    let client;
    try {
        client = await pool.connect();
        dbStatus.connected = true;

        // Tabla básica de control
        await client.query(`
            CREATE TABLE IF NOT EXISTS sistema_control (
                id SERIAL PRIMARY KEY, 
                version TEXT, 
                actualizado_en TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS colegio_nombre VARCHAR(150);
            ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS turno_estudio VARCHAR(20) NOT NULL DEFAULT 'matutino';
            ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS padre_email VARCHAR(100);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS alumno_padres (
                id SERIAL PRIMARY KEY,
                alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
                padre_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                rol VARCHAR(50) DEFAULT 'principal',
                creado_en TIMESTAMP DEFAULT NOW(),
                UNIQUE(alumno_id, padre_id)
            )
        `);

        dbStatus.schemaOk = true;
    } catch (error) {
        dbStatus.error = error.message;
        console.error('Error en inicializacion DB:', error.message);
    } finally {
        if (client) client.release();
    }
};

// Inicialización asíncrona
pool.ready = asegurarEsquema();
pool.getStatus = () => dbStatus;

module.exports = pool;
