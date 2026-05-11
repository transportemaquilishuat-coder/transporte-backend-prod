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
        dbStatus.schemaOk = true;
    } catch (error) {
        dbStatus.error = error.message;
        if (process.env.NODE_ENV !== 'production') {
            console.error('⚠️ Error en inicialización DB:', error.message);
        }
    } finally {
        if (client) client.release();
    }
};

// Inicialización asíncrona
asegurarEsquema();

pool.ready = Promise.resolve(true);
pool.getStatus = () => dbStatus;

module.exports = pool;
