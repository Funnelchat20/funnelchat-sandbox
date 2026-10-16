// Verifica la cabecera X-Funnelchat-Signature de una entrega de webhook (Node.js 16+).
// cuerpoCrudo: el cuerpo tal como llegó (Buffer o string), sin parsear ni volver a serializar.
// secreto: el secreto completo de la suscripción, tal como se mostró al crearla o rotarla.
const crypto = require('node:crypto');

function verificarFirma(cuerpoCrudo, cabecera, secreto, toleranciaSegundos = 300) {
  if (typeof cabecera !== 'string' || typeof secreto !== 'string' || secreto === '') return false;

  let t = null;
  const firmas = [];
  for (const parte of cabecera.split(',')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    const clave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (clave === 't') t = valor;
    if (clave === 'v1') firmas.push(valor);
  }
  if (t === null || !/^\d+$/.test(t) || firmas.length === 0) return false;

  // Rechazá entregas viejas o del futuro (protección contra repeticiones).
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranciaSegundos) return false;

  const esperada = crypto
    .createHmac('sha256', secreto)
    .update(`${t}.`)
    .update(cuerpoCrudo)
    .digest('hex');
  const a = Buffer.from(esperada, 'utf8');

  return firmas.some((v1) => {
    const b = Buffer.from(v1, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = { verificarFirma };

// Uso con Express: leé el cuerpo crudo, verificá, y recién después parseá.
// app.post('/hooks/funnelchat', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verificarFirma(req.body, req.get('X-Funnelchat-Signature'), process.env.FUNNELCHAT_WEBHOOK_SECRET)) {
//     return res.sendStatus(400);
//   }
//   const evento = JSON.parse(req.body.toString('utf8')); // tomá type e id de acá, no de las cabeceras
//   res.sendStatus(200); // respondé rápido; procesá después
// });
