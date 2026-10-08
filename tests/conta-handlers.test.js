const test = require("node:test");
const assert = require("node:assert/strict");

const { criarHandlers } = require("../api/_lib/conta-handlers");
const { validarValor, projetarResumo, statusDaCobranca, formaDoPagamento, montarPreferencia } = require("../api/_lib/conta");
const { criarFakeDb, criarReq, criarRes, criarMpFalso } = require("./helpers/fakes");

const TOKEN = "tok_abcdefghijklmnopqrstuvwx1234";
const AGORA = new Date("2026-10-08T15:00:00Z");

function montar({ clientes, caixa = {}, extra = {} } = {}) {
  const db = criarFakeDb({
    clientes: clientes || {
      c1: { nome: "Maria Aparecida Souza", contato: "(11) 9", cpf: "123", total_compras: 300, total_pago: 100, link_token: TOKEN },
    },
    caixa,
    configuracoes: { sistema: { nome_loja: "Amira" } },
    vendas: {
      v1: { numero: 10, cliente_id: "c1", crediario_valor: 300, crediario_entrada: 100, status: "concluida", itens: [{ qtd: 1, nome: "Khamrah" }], data: new Date("2026-10-01T12:00:00Z") },
      v2: { numero: 11, cliente_id: "c1", status: "concluida", total: 50, itens: [] }, // sem crediario
    },
    crediario_pagamentos: {
      p1: { cliente_id: "c1", valor: 100, forma: "dinheiro", origem: "pdv", status: "ok", registrado_por_nome: "Vera", data: new Date("2026-10-01T12:00:00Z") },
    },
    ...extra,
  });
  const mp = criarMpFalso();
  let seq = 0;
  mp.criarPagamento = async (body, chave) => {
    mp.chamadas.push(["criarPagamento", body, chave]);
    const id = String(900 + ++seq);
    const p = {
      id: Number(id), status: "pending", transaction_amount: body.transaction_amount, external_reference: body.external_reference,
      payment_method_id: "pix", payment_type_id: "bank_transfer", date_of_expiration: body.date_of_expiration,
      point_of_interaction: { transaction_data: { qr_code: "00020126...", qr_code_base64: "iVBOR..." } },
    };
    mp.pagamentos.set(id, p);
    return structuredClone(p);
  };
  mp.criarPreferencia = async (body, chave) => {
    mp.chamadas.push(["criarPreferencia", body, chave]);
    return { id: "PREF1", init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=PREF1" };
  };
  mp.porReferencia = new Map();
  mp.buscarPagamentosPorReferencia = async (ref) => ({ results: mp.porReferencia.get(ref) || [] });

  let ids = 0;
  const handlers = criarHandlers({
    getDb: () => db, mp, limitar: async () => {}, env: { CONTA_URL_BASE: "https://api.amira.test" },
    agora: () => AGORA, novoId: () => `id-${String(++ids).padStart(8, "0")}`,
  });
  return { db, mp, handlers };
}

const chamar = async (h, req) => {
  const res = criarRes();
  await h(req, res);
  return res;
};

// ─────────────────────────── regras puras ───────────────────────────
test("validarValor: entre o minimo e o restante", () => {
  assert.deepEqual(validarValor(50, 200), { valor: 50 });
  assert.ok(validarValor(0.5, 200).erro);
  assert.ok(validarValor(201, 200).erro);
  assert.ok(validarValor(10, 0).erro);
  assert.deepEqual(validarValor("200", 200), { valor: 200 });
});

test("projetarResumo nao expoe contato, CPF nem quem registrou; so compras do crediario", () => {
  const r = projetarResumo({
    cliente: { nome: "Maria Aparecida", contato: "x", cpf: "y", total_compras: 300, total_pago: 100 },
    vendas: [{ crediario_valor: 300, status: "concluida", itens: [{ qtd: 1, nome: "A" }] }, { status: "concluida", total: 50 }],
    pagamentos: [{ valor: 100, forma: "pix", status: "ok", registrado_por_nome: "Vera" }, { valor: 5, status: "estornado" }],
  });
  assert.equal(r.cliente.nome, "Maria");
  assert.equal(r.restante, 200);
  assert.equal(r.comprado, 300);
  assert.equal(r.pago, 100);
  assert.equal(r.compras.length, 1);
  assert.equal(r.pagamentos.length, 1);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("Vera") && !json.includes("cpf") && !json.includes("contato"));
});

