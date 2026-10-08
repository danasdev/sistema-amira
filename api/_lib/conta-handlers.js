// ── Handlers do link de pagamento do crediário (dependências injetadas) ─
// Rotas PÚBLICAS (sem login): quem tem o link (token secreto do cliente)
// vê a própria conta e paga. Mesmo desenho dos handlers da maquininha:
// a lógica mora aqui e recebe Firestore / Mercado Pago por parâmetro; os
// arquivos em api/conta/*.js só ligam as dependências reais.
//
//   GET  /api/conta/resumo?t=TOKEN          conta do cliente (projeção pública)
//   POST /api/conta/pagar  {t, valor, metodo: "pix"|"cartao", email?}
//   GET  /api/conta/status?t=TOKEN&c=ID     estado da cobrança (consulta o MP)
//   POST /api/webhook-conta                 notificação do MP (tópico payment)
//
// Cobranças ficam em `cobrancas_conta/{id}` (só Admin SDK: o catch-all das
// firestore.rules fecha a coleção pro navegador). O pagamento aprovado é
// aplicado UMA vez (doc `crediario_pagamentos/mp_<paymentId>`), venha da
// consulta da página ou do webhook — o que chegar primeiro.

const crypto = require("crypto");
const { aplicarCors } = require("./cors");
const { erroHttp, corpoJson, responderErro } = require("./http");
const { checarAssinatura } = require("./point-handlers");
const {
  TOKEN_VALIDO, COBRANCA_VALIDA, round2, saldo, validarValor, projetarResumo, emailValido,
  montarPix, montarPreferencia, statusDaCobranca, formaDoPagamento, dadosPix
} = require("./conta");

const COLECAO = "cobrancas_conta";

