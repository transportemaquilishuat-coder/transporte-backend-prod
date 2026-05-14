const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL no esta definida en las variables de entorno.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
});

const dbStatus = {
    connected: false,
    schemaOk: false,
    error: null,
    version: '2.0.0-PROD',
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const prepararEsquemaUnaVez = async () => {
    const client = await pool.connect();
    try {
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
    } finally {
        client.release();
    }
};

const prepararEsquema = async (intentos = 5) => {
    for (let intento = 1; intento <= intentos; intento += 1) {
        try {
            await prepararEsquemaUnaVez();
            dbStatus.connected = true;
            dbStatus.schemaOk = true;
            dbStatus.error = null;
            return true;
        } catch (error) {
            dbStatus.connected = false;
            dbStatus.schemaOk = false;
            dbStatus.error = error.message;
            console.error(`Error en inicializacion DB intento ${intento}/${intentos}:`, error.message);
            if (intento < intentos) await esperar(1000 * intento);
        }
    }

    return false;
};

const ensureReady = async () => {
    if (dbStatus.schemaOk) return true;

    await pool.ready;

    if (!dbStatus.schemaOk) {
        pool.ready = prepararEsquema(3);
        await pool.ready;
    }

    if (!dbStatus.schemaOk) {
        throw new Error(dbStatus.error || 'Base de datos no disponible');
    }

    return true;
};

const verificarEstado = async () => {
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        dbStatus.connected = true;
        dbStatus.error = null;
    } catch (error) {
        dbStatus.connected = false;
        dbStatus.error = error.message;
    } finally {
        client.release();
    }
};

pool.on('error', (error) => {
    dbStatus.connected = false;
    dbStatus.error = error.message;
    console.error('Error inesperado en pool PostgreSQL:', error.message);
});

pool.ready = prepararEsquema();
pool.ensureReady = ensureReady;
pool.verificarEstado = verificarEstado;
pool.getStatus = () => dbStatus;

module.exports = pool;