test("status e forma do pagamento do MP", () => {
  assert.equal(statusDaCobranca("approved"), "aprovado");
  assert.equal(statusDaCobranca("in_process"), "pendente");
  assert.equal(statusDaCobranca("rejected"), "recusado");
  assert.equal(formaDoPagamento({ payment_method_id: "pix" }), "pix");
  assert.equal(formaDoPagamento({ payment_type_id: "credit_card" }), "credito");
});

test("preferencia so com cartao, a vista e auto_return apenas em https", () => {
  const p = montarPreferencia({ valor: 10, cobrancaId: "conta_x", voltarUrl: "https://a/conta?t=1", loja: "Amira" });
  assert.equal(p.payment_methods.installments, 1);
  assert.equal(p.auto_return, "approved");
  assert.ok(p.payment_methods.excluded_payment_types.some((t) => t.id === "bank_transfer"));
  const local = montarPreferencia({ valor: 10, cobrancaId: "conta_x", voltarUrl: "http://localhost/conta", loja: "Amira" });
  assert.equal(local.auto_return, undefined);
});

// ─────────────────────────── resumo ───────────────────────────
test("resumo: link valido devolve a conta; invalido da 404", async () => {
  const { handlers } = montar();
  const ok = await chamar(handlers.resumo, criarReq({ query: { t: TOKEN } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.corpo.restante, 200);
  assert.equal(ok.corpo.cliente.nome, "Maria");
  assert.equal(ok.corpo.precisa_email, true);

  const ruim = await chamar(handlers.resumo, criarReq({ query: { t: "tok_naoexisteeeeeeeeeeeeeeeeeeeee" } }));
  assert.equal(ruim.statusCode, 404);
  const curto = await chamar(handlers.resumo, criarReq({ query: { t: "abc" } }));
  assert.equal(curto.statusCode, 404);
});

// ─────────────────────────── pagar ───────────────────────────
test("pagar pix: cria o pagamento no MP, guarda a cobranca e devolve o QR", async () => {
  const { handlers, db, mp } = montar();
  const res = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 80, metodo: "pix", email: "maria@ex.com" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.pix.qr_code, "00020126...");
  const body = mp.chamadas.find((c) => c[0] === "criarPagamento")[1];
  assert.equal(body.transaction_amount, 80);
  assert.equal(body.notification_url, "https://api.amira.test/api/webhook-conta");
  const cob = db.ler("cobrancas_conta", res.corpo.cobranca);
  assert.equal(cob.status, "pendente");
  assert.equal(cob.cliente_id, "c1");
});

test("pagar: recusa valor acima do restante, pix sem e-mail e metodo desconhecido", async () => {
  const { handlers } = montar();
  const acima = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 500, metodo: "pix", email: "a@b.co" } }));
  assert.equal(acima.statusCode, 400);
  const semEmail = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 50, metodo: "pix" } }));
  assert.equal(semEmail.statusCode, 400);
  const metodo = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 50, metodo: "boleto" } }));
  assert.equal(metodo.statusCode, 400);
});

test("pagar cartao: devolve o link do checkout com volta pra pagina da conta", async () => {
  const { handlers, mp } = montar();
  const res = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 200, metodo: "cartao" } }));
  assert.equal(res.statusCode, 200);
  assert.match(res.corpo.checkout_url, /mercadopago/);
  const pref = mp.chamadas.find((c) => c[0] === "criarPreferencia")[1];
  assert.equal(pref.back_urls.success, `https://api.amira.test/conta?t=${TOKEN}&c=${res.corpo.cobranca}`);
});

