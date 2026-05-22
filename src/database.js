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
            ALTER TABLE colegios ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8);
            ALTER TABLE colegios ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8);
            ALTER TABLE colegios ADD COLUMN IF NOT EXISTS geo_origen VARCHAR(20);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS ausencias (
                id SERIAL PRIMARY KEY,
                alumno_id INTEGER REFERENCES alumnos(id),
                padre_id INTEGER REFERENCES usuarios(id),
                motivo TEXT,
                fecha DATE DEFAULT CURRENT_DATE,
                fecha_fin DATE,
                hora TIME DEFAULT CURRENT_TIME,
                estado VARCHAR(20) DEFAULT 'pendiente',
                respuesta_conductor TEXT,
                respondido_at TIMESTAMP,
                creado_en TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE ausencias ADD COLUMN IF NOT EXISTS fecha_fin DATE;
            ALTER TABLE ausencias ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'pendiente';
            ALTER TABLE ausencias ADD COLUMN IF NOT EXISTS respuesta_conductor TEXT;
            ALTER TABLE ausencias ADD COLUMN IF NOT EXISTS respondido_at TIMESTAMP;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS eventos_ruta (
                id SERIAL PRIMARY KEY,
                ruta_id INTEGER REFERENCES rutas(id),
                conductor_id INTEGER REFERENCES usuarios(id),
                tipo VARCHAR(50),
                descripcion TEXT,
                latitud DECIMAL(10,8),
                longitud DECIMAL(11,8),
                creado_en TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE eventos_ruta ADD COLUMN IF NOT EXISTS conductor_id INTEGER REFERENCES usuarios(id);
            ALTER TABLE eventos_ruta ADD COLUMN IF NOT EXISTS latitud DECIMAL(10,8);
            ALTER TABLE eventos_ruta ADD COLUMN IF NOT EXISTS longitud DECIMAL(11,8);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS programacion_rutas (
                id SERIAL PRIMARY KEY,
                alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
                fecha DATE NOT NULL,
                ruta_id INTEGER REFERENCES rutas(id) ON DELETE SET NULL,
                parada VARCHAR(150),
                latitude DECIMAL(10,8),
                longitude DECIMAL(11,8),
                tipo VARCHAR(20) DEFAULT 'ambos',
                nota TEXT,
                estado VARCHAR(20) DEFAULT 'pendiente',
                respuesta_conductor TEXT,
                respondido_at TIMESTAMP,
                creado_por INTEGER REFERENCES usuarios(id),
                creado_en TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS ruta_id INTEGER REFERENCES rutas(id) ON DELETE SET NULL;
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS parada VARCHAR(150);
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8);
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8);
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'ambos';
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS nota TEXT;
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'pendiente';
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS respuesta_conductor TEXT;
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS respondido_at TIMESTAMP;
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS creado_por INTEGER REFERENCES usuarios(id);
            ALTER TABLE programacion_rutas ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT NOW();

            UPDATE programacion_rutas SET tipo = 'ambos' WHERE tipo IS NULL;
            UPDATE programacion_rutas SET estado = 'pendiente' WHERE estado IS NULL;

            DELETE FROM programacion_rutas vieja
            USING programacion_rutas nueva
            WHERE vieja.id < nueva.id
              AND vieja.alumno_id = nueva.alumno_id
              AND vieja.fecha = nueva.fecha
              AND vieja.tipo = nueva.tipo;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_programacion_rutas_alumno_fecha_tipo
            ON programacion_rutas (alumno_id, fecha, tipo);
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
                tipo VARCHAR(20) NOT NULL DEFAULT 'recogida',
                parada_actual VARCHAR(150),
                latitude_actual DECIMAL(10,8),
                longitude_actual DECIMAL(11,8),
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
            ALTER TABLE solicitudes_cambio_punto_recogida ALTER COLUMN parada_actual DROP NOT NULL;
            ALTER TABLE solicitudes_cambio_punto_recogida ALTER COLUMN latitude_actual DROP NOT NULL;
            ALTER TABLE solicitudes_cambio_punto_recogida ALTER COLUMN longitude_actual DROP NOT NULL;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS puntos_ruta (
                id SERIAL PRIMARY KEY,
                ruta_id INTEGER REFERENCES rutas(id),
                alumno_id INTEGER REFERENCES alumnos(id),
                tipo VARCHAR(20) DEFAULT 'recogida',
                latitud DECIMAL(10,8),
                longitud DECIMAL(11,8),
                orden INTEGER,
                nombre_parada VARCHAR(100),
                creado_en TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS alumno_id INTEGER REFERENCES alumnos(id);
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'recogida';
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS latitud DECIMAL(10,8);
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS longitud DECIMAL(11,8);
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS orden INTEGER;
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS nombre_parada VARCHAR(100);
            ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT NOW();
            
            ALTER TABLE puntos_ruta ALTER COLUMN latitud DROP NOT NULL;
            ALTER TABLE puntos_ruta ALTER COLUMN longitud DROP NOT NULL;
            ALTER TABLE puntos_ruta ALTER COLUMN orden DROP NOT NULL;

            ALTER TABLE solicitudes_cambio_punto_recogida
            ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'recogida';

            CREATE INDEX IF NOT EXISTS idx_solicitudes_cambio_punto_conductor_estado
            ON solicitudes_cambio_punto_recogida (conductor_id, estado, created_at DESC);

            DROP INDEX IF EXISTS idx_solicitud_cambio_punto_pendiente_alumno;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitud_cambio_punto_pendiente_alumno_tipo
            ON solicitudes_cambio_punto_recogida (alumno_id, tipo)
            WHERE estado = 'pendiente';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_puntos_ruta_alumno_tipo
            ON puntos_ruta (alumno_id, tipo)
            WHERE alumno_id IS NOT NULL;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS historial_ubicaciones (
                id SERIAL PRIMARY KEY,
                ruta_id INTEGER REFERENCES rutas(id) ON DELETE CASCADE,
                conductor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                latitud DECIMAL(10,8) NOT NULL,
                longitud DECIMAL(11,8) NOT NULL,
                sentido VARCHAR(50),
                creado_en TIMESTAMP DEFAULT NOW()
            );

            ALTER TABLE historial_ubicaciones ADD COLUMN IF NOT EXISTS sentido VARCHAR(50);
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
