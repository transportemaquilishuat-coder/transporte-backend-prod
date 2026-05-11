# transporte-backend

Backend en Node.js + Express + PostgreSQL para transporte escolar.

## Stack

- Node.js
- Express 5
- PostgreSQL (`pg`)
- JWT
- Socket.IO

## Scripts

```bash
npm install
npm run dev
npm run reset:dev-users
```

Servidor principal:

- `src/index.js`

Script de setup de base de datos:

- `src/database_setup.js`

Ejecutar setup inicial:

```bash
node src/database_setup.js
```

## Perfiles de prueba

Despues de ejecutar `npm run reset:dev-users`, quedan disponibles estos accesos:

- `super_admin`: `superadmin.pruebas@transporte.local`
- `admin`: `admin.pruebas@transporte.local`
- `conductor`: `conductor.pruebas@transporte.local`
- `padre`: `padre.pruebas@transporte.local`

Password por defecto para los 4 perfiles:

```text
Pruebas2026!
```

Si necesitas otra clave comun, puedes definir `DEV_USERS_PASSWORD` antes de correr el script.

## Variables de entorno

Crear un archivo `.env` basado en `.env.example`:

```env
PORT=3000
JWT_SECRET=change_this_jwt_secret
JWT_EXPIRES_IN=365d
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB_NAME
```

## Estructura

```text
src/
  controllers/
  middleware/
  routes/
  database.js
  database_setup.js
  index.js
```

## Rutas disponibles

### Auth

- `POST /api/auth/login`
- `POST /api/auth/registro`

Registro publico sin codigo:

```json
{
  "nombre": "Nombre Usuario",
  "email": "usuario@test.com",
  "password": "password123",
  "rol": "padre"
}
```

Roles publicos validos: `padre`, `conductor`, `admin`.

El registro crea la cuenta y devuelve token. El usuario puede entrar a la app aunque todavia no este vinculado a colegio, conductor o ruta.

### Vinculaciones

Los codigos no son requisito para crear cuenta. Los codigos sirven para vincular una cuenta existente:

- `colegio_admin`: cuenta `admin` -> colegio creado por super admin.
- `colegio_conductor`: cuenta `conductor` -> colegio.
- `conductor_padre`: cuenta `padre` -> conductor.
- `padre_compartido`: cuenta `padre` -> alumno (permite que varios padres sigan al mismo alumno).

### Avisos Informativos (Política de Comunicación)

- `GET /api/avisos`: Lista avisos activos para el colegio del usuario.
- `GET /api/avisos/politica-comunicacion`: Obtiene específicamente la política de comunicación.

### Programación de Cambios (Padres)

- `GET /api/programacion/mis-hijos-cambios`: Lista cambios programados a futuro.
- `POST /api/programacion`: Crea o actualiza un cambio de ruta/parada para un día específico.
- `DELETE /api/programacion/:id`: Cancela un cambio programado.

### Padres

- `GET /api/padres/mis-hijos`: Ahora soporta multi-padre y detecta cambios programados para el día actual.
- `POST /api/padres/hijos/:alumnoId/generar-invitacion`: Genera un código para invitar a otro padre.
- `PUT /api/padres/hijos/:alumnoId/punto-recogida`: Define el punto de recogida fijo.
- `GET /api/padres/:padreId/historial`: Historial de viajes.

### Super Admin

- `GET /api/super-admin/dashboard`
- `GET /api/super-admin/colegios`
- `POST /api/super-admin/colegios/:colegioId/impersonate`: Obtiene token para entrar como admin del colegio.
- `POST /api/super-admin/colegios/:colegioId/asignar-admin`: Vincula un admin por email.
- `POST /api/super-admin/avisos`: CRUD de avisos informativos.
- `GET /api/super-admin/alertas/recogida-5min`
- `PUT /api/super-admin/alertas/recogida-5min`
- `GET /api/super-admin/mensajes-diarios`
- `PUT /api/super-admin/mensajes-diarios`
- `POST /api/super-admin/alertas/recogida-5min/generar-mes`
- `GET /api/super-admin/alertas/recogida-5min/agenda`
- `DELETE /api/super-admin/alertas/recogida-5min/agenda`

### Notificaciones

- `POST /api/notificaciones/token`
- `DELETE /api/notificaciones/token`
- `POST /api/notificaciones/enviar`
- `POST /api/notificaciones/alerta-bus`

### Tiempo real

- `GET /`
- `GET /api/ubicacion`
- WebSocket con Socket.IO para ubicaciones y estado de rutas

## Notas

- `src/database.js` conecta a PostgreSQL usando `DATABASE_URL`.
- `alumnos` ahora admite `latitude` y `longitude` para el punto exacto de recogida.
- Se agregaron las tablas `alertas_configuracion` y `alertas_programadas` para la agenda del super administrador.
- La ruta `super-admin` requiere token JWT con rol `super_admin`.
- No compartir `.env` real ni `node_modules` al pasar el repo.
