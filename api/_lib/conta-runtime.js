// ── Liga as dependências REAIS nos handlers do link de pagamento ───────
// Os arquivos em api/conta/*.js só reexportam um handler daqui. (Os testes
// usam criarHandlers() direto, com dependências falsas.)

const { getDb } = require("./firebase-admin");
const { limitar } = require("./limite");
const mp = require("./mercadopago");
const { criarHandlers } = require("./conta-handlers");

module.exports = criarHandlers({ getDb, mp, limitar });
