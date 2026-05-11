const pool = require('../database');

const COSTO_MENSUAL_APP = 2.50;

/**
 * Genera cargos mensuales para todos los padres cuyo servicio esté activo.
 * Se puede ejecutar manualmente o mediante una tarea programada (cron).
 */
const generarCargosMensuales = async (mes, anio) => {
    const mesNombre = `${mes} ${anio}`;
    console.log(`[PAGOS] Generando cargos para: ${mesNombre}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Obtener padres que tienen servicio activo y no tienen pago generado para este mes
        // Consideramos que un padre está activo si hoy está dentro de su rango de fechas
        const padresActivos = await client.query(`
            SELECT u.id, u.nombre, u.email
            FROM usuarios u
            WHERE u.rol = 'padre' 
              AND u.activo = true
              AND u.fecha_inicio_servicio IS NOT NULL
              AND u.fecha_fin_servicio IS NOT NULL
              AND CURRENT_DATE BETWEEN u.fecha_inicio_servicio AND u.fecha_fin_servicio
              AND NOT EXISTS (
                  SELECT 1 FROM pagos p 
                  WHERE p.padre_id = u.id AND p.mes = $1
              )
        `, [mesNombre]);

        console.log(`[PAGOS] Padres activos encontrados para cargo: ${padresActivos.rows.length}`);

        const cargosGenerados = [];
        for (const padre of padresActivos.rows) {
            const resPago = await client.query(`
                INSERT INTO pagos (padre_id, monto, mes, estado)
                VALUES ($1, $2, $3, 'pendiente')
                RETURNING *
            `, [padre.id, COSTO_MENSUAL_APP, mesNombre]);
            
            cargosGenerados.push(resPago.rows[0]);
        }

        await client.query('COMMIT');
        return {
            success: true,
            mes: mesNombre,
            totalGenerados: cargosGenerados.length,
            pagos: cargosGenerados
        };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[PAGOS] Error generando cargos:', error);
        throw error;
    } finally {
        client.release();
    }
};

const listarPagos = async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT p.*, u.nombre as padre_nombre, u.email as padre_email
            FROM pagos p
            JOIN usuarios u ON u.id = p.padre_id
            ORDER BY p.creado_en DESC
        `);
        res.json({ pagos: resultado.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const obtenerPagosPendientes = async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT p.*, u.nombre as padre_nombre, u.email as padre_email
            FROM pagos p
            JOIN usuarios u ON u.id = p.padre_id
            WHERE p.estado = 'pendiente'
            ORDER BY p.creado_en DESC
        `);
        res.json({ pendientes: resultado.rows, total: resultado.rows.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const procesarGeneracionManual = async (req, res) => {
    const { mes, anio } = req.body;
    
    if (!mes || !anio) {
        return res.status(400).json({ error: 'mes y anio son requeridos' });
    }

    try {
        const resultado = await generarCargosMensuales(mes, anio);
        res.json(resultado);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const actualizarEstadoPago = async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;

    if (!['pendiente', 'pagado', 'cancelado'].includes(estado)) {
        return res.status(400).json({ error: 'Estado invalido' });
    }

    try {
        const resultado = await pool.query(
            'UPDATE pagos SET estado = $1 WHERE id = $2 RETURNING *',
            [estado, id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Pago no encontrado' });
        }

        res.json({ mensaje: 'Estado de pago actualizado', pago: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const confirmarPagoPadre = async (req, res) => {
    const { pagoId, transaccionId, metodoPago = 'google_pay' } = req.body;
    const padreId = req.user.id;

    if (!pagoId || !transaccionId) {
        return res.status(400).json({ error: 'pagoId y transaccionId son requeridos' });
    }

    try {
        // Verificar que el pago pertenece al padre y está pendiente
        const pagoResult = await pool.query(
            'SELECT * FROM pagos WHERE id = $1 AND padre_id = $2',
            [pagoId, padreId]
        );

        if (pagoResult.rows.length === 0) {
            return res.status(404).json({ error: 'Registro de pago no encontrado para este usuario' });
        }

        if (pagoResult.rows[0].estado === 'pagado') {
            return res.status(400).json({ error: 'Este pago ya ha sido procesado anteriormente' });
        }

        // Actualizar el pago con la información de la transacción
        const resultado = await pool.query(
            `UPDATE pagos 
             SET estado = 'pagado', transaccion_id = $1, metodo_pago = $2, actualizado_en = NOW()
             WHERE id = $3 
             RETURNING *`,
            [transaccionId, metodoPago, pagoId]
        );

        res.json({
            mensaje: 'Pago confirmado correctamente',
            pago: resultado.rows[0]
        });
    } catch (error) {
        console.error('Error confirmando pago:', error);
        res.status(500).json({ error: 'Error interno al procesar el pago' });
    }
};

module.exports = {
    generarCargosMensuales,
    listarPagos,
    obtenerPagosPendientes,
    procesarGeneracionManual,
    actualizarEstadoPago,
    confirmarPagoPadre
};
