const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

dotenv.config();

const pool = require('./database');

const app = express();
const server = http.createServer(app);

// 🔥 SOCKET.IO CONFIG
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = Number(process.env.PORT || 8080);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

// 🔧 MIDDLEWARES
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Inyectar IO en el request para controladores
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Logger de peticiones para debug
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    if (req.method === 'POST') console.log('Body:', { ...req.body, password: '***' });
    next();
});

// 🌐 RUTA BASE
app.get('/', (req, res) => {
    res.json({
        mensaje: '🚌 API Transporte Escolar funcionando',
        version: '2.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'transporte-backend',
        port: PORT,
    });
});

// 📦 RUTAS API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rutas', require('./routes/rutas'));

app.use('/api/alumnos', require('./routes/alumnos'));
app.use('/api/pagos', require('./routes/pagos'));
app.use('/api/asignaciones', require('./routes/asignaciones'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/super-admin', require('./routes/superAdmin'));
app.use('/api/superadmin', require('./routes/superAdmin'));
app.use('/api/notificaciones', require('./routes/notificaciones'));
app.use('/api/padres', require('./routes/padres'));
app.use('/api/colegios', require('./routes/colegios'));
app.use('/api/desvios', require('./routes/desvios'));
app.use('/api/vinculaciones', require('./routes/vinculaciones'));
app.use('/api/avisos', require('./routes/avisos'));
app.use('/api/programacion', require('./routes/programacion'));
// ================================
// 🚍 ESTADO GLOBAL EN MEMORIA
// ================================

// Ubicación general (para compatibilidad con app padre)
let ubicacionBus = {
    latitude: 13.6929,
    longitude: -89.2182,
    conductorId: null,
    activo: false,
};

// 🔥 MULTI-CONDUCTORES (clave para admin PRO)
let conductoresActivos = {};
// Control de guardado en DB para no saturar (ej: cada 20 segundos)
let ultimoGuardadoDB = {};

// ================================
// 📍 ENDPOINT REST (fallback)
// ================================
app.get('/api/ubicacion', (req, res) => {
    res.json(ubicacionBus);
});

// ================================
// ⚡ WEBSOCKET (TIEMPO REAL REAL)
// ================================
io.on('connection', (socket) => {

    console.log(`🟢 Cliente conectado: ${socket.id}`);

    // 🚍 Conductor envía ubicación
    socket.on('conductor:ubicacion', async (datos) => {

        const ahora = Date.now();
        const conductorId = datos.conductorId;

        // Guardar última ubicación global (solo para debug/admin si es necesario)
        ubicacionBus = {
            latitude: datos.latitude,
            longitude: datos.longitude,
            conductorId: conductorId || null,
            rutaId: datos.rutaId || null,
            sentido: datos.sentido || null,
            activo: true,
        };

        // Guardar por conductor (multi-ruta)
        if (conductorId) {
            conductoresActivos[conductorId] = {
                id: conductorId,
                latitude: datos.latitude,
                longitude: datos.longitude,
                nombre: datos.nombre || 'Conductor',
                ruta: datos.ruta || 'Sin ruta',
                rutaId: datos.rutaId || null,
                sentido: datos.sentido || null,
                activo: true,
                ultimaActualizacion: new Date().toISOString(),
            };

            // 💾 GUARDADO EN HISTORIAL (Throttle de 20 segundos)
            if (!ultimoGuardadoDB[conductorId] || (ahora - ultimoGuardadoDB[conductorId] > 20000)) {
                ultimoGuardadoDB[conductorId] = ahora;
                pool.query(
                    'INSERT INTO historial_ubicaciones (ruta_id, conductor_id, latitud, longitud, sentido) VALUES ($1, $2, $3, $4, $5)',
                    [datos.rutaId || null, conductorId, datos.latitude, datos.longitude, datos.sentido || null]
                ).catch(e => console.error('Error guardando historial:', e.message));
            }
        }

        // 📡 Emitir SEGMENTADO (Solo a los padres de esta ruta)
        if (datos.rutaId) {
            io.to(`ruta:${datos.rutaId}`).emit('bus:ubicacion', ubicacionBus);
        }

        // Verificar desvío y notificar (también segmentado)
        if (datos.conductorId && datos.rutaId) {
            // Usar localhost interno para evitar problemas de DNS/Red externa en Railway
            const internalUrl = `http://127.0.0.1:${PORT}`;
            fetch(`${internalUrl}/api/desvios/verificar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conductorId: datos.conductorId,
                    rutaId: datos.rutaId,
                    latitude: datos.latitude,
                    longitude: datos.longitude,
                }),
            })
                .then(r => r.json())
                .then(resultado => {
                    if (resultado.desviado) {
                        const payloadDesvio = {
                            conductorId: datos.conductorId,
                            rutaId: datos.rutaId,
                            distanciaMetros: resultado.distanciaMetros,
                            mensaje: resultado.mensaje,
                        };
                        // Notificar solo a la ruta y a admins
                        io.to(`ruta:${datos.rutaId}`).emit('bus:desvio', payloadDesvio);
                        io.emit('admin:desvio', payloadDesvio);
                        console.log(`⚠️ Desvío detectado: ${resultado.distanciaMetros}m`);
                    }
                })
                .catch(e => console.log('Error verificando desvío:', e));
        }

        // Mantener actualizado el panel de admin global
        io.emit('admin:conductores_activos', Object.values(conductoresActivos));

    });

    // 📣 Evento genérico del conductor (Reportar tráfico, pinchazo, etc.)
    socket.on('conductor:evento', async (datos) => {
        console.log(`[EVENTO] Conductor ${datos.conductorId} en ruta ${datos.rutaId}: ${datos.tipo} - ${datos.descripcion}`);

        if (datos.rutaId) {
            // 1. Guardar en base de datos para el historial
            try {
                await pool.query(
                    `INSERT INTO eventos_ruta (ruta_id, conductor_id, tipo, descripcion)
                     VALUES ($1, $2, $3, $4)`,
                    [datos.rutaId, datos.conductorId || null, datos.tipo, datos.descripcion || datos.tipo]
                );
            } catch (error) {
                console.error('Error guardando evento de conductor:', error.message);
            }

            // 2. Retransmitir solo a los padres de esa ruta específica (Tiempo real)
            io.to(`ruta:${datos.rutaId}`).emit('bus:evento', {
                ...datos,
                timestamp: new Date().toISOString()
            });
        }
    });

    // 🟢 Inicio de ruta
    socket.on('conductor:inicio_ruta', (datos) => {
        ubicacionBus.activo = true;
        ubicacionBus.rutaId = datos.rutaId || ubicacionBus.rutaId || null;
        ubicacionBus.sentido = datos.sentido || ubicacionBus.sentido || null;

        if (datos.rutaId) {
            io.to(`ruta:${datos.rutaId}`).emit('bus:inicio_ruta', datos);
            pool.query(
                `INSERT INTO eventos_ruta (ruta_id, conductor_id, tipo, descripcion)
                 VALUES ($1, $2, 'inicio_ruta', $3)`,
                [
                    datos.rutaId,
                    datos.conductorId || null,
                    datos.sentido === 'colegio_a_casa'
                        ? 'Ruta de devolucion iniciada'
                        : 'Ruta de recogida iniciada',
                ]
            ).catch(e => console.log('Error registrando inicio de ruta:', e.message));
        }
        console.log(`🟢 Ruta iniciada por conductor ${datos.conductorId}`);
    });

    // 🔴 Fin de ruta
    socket.on('conductor:fin_ruta', (datos) => {

        ubicacionBus.activo = false;

        if (datos.conductorId) {
            delete conductoresActivos[datos.conductorId];
        }

        if (datos.rutaId) {
            io.to(`ruta:${datos.rutaId}`).emit('bus:fin_ruta', datos);
            pool.query(
                `INSERT INTO eventos_ruta (ruta_id, conductor_id, tipo, descripcion)
                 VALUES ($1, $2, 'fin_ruta', $3)`,
                [
                    datos.rutaId,
                    datos.conductorId || null,
                    datos.sentido === 'colegio_a_casa'
                        ? 'Ruta de devolucion finalizada'
                        : 'Ruta de recogida finalizada',
                ]
            ).catch(e => console.log('Error registrando fin de ruta:', e.message));
        }
        io.emit('admin:conductores_activos', Object.values(conductoresActivos));

        console.log(`🔴 Ruta finalizada por conductor ${datos.conductorId}`);
    });

    // 👨‍👩‍👧 Padre solicita ubicación
    socket.on('padre:solicitar_ubicacion', () => {
        socket.emit('bus:ubicacion', ubicacionBus);
    });

    // 👨‍👩‍👧 Padre se une a salas de sus hijos (multi-ruta)
    socket.on('padre:unirse_rutas', (rutasIds) => {
        if (Array.isArray(rutasIds)) {
            rutasIds.forEach(id => {
                socket.join(`ruta:${id}`);
                console.log(`👨‍👩‍👧 Cliente ${socket.id} unido a sala ruta:${id}`);
            });
        }
    });

    // 🧑‍💼 Admin solicita lista activa
    socket.on('admin:solicitar_conductores', () => {
        socket.emit('admin:conductores_activos', Object.values(conductoresActivos));
    });

    // 🔌 Desconexión
    socket.on('disconnect', () => {
        console.log(`🔴 Cliente desconectado: ${socket.id}`);
    });

});

// ================================
// 🚀 START SERVER
// ================================
// Admin consulta conductores activos (REST fallback)
app.get('/api/admin/conductores-activos', (req, res) => {
    res.json({
        conductores: Object.values(conductoresActivos),
        total: Object.values(conductoresActivos).length,
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    console.log(`🌐 BASE_URL configurada: ${BASE_URL}`);
});

