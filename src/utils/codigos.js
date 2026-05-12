const caracteresBase = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Genera un código aleatorio alfanumérico.
 */
const generarCodigoAleatorio = (longitud = 8) => {
    let codigo = '';
    for (let i = 0; i < longitud; i += 1) {
        codigo += caracteresBase.charAt(Math.floor(Math.random() * caracteresBase.length));
    }
    return codigo;
};

/**
 * Normaliza un código para comparaciones.
 */
const normalizarCodigo = (codigo) =>
    String(codigo || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

module.exports = {
    generarCodigoAleatorio,
    normalizarCodigo,
};
