// ── POST /api/webhook-conta ────────────────────────────────────────────
// Notificação do Mercado Pago (tópico "payment") sobre pagamentos feitos
// pelo link do crediário. Não precisa configurar no painel do MP: cada
// cobrança já manda a própria notification_url apontando pra cá.
// Lógica em _lib/conta-handlers.js.
module.exports = require("./_lib/conta-runtime").webhook;
