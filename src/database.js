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
            ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS colegio_id INTEGER REFERENCES colegios(id);
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

        await client.query(`
            CREATE TABLE IF NOT EXISTS solicitudes_cambio_punto_recogida (
                id SERIAL PRIMARY KEY,
                alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
                padre_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                conductor_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                ruta_id INTEGER REFERENCES rutas(id) ON DELETE SET NULL,
                parada_actual VARCHAR(150) NOT NULL,
                latitude_actual DECIMAL(10,8) NOT NULL,
                longitude_actual DECIMAL(11,8) NOT NULL,
                parada_nueva VARCHAR(150) NOT NULL,
                latitude_nueva DECIMAL(10,8) NOT NULL,
                longitude_nueva DECIMAL(11,8) NOT NULL,
                estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobado', 'rechazado')),
                motivo TEXT,
                respuesta_conductor TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                respondido_at TIMESTAMP
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_solicitudes_cambio_punto_conductor_estado
            ON solicitudes_cambio_punto_recogida (conductor_id, estado, created_at DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitud_cambio_punto_pendiente_alumno
            ON solicitudes_cambio_punto_recogida (alumno_id)
            WHERE estado = 'pendiente';
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
