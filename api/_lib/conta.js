// ── Link de pagamento do crediário — regras puras (sem rede) ───────────
// Cada cliente do crediário tem um `link_token` secreto (gerado na tela
// Clientes). A página pública /conta?t=TOKEN mostra a conta dele e deixa
// pagar por Pix (QR na própria página) ou cartão (Checkout Pro do MP). O
// pagamento aprovado vira um doc em `crediario_pagamentos` (origem
// "online"), soma em `clientes.total_pago` e entra no caixa aberto — ou no
// próximo caixa que abrir (`aguardando_caixa`).

const TOKEN_VALIDO = /^[A-Za-z0-9_-]{24,64}$/;
const COBRANCA_VALIDA = /^conta_[A-Za-z0-9-]{8,60}$/;
const VALOR_MINIMO = 1;
const PIX_EXPIRA_MIN = 30;

const round2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100;

function saldo(cliente) {
  const compras = round2(cliente && cliente.total_compras);
  const pago = round2(cliente && cliente.total_pago);
  return { compras, pago, restante: round2(compras - pago) };
}

/** Valor que o cliente quer pagar: entre o mínimo e o restante. Lança {status, publico}. */
function validarValor(valorBruto, restante) {
  const valor = round2(valorBruto);
  if (!(restante > 0)) return { erro: "Não há nada a pagar nesta conta." };
  if (!Number.isFinite(valor) || valor < VALOR_MINIMO) return { erro: `O valor mínimo é R$ ${VALOR_MINIMO},00.` };
  if (valor > restante + 0.001) return { erro: "O valor é maior que o restante da conta." };
  return { valor };
}

/** Primeiro nome, pra não expor o nome completo na página pública. */
function primeiroNome(nome) {
  return String(nome || "").trim().split(/\s+/)[0] || "Cliente";
}

const ms = (ts) => {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
};

/**
 * O que a página pública pode ver. Nada de contato, CPF, endereço,
 * observações internas nem quem registrou o pagamento.
 */
function projetarResumo({ cliente, vendas = [], pagamentos = [], loja = "Amira" }) {
  const s = saldo(cliente);
  const compras = vendas
    .filter((v) => v.crediario_valor > 0 && v.status === "concluida")
    .sort((a, b) => (ms(b.data) || 0) - (ms(a.data) || 0))
    .slice(0, 30)
    .map((v) => ({
      numero: v.numero ?? null,
      data: ms(v.data),
      itens: (v.itens || []).map((it) => ({ qtd: Number(it.qtd) || 1, nome: String(it.nome || "") })),
      valor: round2(v.crediario_valor),
      pago_na_hora: round2(v.crediario_entrada || 0)
    }));
  const pags = pagamentos
    .filter((p) => p.status !== "estornado")
    .sort((a, b) => (ms(b.data) || 0) - (ms(a.data) || 0))
    .slice(0, 30)
    .map((p) => ({ data: ms(p.data), valor: round2(p.valor), forma: String(p.forma || ""), online: p.origem === "online" }));
  return {
    loja,
    cliente: { nome: primeiroNome(cliente && cliente.nome) },
    comprado: s.compras,
    pago: s.pago,
    restante: s.restante,
    compras,
    pagamentos: pags,
    precisa_email: !(cliente && cliente.email),
    valor_minimo: VALOR_MINIMO
  };
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim());

/** Corpo do pagamento Pix em /v1/payments. */
function montarPix({ valor, cobrancaId, email, nome, notificationUrl, loja, agora }) {
  const expira = new Date(agora.getTime() + PIX_EXPIRA_MIN * 60 * 1000);
  return {
    transaction_amount: valor,
    payment_method_id: "pix",
    description: `${loja} — pagamento do crediário`,
    external_reference: cobrancaId,
    date_of_expiration: expira.toISOString().replace("Z", "-00:00"),
    payer: { email: String(email).trim(), first_name: primeiroNome(nome) },
    ...(notificationUrl ? { notification_url: notificationUrl } : {})
  };
}

/** Preferência do Checkout Pro (só cartão, à vista). */
function montarPreferencia({ valor, cobrancaId, email, notificationUrl, voltarUrl, loja }) {
  const https = /^https:\/\//.test(voltarUrl || "");
  return {
    items: [{ id: "crediario", title: `${loja} — pagamento do crediário`, quantity: 1, unit_price: valor, currency_id: "BRL" }],
    external_reference: cobrancaId,
    ...(email ? { payer: { email: String(email).trim() } } : {}),
    payment_methods: {
      // Só cartão: Pix já é oferecido na própria página, boleto demora dias.
      excluded_payment_types: [{ id: "ticket" }, { id: "bank_transfer" }, { id: "atm" }],
      installments: 1
    },
    ...(voltarUrl ? { back_urls: { success: voltarUrl, pending: voltarUrl, failure: voltarUrl } } : {}),
    // auto_return exige back_url https (em teste local o cliente volta clicando).
    ...(https ? { auto_return: "approved" } : {}),
    ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    statement_descriptor: String(loja || "AMIRA").toUpperCase().slice(0, 22)
  };
}

/** Status do MP -> status da cobrança. */
function statusDaCobranca(statusMp) {
  switch (statusMp) {
    case "approved": return "aprovado";
    case "rejected": return "recusado";
    case "cancelled": return "cancelado";
    case "refunded":
    case "charged_back": return "estornado";
    default: return "pendente"; // pending, in_process, authorized, in_mediation
  }
}

/** Forma do pagamento aprovado, no vocabulário do sistema. */
function formaDoPagamento(pagamento) {
  const metodo = pagamento && pagamento.payment_method_id;
  const tipo = pagamento && pagamento.payment_type_id;
  if (metodo === "pix" || tipo === "bank_transfer") return "pix";
  if (tipo === "debit_card") return "debito";
  if (tipo === "credit_card") return "credito";
  return "online";
}

/** Dados do Pix pra tela (QR em base64 + copia-e-cola). */
function dadosPix(pagamento) {
  const td = (pagamento && pagamento.point_of_interaction && pagamento.point_of_interaction.transaction_data) || {};
  return {
    qr_code: td.qr_code || null,
    qr_code_base64: td.qr_code_base64 || null,
    expira_em: (pagamento && pagamento.date_of_expiration) || null
  };
}

module.exports = {
  TOKEN_VALIDO, COBRANCA_VALIDA, VALOR_MINIMO, PIX_EXPIRA_MIN,
  round2, saldo, validarValor, primeiroNome, projetarResumo, emailValido,
  montarPix, montarPreferencia, statusDaCobranca, formaDoPagamento, dadosPix
};
