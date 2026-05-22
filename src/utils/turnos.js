/**
 * Normaliza y mapea el turno de estudio a los valores permitidos: 'matutino' o 'vespertino'.
 * Maneja variaciones como 'mañana', 'manana', 'tarde', etc.
 */
const mapearTurnoEstudio = (turnoRaw) => {
    if (!turnoRaw) return 'matutino';
    
    const turno = String(turnoRaw).trim().toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    
    if (turno === 'manana' || turno === 'matutino') return 'matutino';
    if (turno === 'tarde' || turno === 'vespertino') return 'vespertino';
    
    // Default si no coincide con los conocidos, pero manteniendo el valor original
    // si parece ser un valor intencional, de lo contrario 'matutino'
    return (turno === 'vespertino' || turno === 'matutino') ? turno : 'matutino';
};

module.exports = {
    mapearTurnoEstudio,
};
