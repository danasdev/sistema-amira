// ── Cliente mínimo da API do Mercado Pago (Point / Orders) ─────────────
// Sem o SDK oficial — só `fetch` (nativo no Node 18+). Mesma convenção do
// backend do site (repo Amira, api/_lib/mercadopago.js): o access token vai
// numa Environment Variable da Vercel (MP_ACCESS_TOKEN), nunca no front.
//
// Docs (Point via Orders API):
//   https://www.mercadopago.com.br/developers/pt/docs/mp-point/overview
//   https://www.mercadopago.com.br/developers/pt/docs/mp-point/payment-processing
//   https://www.mercadopago.com.br/developers/pt/docs/mp-point/configure-terminal

const MP_BASE = "https://api.mercadopago.com";

function token() {
  const t = process.env.MP_ACCESS_TOKEN;
  if (!t) throw new Error("MP_ACCESS_TOKEN não configurada nas Environment Variables.");
  return t;
}

async function mpFetch(caminho, { method = "GET", body, idempotencyKey, headers = {} } = {}) {
  const resposta = await fetch(`${MP_BASE}${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "X-Idempotency-Key": String(idempotencyKey) } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    // 502 (Bad Gateway) é a semântica certa: a falha é entre NÓS e o Mercado
    // Pago, não de quem chamou a nossa API. A mensagem do MP não é segredo —
    // descreve o que está errado com a integração (terminal fora do modo
    // PDV, token de outra conta...), é o que quem configura precisa ler.
    // `mpStatus` guarda o HTTP original pra quem precisar distinguir (ex.:
    // 409 = já existe cobrança pendente na maquininha).
    const primeiro = Array.isArray(dados.errors) && dados.errors[0] ? dados.errors[0] : null;
    const mensagemMp = String(
      (primeiro && (primeiro.message || primeiro.code)) || dados.message || dados.error || `HTTP ${resposta.status}`
    );
    const erro = new Error(`Mercado Pago ${method} ${caminho} -> HTTP ${resposta.status}: ${mensagemMp}`);
    erro.detalhe = dados;
    erro.status = 502;
    erro.mpStatus = resposta.status;
    erro.publico = `O Mercado Pago recusou a requisição: ${mensagemMp}`;
    throw erro;
  }
  return dados;
}

const id = (valor) => encodeURIComponent(String(valor));

module.exports = {
  mpFetch,

  // Cria a cobrança na maquininha (Orders API, type "point"). A maquininha
  // em modo PDV recebe a order e mostra o valor pro cliente passar o cartão.
  // A chave de idempotência evita cobrança em dobro se a resposta se perder
  // e o PDV repetir a chamada.
  criarOrderPoint: (body, idempotencyKey) =>
    mpFetch("/v1/orders", { method: "POST", body, idempotencyKey }),

  // Estado atual da order (só orders com menos de 3 meses).
  buscarOrderPoint: (orderId) => mpFetch(`/v1/orders/${id(orderId)}`),

  // Cancela a order. O header pede o cancelamento mesmo se a order já
  // chegou na maquininha (at_terminal) — a doc de migração mostra assim; a
  // doc de processamento diz que nesse estado só cancela pela própria
  // maquininha. Se o MP recusar, o handler orienta cancelar por lá.
  cancelarOrderPoint: (orderId, idempotencyKey) =>
    mpFetch(`/v1/orders/${id(orderId)}/cancel`, {
      method: "POST",
      idempotencyKey,
      headers: { "x-allow-cancelable-status": "at_terminal" }
    }),

  // Estorno TOTAL (o MP não faz parcial), até 90 dias depois do pagamento.
  estornarOrderPoint: (orderId, idempotencyKey) =>
    mpFetch(`/v1/orders/${id(orderId)}/refund`, { method: "POST", idempotencyKey }),

  // Terminais da conta (id no formato TIPO__SERIAL, modo de operação...).
  listarTerminais: () => mpFetch("/terminals/v1/list?limit=50&offset=0"),

  // Coloca o terminal em modo PDV (recebe cobranças do sistema) ou
  // STANDALONE (maquininha autônoma, como se não houvesse integração).
  definirModoTerminal: (terminalId, modo) =>
    mpFetch("/terminals/v1/setup", {
      method: "PATCH",
      body: { terminals: [{ id: terminalId, operating_mode: modo }] }
    }),

  // Pagamento pela API clássica (/v1/payments) — onde o MP costuma expor as
  // taxas (fee_details) e o valor líquido (net_received_amount).
  buscarPagamento: (pagamentoId) => mpFetch(`/v1/payments/${id(pagamentoId)}`),

  // Dono do access token (id, apelido, país). Serve pra provar que o token
  // é válido e de qual conta — usado só no diagnóstico.
  usuarioAtual: () => mpFetch("/users/me"),

  // ── Link de pagamento do crediário (api/conta/*) ──────────────────────
  // Pix: pagamento direto em /v1/payments; a resposta traz o QR code e o
  // copia-e-cola em point_of_interaction.transaction_data.
  // https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-configuration/integrate-pix
  criarPagamento: (body, idempotencyKey) =>
    mpFetch("/v1/payments", { method: "POST", body, idempotencyKey }),

  // Cartão: preferência do Checkout Pro (o cliente paga na página do MP e
  // volta pela back_url).
  // https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/overview
  criarPreferencia: (body, idempotencyKey) =>
    mpFetch("/checkout/preferences", { method: "POST", body, idempotencyKey }),

  // Pagamentos de uma preferência (Checkout Pro não devolve o id do
  // pagamento na criação — procuramos pela external_reference).
  buscarPagamentosPorReferencia: (referencia) =>
    mpFetch(`/v1/payments/search?sort=date_created&criteria=desc&limit=10&external_reference=${id(referencia)}`)
};
