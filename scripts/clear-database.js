require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const limpiarDatos = async () => {
  try {
    console.log('🧹 Iniciando limpieza de base de datos...');
    
    // El orden es importante para evitar errores de llaves foráneas
    await pool.query('DELETE FROM alertas_programadas');
    await pool.query('DELETE FROM ausencias');
    await pool.query('DELETE FROM eventos_ruta');
    await pool.query('DELETE FROM pagos');
    await pool.query('DELETE FROM tokens_push');
    await pool.query('DELETE FROM puntos_ruta');
    await pool.query('DELETE FROM alumnos');
    await pool.query('DELETE FROM rutas');
    await pool.query('DELETE FROM anuncios_voz');
    await pool.query('DELETE FROM vinculaciones');
    await pool.query('DELETE FROM codigos_invitacion');
    
    // Romper relación circular antes de borrar colegios/usuarios
    await pool.query('UPDATE usuarios SET colegio_id = NULL');
    await pool.query('UPDATE colegios SET admin_id = NULL');
    
    await pool.query('DELETE FROM colegios');
    
    // Borrar usuarios normales pero preservar super_admins
    await pool.query('DELETE FROM usuarios');
    
    console.log('✅ Base de datos limpiada exitosamente (preservando super_admins)');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error limpiando datos:', error.message);
    process.exit(1);
  }
};

limpiarDatos();