function criarHandlers({
  getDb, mp, limitar,
  env = process.env,
  agora = () => new Date(),
  novoId = () => crypto.randomUUID()
}) {
  // URL pública desta API (pra notification_url e back_urls). CONTA_URL_BASE
  // fixa; senão, o host da própria requisição (a Vercel manda x-forwarded-*).
  function urlBase(req) {
    if (env.CONTA_URL_BASE) return String(env.CONTA_URL_BASE).replace(/\/+$/, "");
    const h = req.headers || {};
    const host = h["x-forwarded-host"] || h.host;
    if (!host) return "";
    const proto = h["x-forwarded-proto"] || (/^(localhost|127\.)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  // MP só aceita notification_url pública em https.
  const urlNotificacao = (base) => (/^https:\/\//.test(base) ? `${base}/api/webhook-conta` : null);

  function tokenDe(valor) {
    const t = String(valor || "");
    if (!TOKEN_VALIDO.test(t)) throw erroHttp(404, "Link inválido ou expirado. Peça um link novo na loja.");
    return t;
  }

  async function clientePorToken(db, token) {
    const snap = await db.collection("clientes").where("link_token", "==", token).limit(1).get();
    if (snap.empty) throw erroHttp(404, "Link inválido ou expirado. Peça um link novo na loja.");
    const d = snap.docs[0];
    return { id: d.id, ref: d.ref, dados: d.data() };
  }

  async function nomeDaLoja(db) {
    try {
      const s = await db.collection("configuracoes").doc("sistema").get();
      return (s.exists && s.data().nome_loja) || "Amira";
    } catch {
      return "Amira";
    }
  }

  // ── Aplica um pagamento do MP numa cobrança (idempotente) ────────────
  async function aplicar(db, cobrancaId, pagamento) {
    const cobRef = db.collection(COLECAO).doc(cobrancaId);
    const status = statusDaCobranca(pagamento && pagamento.status);
    const pagamentoId = pagamento && pagamento.id != null ? String(pagamento.id) : null;

    if (status !== "aprovado") {
      await db.runTransaction(async (t) => {
        const s = await t.get(cobRef);
        if (!s.exists || s.data().status === "aprovado") return;
        t.update(cobRef, { status, ...(pagamentoId ? { mp_payment_id: pagamentoId } : {}), atualizado_em: agora() });
      });
      return status;
    }

    // Caixa aberto agora (fora da transação: consulta). Sem caixa, o
    // pagamento fica "aguardando caixa" e o próximo caixa aberto o assume.
    const caixaSnap = await db.collection("caixa").where("status", "==", "aberto").limit(1).get();
    const caixaId = caixaSnap.empty ? null : caixaSnap.docs[0].id;
    const pagRef = db.collection("crediario_pagamentos").doc(`mp_${pagamentoId}`);

    await db.runTransaction(async (t) => {
      const cob = await t.get(cobRef);
      if (!cob.exists) return;
      const c = cob.data();
      if (c.status === "aprovado") return;
      const ja = await t.get(pagRef);
      const cliRef = db.collection("clientes").doc(c.cliente_id);
      const cli = await t.get(cliRef);
      const valor = round2(pagamento.transaction_amount != null ? pagamento.transaction_amount : c.valor);

      if (!ja.exists) {
        t.set(pagRef, {
          cliente_id: c.cliente_id,
          cliente_nome: (cli.exists && cli.data().nome) || c.cliente_nome || "",
          valor,
          forma: formaDoPagamento(pagamento),
          origem: "online",
          caixa_id: caixaId,
          aguardando_caixa: !caixaId,
          data: agora(),
          registrado_por_uid: "online",
          registrado_por_nome: "Pagamento online",
          status: "ok",
          mp_payment_id: pagamentoId,
          cobranca_id: cobrancaId
        });
        if (cli.exists) {
          t.update(cliRef, { total_pago: round2((Number(cli.data().total_pago) || 0) + valor), atualizado_em: agora() });
        }
      }
      t.update(cobRef, { status: "aprovado", mp_payment_id: pagamentoId, valor_pago: valor, aprovado_em: agora(), atualizado_em: agora() });
    });
    return "aprovado";
  }

  // Busca no MP o pagamento de uma cobrança: Pix pelo id; cartão pela
  // external_reference (prefere o aprovado, senão o mais recente).
  async function pagamentoDaCobranca(c, cobrancaId) {
    if (c.mp_payment_id) return mp.buscarPagamento(c.mp_payment_id);
    const r = await mp.buscarPagamentosPorReferencia(cobrancaId);
    const lista = (r && r.results) || [];
    return lista.find((p) => p.status === "approved") || lista[0] || null;
  }

  // ── GET /api/conta/resumo ───────────────────────────────────────────
  async function resumo(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "GET") throw erroHttp(405, "Método não permitido.");
      const token = tokenDe(req.query && req.query.t);
      const db = getDb();
      await limitar(db, `conta-ver:${token}`, { max: 60, janelaSegundos: 300 });
      const cli = await clientePorToken(db, token);
      const [vendas, pagamentos, loja] = await Promise.all([
        db.collection("vendas").where("cliente_id", "==", cli.id).get(),
        db.collection("crediario_pagamentos").where("cliente_id", "==", cli.id).get(),
        nomeDaLoja(db)
      ]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(projetarResumo({
        cliente: cli.dados,
        vendas: vendas.docs.map((d) => d.data()),
        pagamentos: pagamentos.docs.map((d) => d.data()),
        loja
      }));
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── POST /api/conta/pagar ───────────────────────────────────────────
  async function pagar(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "POST") throw erroHttp(405, "Método não permitido.");
      const corpo = corpoJson(req);
      const token = tokenDe(corpo.t);
      const metodo = corpo.metodo === "cartao" ? "cartao" : corpo.metodo === "pix" ? "pix" : null;
      if (!metodo) throw erroHttp(400, "Escolha Pix ou cartão.");
      const db = getDb();
      await limitar(db, `conta-pagar:${token}`, { max: 8, janelaSegundos: 600, mensagem: "Muitas tentativas de pagamento seguidas. Espere alguns minutos." });

      const cli = await clientePorToken(db, token);
      const { restante } = saldo(cli.dados);
      const v = validarValor(corpo.valor, restante);
      if (v.erro) throw erroHttp(400, v.erro);

      const email = String(cli.dados.email || corpo.email || "").trim();
      if (metodo === "pix" && !emailValido(email)) throw erroHttp(400, "Informe um e-mail válido pra receber o comprovante.");

      const cobrancaId = `conta_${novoId()}`;
      const loja = await nomeDaLoja(db);
      const base = urlBase(req);
      const notificationUrl = urlNotificacao(base);
      const doc = {
        cliente_id: cli.id,
        cliente_nome: cli.dados.nome || "",
        valor: v.valor,
        metodo,
        status: "pendente",
        criado_em: agora(),
        atualizado_em: agora()
      };

      if (metodo === "pix") {
        const pagamento = await mp.criarPagamento(
          montarPix({ valor: v.valor, cobrancaId, email, nome: cli.dados.nome, notificationUrl, loja, agora: agora() }),
          cobrancaId
        );
        const pix = dadosPix(pagamento);
        if (!pix.qr_code) throw erroHttp(502, "O Mercado Pago não devolveu o QR code do Pix. Tente de novo.");
        await db.collection(COLECAO).doc(cobrancaId).set({ ...doc, mp_payment_id: String(pagamento.id), pix_expira_em: pix.expira_em || null });
        return res.status(200).json({ cobranca: cobrancaId, metodo, valor: v.valor, pix });
      }

      const voltarUrl = base ? `${base}/conta?t=${encodeURIComponent(token)}&c=${encodeURIComponent(cobrancaId)}` : null;
      const pref = await mp.criarPreferencia(
        montarPreferencia({ valor: v.valor, cobrancaId, email: emailValido(email) ? email : null, notificationUrl, voltarUrl, loja }),
        cobrancaId
      );
      if (!pref || !pref.init_point) throw erroHttp(502, "O Mercado Pago não devolveu o link do checkout. Tente de novo.");
      await db.collection(COLECAO).doc(cobrancaId).set({ ...doc, mp_preferencia_id: String(pref.id || "") });
      return res.status(200).json({ cobranca: cobrancaId, metodo, valor: v.valor, checkout_url: pref.init_point });
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── GET /api/conta/status ───────────────────────────────────────────
  // Cada consulta atualiza direto no MP: o fluxo funciona mesmo sem o
  // webhook configurado (o webhook é a rede de segurança).
  async function status(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "GET") throw erroHttp(405, "Método não permitido.");
      const token = tokenDe(req.query && req.query.t);
      const cobrancaId = String((req.query && req.query.c) || "");
      if (!COBRANCA_VALIDA.test(cobrancaId)) throw erroHttp(400, "Cobrança inválida.");
      const db = getDb();
      await limitar(db, `conta-status:${token}`, { max: 120, janelaSegundos: 300 });
      const cli = await clientePorToken(db, token);
      const snap = await db.collection(COLECAO).doc(cobrancaId).get();
      if (!snap.exists || snap.data().cliente_id !== cli.id) throw erroHttp(404, "Cobrança não encontrada.");
      let c = snap.data();

      if (c.status === "pendente") {
        try {
          const pagamento = await pagamentoDaCobranca(c, cobrancaId);
          if (pagamento) {
            await aplicar(db, cobrancaId, pagamento);
            c = (await db.collection(COLECAO).doc(cobrancaId).get()).data();
          }
        } catch (erro) {
          // MP fora do ar: devolve o último estado conhecido, a tela tenta de novo.
          console.warn("[conta/status] não consegui consultar o MP:", erro && erro.message);
        }
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ cobranca: cobrancaId, status: c.status, valor: c.valor, metodo: c.metodo });
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── POST /api/webhook-conta (chamado pelo Mercado Pago) ──────────────
  // Tópico "payment". A notificação só serve de gatilho: buscamos o
  // pagamento de verdade no MP (nunca confiamos no corpo).
  async function webhook(req, res) {
    if (req.method !== "POST" && req.method !== "GET") return res.status(405).end();
    try {
      const q = req.query || {};
      const b = (req.body && typeof req.body === "object" && req.body) || {};
      const tipo = q.type || q.topic || b.type || b.topic || "";
      const pagamentoId = q["data.id"] || q.id || (b.data && b.data.id) || null;

      // Assinatura ERRADA é recusada. Sem assinatura passa: a notificação
      // da notification_url pode vir sem x-signature, e ela só dispara uma
      // consulta ao MP (nunca usamos o corpo) — o pior caso é uma leitura a mais.
      const assinatura = checarAssinatura(req, pagamentoId || "", env);
      if (assinatura === "sem-segredo" || assinatura === "sem-assinatura") {
        console.warn(`[conta/webhook] notificação sem validação de assinatura (${assinatura}).`);
      } else if (assinatura !== "ok") {
        console.warn(`[conta/webhook] assinatura recusada: ${assinatura}`);
        return res.status(401).json({ erro: "Assinatura inválida" });
      }

      if (!pagamentoId || !/^\d+$/.test(String(pagamentoId)) || (tipo && !/payment/i.test(tipo))) return res.status(200).end();

      const pagamento = await mp.buscarPagamento(pagamentoId);
      const cobrancaId = pagamento && pagamento.external_reference;
      if (!cobrancaId || !COBRANCA_VALIDA.test(String(cobrancaId))) return res.status(200).end(); // não é do link

      const db = getDb();
      const snap = await db.collection(COLECAO).doc(String(cobrancaId)).get();
      if (!snap.exists) return res.status(200).end();

      await aplicar(db, String(cobrancaId), pagamento);
      return res.status(200).json({ ok: true });
    } catch (erro) {
      // 500 de propósito: o MP tenta de novo mais tarde.
      console.error("[conta/webhook]", erro && erro.message);
      return res.status(500).json({ erro: "Falha ao processar a notificação." });
    }
  }

  return { resumo, pagar, status, webhook, aplicar };
}

module.exports = { criarHandlers, COLECAO };
