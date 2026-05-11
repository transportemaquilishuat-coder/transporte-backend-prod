require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const crearTablas = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS colegios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        logo_url TEXT,
        plan VARCHAR(20) DEFAULT 'trial',
        activo BOOLEAN DEFAULT true,
        dias_prueba_restantes INTEGER DEFAULT 30,
        admin_id INTEGER,
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        rol VARCHAR(20) NOT NULL CHECK (rol IN ('padre', 'conductor', 'admin')),
        telefono VARCHAR(20),
        dui VARCHAR(20),
        licencia VARCHAR(50),
        placa VARCHAR(20),
        colegio_id INTEGER REFERENCES colegios(id),
        fecha_inicio_servicio DATE,
        fecha_fin_servicio DATE,
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'fk_colegios_admin'
        ) THEN
          ALTER TABLE colegios ADD CONSTRAINT fk_colegios_admin 
          FOREIGN KEY (admin_id) REFERENCES usuarios(id);
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS rutas (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        conductor_id INTEGER REFERENCES usuarios(id),
        colegio_id INTEGER REFERENCES colegios(id),
        activa BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alumnos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        grado VARCHAR(50),
        ruta_id INTEGER REFERENCES rutas(id),
        padre_id INTEGER REFERENCES usuarios(id),
        parada VARCHAR(150),
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        orden INTEGER,
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ausencias (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER REFERENCES alumnos(id),
        padre_id INTEGER REFERENCES usuarios(id),
        motivo TEXT,
        fecha DATE DEFAULT CURRENT_DATE,
        hora TIME DEFAULT CURRENT_TIME,
        creado_en TIMESTAMP DEFAULT NOW()
      );

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

      CREATE TABLE IF NOT EXISTS pagos (
        id SERIAL PRIMARY KEY,
        padre_id INTEGER REFERENCES usuarios(id),
        monto DECIMAL(10,2),
        mes VARCHAR(20),
        estado VARCHAR(20) DEFAULT 'pendiente',
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tokens_push (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id),
        token VARCHAR(255) NOT NULL,
        plataforma VARCHAR(10),
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS configuracion (
        id SERIAL PRIMARY KEY,
        clave VARCHAR(100) UNIQUE NOT NULL,
        valor VARCHAR(255) NOT NULL,
        descripcion TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS anuncios_voz (
        id SERIAL PRIMARY KEY,
        colegio_id INTEGER REFERENCES colegios(id),
        titulo VARCHAR(100) NOT NULL,
        mensaje TEXT NOT NULL,
        activo BOOLEAN DEFAULT true,
        orden INTEGER DEFAULT 1,
        creado_por VARCHAR(50) DEFAULT 'superadmin',
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS super_admins (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alertas_configuracion (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50) UNIQUE NOT NULL,
        activo BOOLEAN DEFAULT true,
        modo VARCHAR(20) NOT NULL DEFAULT 'mensual',
        titulo VARCHAR(150) NOT NULL,
        mensaje TEXT NOT NULL,
        mensajes_diarios JSONB DEFAULT '[]'::jsonb,
        hora_recogida VARCHAR(5) NOT NULL,
        hora_alerta VARCHAR(5) NOT NULL,
        dias_semana JSONB DEFAULT '[]'::jsonb,
        canal VARCHAR(20) DEFAULT 'push',
        actualizado_por VARCHAR(100),
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE alertas_configuracion
      ADD COLUMN IF NOT EXISTS mensajes_diarios JSONB DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS alertas_programadas (
        id SERIAL PRIMARY KEY,
        configuracion_id INTEGER REFERENCES alertas_configuracion(id) ON DELETE CASCADE,
        tipo VARCHAR(50) NOT NULL,
        titulo VARCHAR(150) NOT NULL,
        mensaje TEXT NOT NULL,
        fecha_programada TIMESTAMP NOT NULL,
        canal VARCHAR(20) DEFAULT 'push',
        activo BOOLEAN DEFAULT true,
        enviada BOOLEAN DEFAULT false,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS puntos_ruta (
        id SERIAL PRIMARY KEY,
        ruta_id INTEGER REFERENCES rutas(id),
        alumno_id INTEGER REFERENCES alumnos(id),
        tipo VARCHAR(20) DEFAULT 'recogida',
        latitud DECIMAL(10,8) NOT NULL,
        longitud DECIMAL(11,8) NOT NULL,
        orden INTEGER NOT NULL,
        nombre_parada VARCHAR(100),
        creado_en TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS alumno_id INTEGER REFERENCES alumnos(id);
      ALTER TABLE puntos_ruta ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'recogida';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_puntos_ruta_alumno_tipo
      ON puntos_ruta (alumno_id, tipo)
      WHERE alumno_id IS NOT NULL;

      -- ============================================
      -- NUEVAS TABLAS DE VINCULACIÓN
      -- ============================================

      CREATE TABLE IF NOT EXISTS codigos_invitacion (
        id SERIAL PRIMARY KEY,
        codigo VARCHAR(20) UNIQUE NOT NULL,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('colegio_admin', 'colegio_conductor', 'conductor_padre', 'padre_compartido')),
        entidad_id INTEGER,
        creado_por INTEGER NOT NULL,
        usado_por INTEGER REFERENCES usuarios(id),
        usado_en TIMESTAMP,
        max_usos INTEGER DEFAULT 1,
        usos_actuales INTEGER DEFAULT 0,
        activo BOOLEAN DEFAULT true,
        expira_en TIMESTAMP,
        creado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vinculaciones (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('colegio_admin', 'colegio_conductor', 'conductor_padre', 'padre_compartido')),
        entidad_id INTEGER NOT NULL,
        vinculado_por INTEGER NOT NULL,
        colegio_id INTEGER REFERENCES colegios(id),
        conductor_id INTEGER REFERENCES usuarios(id),
        codigo_usado VARCHAR(20),
        estado VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo', 'pendiente', 'expirado', 'rechazado', 'inactivo')),
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS avisos_informativos (
        id SERIAL PRIMARY KEY,
        colegio_id INTEGER REFERENCES colegios(id),
        titulo VARCHAR(150) NOT NULL,
        contenido TEXT NOT NULL,
        tipo VARCHAR(50) DEFAULT 'politica_comunicacion',
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alumno_padres (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
        padre_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        rol VARCHAR(50) DEFAULT 'principal',
        creado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE(alumno_id, padre_id)
      );

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
        creado_por INTEGER REFERENCES usuarios(id),
        creado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE(alumno_id, fecha, tipo)
      );

      CREATE TABLE IF NOT EXISTS historial_ubicaciones (
        id SERIAL PRIMARY KEY,
        ruta_id INTEGER REFERENCES rutas(id) ON DELETE CASCADE,
        conductor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        latitud DECIMAL(10,8) NOT NULL,
        longitud DECIMAL(11,8) NOT NULL,
        sentido VARCHAR(50),
        creado_en TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tablas creadas/actualizadas correctamente');

    await pool.query(`
      INSERT INTO super_admins (nombre, email, password)
      VALUES ('Paula Superadmin', 'superadmin.pruebas@transporte.local', '$2b$10$RfznvLvXhKnnZ.HwIRfetece9vvk0g8GJtSItvp6/wTLqM7yoPk8G')
      ON CONFLICT (email) DO NOTHING;

      INSERT INTO colegios (nombre, plan)
      VALUES 
        ('Colegio San José', 'activo'),
        ('Colegio Santa María', 'trial'),
        ('Colegio El Sagrado Corazón', 'trial')
      ON CONFLICT DO NOTHING;

      INSERT INTO configuracion (clave, valor, descripcion)
      VALUES 
        ('llamadas_conductor', 'true', 'Permitir que padres llamen al conductor'),
        ('mostrar_numero_conductor', 'true', 'Mostrar número del conductor a los padres'),
        ('periodo_prueba_dias', '30', 'Días de período de prueba gratuito'),
        ('codigo_expiracion_dias', '7', 'Días de validez de códigos de invitación')
      ON CONFLICT (clave) DO NOTHING;

      INSERT INTO alertas_configuracion (tipo, activo, modo, titulo, mensaje, hora_recogida, hora_alerta, dias_semana, canal, actualizado_por)
      VALUES (
        'recogida_5min',
        true,
        'mensual',
        'Recogida en 5 minutos',
        'El transporte escolar llegara en 5 minutos al punto de recogida.',
        '06:45',
        '06:40',
        '[1,2,3,4,5]'::jsonb,
        'push',
        'setup'
      )
      ON CONFLICT (tipo) DO NOTHING;

      INSERT INTO avisos_informativos (titulo, contenido, tipo)
      VALUES (
        'Política de Comunicación',
        'Bienvenido al panel informativo. Aquí podrá gestionar la comunicación con los padres y conductores. Recuerde seguir nuestras políticas de privacidad.',
        'politica_comunicacion'
      ) ON CONFLICT DO NOTHING;
    `);

    console.log('✅ Datos iniciales insertados');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

crearTablas();
