/**
 * Formatea una fecha en horario de Ciudad de México, sin depender del
 * timezone/locale por defecto del proceso (el contenedor corre en UTC).
 */
function formatCDMXDateTime(timestamp) {
    const date = new Date(timestamp);
    const options = {
        timeZone: 'America/Mexico_City',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false
    };
    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
    const get = (type) => (parts.find(p => p.type === type) || {}).value || '';

    return {
        dateStr: `${get('day')}/${get('month')}/${get('year')}`,
        timeStr: `${get('hour')}:${get('minute')}`
    };
}

module.exports = { formatCDMXDateTime };