// ─────────────────────────── aprovacao ───────────────────────────
test("status: pix aprovado baixa a divida e entra no caixa aberto, uma vez so", async () => {
  const { handlers, db, mp } = montar({ caixa: { cx1: { status: "aberto" } } });
  const p = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 80, metodo: "pix", email: "m@ex.com" } }));
  const c = p.corpo.cobranca;

  const pendente = await chamar(handlers.status, criarReq({ query: { t: TOKEN, c } }));
  assert.equal(pendente.corpo.status, "pendente");

  mp.pagamentos.get("901").status = "approved";
  const aprovado = await chamar(handlers.status, criarReq({ query: { t: TOKEN, c } }));
  assert.equal(aprovado.corpo.status, "aprovado");
  // de novo (polling + webhook): nao duplica
  await chamar(handlers.status, criarReq({ query: { t: TOKEN, c } }));
  await chamar(handlers.webhook, criarReq({ method: "POST", query: { type: "payment", "data.id": "901" } }));

  assert.equal(db.ler("clientes", "c1").total_pago, 180);
  const pag = db.ler("crediario_pagamentos", "mp_901");
  assert.equal(pag.valor, 80);
  assert.equal(pag.forma, "pix");
  assert.equal(pag.origem, "online");
  assert.equal(pag.caixa_id, "cx1");
  assert.equal(pag.aguardando_caixa, false);
  assert.equal(Object.keys(db.todos("crediario_pagamentos")).length, 2);
});

test("aprovado com caixa fechado: fica aguardando o proximo caixa", async () => {
  const { handlers, db, mp } = montar({ caixa: { cx0: { status: "fechado" } } });
  const p = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 50, metodo: "pix", email: "m@ex.com" } }));
  mp.pagamentos.get("901").status = "approved";
  await chamar(handlers.webhook, criarReq({ method: "POST", body: { type: "payment", data: { id: "901" } } }));
  const pag = db.ler("crediario_pagamentos", "mp_901");
  assert.equal(pag.caixa_id, null);
  assert.equal(pag.aguardando_caixa, true);
  assert.equal(db.ler("cobrancas_conta", p.corpo.cobranca).status, "aprovado");
});

test("cartao: status acha o pagamento pela external_reference", async () => {
  const { handlers, db, mp } = montar();
  const p = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 200, metodo: "cartao" } }));
  const c = p.corpo.cobranca;
  mp.porReferencia.set(c, [{ id: 77, status: "approved", transaction_amount: 200, payment_type_id: "credit_card", external_reference: c }]);
  const r = await chamar(handlers.status, criarReq({ query: { t: TOKEN, c } }));
  assert.equal(r.corpo.status, "aprovado");
  assert.equal(db.ler("clientes", "c1").total_pago, 300);
  assert.equal(db.ler("crediario_pagamentos", "mp_77").forma, "credito");
});

test("status: cobranca de outro cliente nao aparece", async () => {
  const outro = "tok_outroclientexxxxxxxxxxxxxxx";
  const { handlers } = montar({
    clientes: {
      c1: { nome: "Maria", total_compras: 300, total_pago: 100, link_token: TOKEN },
      c2: { nome: "Joana", total_compras: 100, total_pago: 0, link_token: outro },
    },
  });
  const p = await chamar(handlers.pagar, criarReq({ method: "POST", body: { t: TOKEN, valor: 10, metodo: "pix", email: "m@ex.com" } }));
  const r = await chamar(handlers.status, criarReq({ query: { t: outro, c: p.corpo.cobranca } }));
  assert.equal(r.statusCode, 404);
});

test("webhook: ignora pagamento que nao e do link e recusa assinatura errada", async () => {
  const { handlers, mp } = montar();
  mp.pagamentos.set("555", { id: 555, status: "approved", external_reference: "pdv-qualquer" });
  const outro = await chamar(handlers.webhook, criarReq({ method: "POST", query: { type: "payment", "data.id": "555" } }));
  assert.equal(outro.statusCode, 200);

  const { handlers: h2 } = (() => {
    const m = montar();
    return { handlers: criarHandlers({ getDb: () => m.db, mp: m.mp, limitar: async () => {}, env: { MP_WEBHOOK_SECRET: "s" } }) };
  })();
  const errada = await chamar(h2.webhook, criarReq({ method: "POST", headers: { "x-signature": "ts=1,v1=abcd" }, query: { "data.id": "1" } }));
  assert.equal(errada.statusCode, 401);
});
