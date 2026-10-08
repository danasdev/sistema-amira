// Dublês usados pelos testes da API: Firestore em memória, req/res e um
// Mercado Pago falso que deixa o teste "avançar" o estado da order.

// O Firestore de verdade recusa `undefined` (erro na escrita). O dublê faz
// o mesmo, pra um bug desses aparecer no teste e não em produção.
function recusarUndefined(valor, caminho = "") {
  if (valor === undefined) throw new Error(`Firestore: valor undefined em "${caminho}"`);
  if (valor && typeof valor === "object" && !(valor instanceof Date)) {
    for (const [k, v] of Object.entries(valor)) recusarUndefined(v, `${caminho}.${k}`);
  }
}

function criarFakeDb(inicial = {}) {
  const colecoes = new Map();
  const col = (nome) => {
    if (!colecoes.has(nome)) colecoes.set(nome, new Map());
    return colecoes.get(nome);
  };
  for (const [nome, docs] of Object.entries(inicial)) {
    for (const [id, d] of Object.entries(docs)) col(nome).set(id, structuredClone(d));
  }

  const gravar = (nome, id, dados) => {
    recusarUndefined(dados, `${nome}/${id}`);
    col(nome).set(id, structuredClone(dados));
  };
  const atualizar = (nome, id, patch) => {
    const atual = col(nome).get(id);
    if (atual === undefined) throw new Error(`NOT_FOUND: ${nome}/${id}`);
    recusarUndefined(patch, `${nome}/${id}`);
    col(nome).set(id, { ...atual, ...structuredClone(patch) });
  };

  const ref = (nome, id) => ({
    id,
    _nome: nome,
    async get() {
      const d = col(nome).get(id);
      return { exists: d !== undefined, id, data: () => structuredClone(d) };
    },
    async set(dados) {
      gravar(nome, id, dados);
    },
    async update(patch) {
      atualizar(nome, id, patch);
    }
  });

  // Consulta minima (where ==, limit) no formato do Admin SDK:
  // query.get() -> { empty, size, docs: [{ id, ref, data() }] }.
  const consulta = (nome, filtros = [], max = Infinity) => ({
    where: (campo, op, valor) => {
      if (op !== "==") throw new Error(`fake: operador ${op} nao suportado`);
      return consulta(nome, [...filtros, [campo, valor]], max);
    },
    limit: (n) => consulta(nome, filtros, n),
    async get() {
      const docs = [...col(nome).entries()]
        .filter(([, d]) => filtros.every(([c, v]) => d[c] === v))
        .slice(0, max)
        .map(([id, d]) => ({ id, ref: ref(nome, id), exists: true, data: () => structuredClone(d) }));
      return { empty: !docs.length, size: docs.length, docs };
    }
  });

  return {
    collection: (nome) => ({ doc: (id) => ref(nome, id), ...consulta(nome) }),
    // Dentro da transação o SDK real enfileira as escritas (síncronas).
    async runTransaction(fn) {
      const t = {
        get: (r) => r.get(),
        set: (r, dados) => gravar(r._nome, r.id, dados),
        update: (r, patch) => atualizar(r._nome, r.id, patch)
      };
      return fn(t);
    },
    ler: (nome, id) => col(nome).get(id),
    todos: (nome) => Object.fromEntries(col(nome))
  };
}

function criarReq({ method = "GET", headers = {}, query = {}, body } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { method, headers: h, query, body };
}

function criarRes() {
  return {
    statusCode: 200,
    headers: {},
    corpo: undefined,
    terminou: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.corpo = o;
      this.terminou = true;
      return this;
    },
    end() {
      this.terminou = true;
      return this;
    }
  };
}

/**
 * Mercado Pago falso. `orders` guarda o que o MP "sabe"; o teste evolui o
 * estado com mp.avancar(orderId, { status, ... }). `falhas.X` faz a
 * chamada X lançar (objeto de erro) na próxima vez.
 */
function criarMpFalso() {
  let seq = 0;
  const orders = new Map();
  const chamadas = [];
  const falhas = {};
  const registrar = (nome, ...args) => chamadas.push([nome, ...args]);
  const talvezFalhar = (nome) => {
    if (falhas[nome]) {
      const e = falhas[nome];
      delete falhas[nome];
      throw e;
    }
  };

  const mp = {
    orders,
    chamadas,
    falhas,
    pagamentos: new Map(), // /v1/payments/{id}
    terminaisMp: [],
    quantas: (nome) => chamadas.filter((c) => c[0] === nome).length,

    avancar(orderId, patch) {
      const o = orders.get(orderId);
      Object.assign(o, patch);
      if (patch.pagamento) {
        o.transactions.payments[0] = { ...o.transactions.payments[0], ...patch.pagamento };
        delete o.pagamento;
      }
      return o;
    },

    async criarOrderPoint(body, chave) {
      registrar("criar", body, chave);
      talvezFalhar("criar");
      seq += 1;
      const id = `ORD0000${seq}`;
      const order = {
        id,
        type: "point",
        external_reference: body.external_reference,
        status: "created",
        status_detail: "created",
        transactions: { payments: [{ id: `PAY0000${seq}`, amount: body.transactions.payments[0].amount, status: "created" }] }
      };
      orders.set(id, order);
      return structuredClone(order);
    },
    async buscarOrderPoint(id) {
      registrar("buscar", id);
      talvezFalhar("buscar");
      if (!orders.has(id)) throw Object.assign(new Error("order não encontrada"), { status: 502, mpStatus: 404 });
      return structuredClone(orders.get(id));
    },
    async cancelarOrderPoint(id, chave) {
      registrar("cancelar", id, chave);
      talvezFalhar("cancelar");
      const o = orders.get(id);
      o.status = "canceled";
      o.status_detail = "canceled_by_api";
      return structuredClone(o);
    },
    async estornarOrderPoint(id, chave) {
      registrar("estornar", id, chave);
      talvezFalhar("estornar");
      const o = orders.get(id);
      o.status = "refunded";
      o.status_detail = "refunded";
      return { status: "refunded", transactions: { refunds: [{ id: "REF1", transaction_id: o.transactions.payments[0].id, amount: o.transactions.payments[0].amount, status: "processed" }] } };
    },
    async listarTerminais() {
      registrar("terminais");
      talvezFalhar("terminais");
      return { data: { terminals: mp.terminaisMp }, paging: { total: mp.terminaisMp.length } };
    },
    async definirModoTerminal(id, modo) {
      registrar("modo", id, modo);
      talvezFalhar("modo");
      return { terminals: [{ id, operating_mode: modo }] };
    },
    async usuarioAtual() {
      registrar("usuario");
      talvezFalhar("usuario");
      return { id: 998877, nickname: "LOJA_AMIRA", site_id: "MLB" };
    },
    async buscarPagamento(id) {
      registrar("pagamento", id);
      talvezFalhar("pagamento");
      if (!mp.pagamentos.has(String(id))) throw Object.assign(new Error("pagamento não encontrado"), { status: 502, mpStatus: 404 });
      return structuredClone(mp.pagamentos.get(String(id)));
    }
  };
  return mp;
}

module.exports = { criarFakeDb, criarReq, criarRes, criarMpFalso };
