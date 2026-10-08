import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, getDoc, query, orderBy, limit,
  doc, updateDoc, runTransaction, serverTimestamp,
} from "../db.js";
import { brl } from "../money.js";
import { derivarItensPedido } from "../produtos-schema.js";
import { mapaDoCatalogo } from "../catalogo-cache.js";

// ── Pedidos do SITE (colecao `pedidos`, compartilhada com flora-5754a) ──────
// O pedido do site NAO guarda valor: itens = {produtoId, quantidade, modo}.
// O total e derivado do catalogo atual (mesma ideia da apuracao de indicadores).
// Baixa de estoque = opcao B: ao entrar num status que "consome" (pago em
// diante), uma transacao decrementa `estoque` (pool unico, sem separacao
// varejo/atacado) e marca `estoqueBaixado: true` no pedido (evita baixa
// dupla). Cancelar um pedido que ja baixou devolve o estoque. As rules ja
// permitem `update` de `pedidos` e de
// `produtos` para admin — nada muda no site.
//
// LEITURAS (mesma cota grátis do site): o catálogo vem do cache da aba
// (../catalogo-cache.js — só preço/classificação; a baixa de estoque relê o
// produto na transação). O nome de cada comprador é lido UMA vez por aba e
// reaproveitado em "Atualizar". Mudar o status relê só aquele pedido — antes
// relia catálogo + 300 pedidos + todos os compradores a cada mudança.

const STATUS = ["aguardando_pagamento", "pago", "preparando", "enviado", "entregue", "cancelado"];
const STATUS_LABEL = {
  aguardando_pagamento: "Aguardando pagamento",
  pago: "Pago",
  preparando: "Preparando",
  enviado: "Enviado",
  entregue: "Entregue",
  cancelado: "Cancelado",
};
const STATUS_TAG = {
  aguardando_pagamento: "sem_estoque",
  pago: "ativo",
  preparando: "ativo",
  enviado: "ativo",
  entregue: "concluida",
  cancelado: "cancelada",
};
// Status em que o estoque ja deve estar baixado.
const CONSOME_ESTOQUE = new Set(["pago", "preparando", "enviado", "entregue"]);

// O webhook do Mercado Pago (backend do site, repo separado) desconta o
// estoque no MESMO instante em que confirma o pagamento (pagamento.status
// vira "aprovado") — ver api/_lib/estoque.js la. Ele NAO marca
// estoqueBaixado no pedido (so este sistema usava esse campo). Sem esta
// checagem extra, ao avancar o status aqui (pago -> preparando -> ... ->
// entregue) o sistema acharia que o estoque nunca foi baixado e descontaria
// a MESMA compra de novo. pagamento.status so e escrito pelo backend do
// site (nunca por este sistema), entao e um sinal confiavel de que a baixa
// ja aconteceu do lado de la.
function estoqueJaConsumido(pedido) {
  return pedido.estoqueBaixado === true || pedido?.pagamento?.status === "aprovado";
}

// Codigo de retirada mostrado ao cliente (comprovante, confirmacao, QR Code)
// e conferido no balcao. NUNCA fica gravado no pedido — e sempre recalculado
// a partir do id do documento (mesmo calculo do site, ver
// frontend/src/pages/services/pedidos.js:codigoRetirada). Por isso, pra achar
// um pedido a partir desse codigo, recalculamos o codigo de cada pedido ja
// carregado e comparamos, em vez de buscar direto por id.
const AMBIGUOS_RETIRADA = { O: "0", I: "1", L: "1", U: "V" };
function codigoRetirada(pedidoId) {
  const base = String(pedidoId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(-6)
    .padStart(6, "X");
  const limpo = [...base].map((c) => AMBIGUOS_RETIRADA[c] || c).join("");
  return `AMR-${limpo}`;
}
/** Tira o prefixo "AMR-" (se tiver) e qualquer coisa que nao seja letra/numero. */
function normalizarCodigoRetirada(s) {
  return String(s || "").trim().toUpperCase().replace(/^AMR-?/, "").replace(/[^A-Z0-9]/g, "");
}

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "pedidos" });
root.innerHTML = `<div class="card">Carregando...</div>`;

let produtosMap = new Map();
let compradores = {};
let pedidos = [];
let filtroStatus = "";
let filtroCodigo = "";

root.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:end">
      <div>
        <label>Status</label>
        <select id="fstatus">
          <option value="">Todos</option>
          ${STATUS.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Codigo do pedido</label>
        <input id="fcodigo" placeholder="cole ou digite o codigo do pedido">
      </div>
      <div style="flex:0 0 auto"><button class="btn" id="atualizar">Atualizar</button></div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="ler-qrcode">Ler QR Code (retirada)</button></div>
    </div>
    <p class="muted" style="margin:8px 0 0">Ultimos 300 pedidos do site. O "codigo" e o mesmo numero de pedido mostrado pro cliente na confirmacao de compra no site. Total derivado dos precos atuais do catalogo (o pedido do site nao guarda valor) e sem frete.</p>
  </div>
  <div class="card"><div id="lista">Carregando...</div></div>`;

document.getElementById("fstatus").onchange = () => {
  filtroStatus = document.getElementById("fstatus").value;
  renderLista();
};
document.getElementById("fcodigo").oninput = () => {
  filtroCodigo = document.getElementById("fcodigo").value.trim();
  renderLista();
};
document.getElementById("fcodigo").onkeydown = async (e) => {
  if (e.key !== "Enter") return;
  const codigo = document.getElementById("fcodigo").value.trim();
  if (!codigo) return;
  const alvo = normalizarCodigoRetirada(codigo);
  const jaCarregado = pedidos.some((p) => p.id === codigo || (alvo && codigoRetirada(p.id) === `AMR-${alvo}`));
  if (jaCarregado) return; // ja esta na lista carregada (o filtro ja mostra)

  // O codigo AMR-XXXXXX nunca fica gravado — so da pra tentar buscar direto
  // no banco se o texto parece ser o id bruto do documento (o codigo AMR e
  // sempre derivado, nao existe como campo pra consultar fora da lista
  // carregada).
  if (codigo.length < 15) {
    toast("Nenhum pedido com esse codigo nos ultimos 300 pedidos carregados. Clique em Atualizar e tente de novo.", "warn");
    return;
  }
  try {
    const snap = await getDoc(doc(db, "pedidos", codigo));
    if (snap.exists()) detalhe({ id: snap.id, ...snap.data() });
    else toast("Nenhum pedido com esse codigo exato (fora dos ultimos 300 carregados).", "warn");
  } catch (_) {
    toast("Nenhum pedido com esse codigo exato (fora dos ultimos 300 carregados).", "warn");
  }
};
document.getElementById("atualizar").onclick = carregar;
document.getElementById("ler-qrcode").onclick = abrirScannerQr;

await carregar();

async function carregar() {
  const lista = document.getElementById("lista");
  lista.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    const [mapa, pedSnap] = await Promise.all([
      mapaDoCatalogo(),
      getDocs(query(collection(db, "pedidos"), orderBy("criadoEm", "desc"), limit(300))),
    ]);
    produtosMap = mapa;
    pedidos = pedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    await buscarCompradores(pedidos);
    renderLista();
  } catch (e) {
    erroCard(lista, e, carregar);
  }
}

// Nome dos compradores: só os uids que esta aba ainda não conhece (cliente
// repetido, ou já visto num "Atualizar" anterior, não gasta leitura de novo).
// Quem não tem perfil fica marcado como null para não ser relido.
async function buscarCompradores(lista) {
  const faltam = [...new Set(lista.map((p) => p.uidComprador).filter(Boolean))]
    .filter((uid) => !(uid in compradores));
  await Promise.all(
    faltam.map(async (uid) => {
      try {
        const s = await getDoc(doc(db, "usuarios", uid));
        compradores[uid] = s.exists() ? s.data() : null;
      } catch (_) {
        // falha de rede: tenta de novo no próximo carregamento
      }
    })
  );
}

// Relê só um pedido (depois de mudar o status) e troca na lista.
async function recarregarPedido(id) {
  try {
    const snap = await getDoc(doc(db, "pedidos", id));
    if (snap.exists()) {
      const novo = { id: snap.id, ...snap.data() };
      const i = pedidos.findIndex((x) => x.id === id);
      if (i >= 0) pedidos[i] = novo; else pedidos.unshift(novo);
    }
    renderLista();
  } catch (_) {
    await carregar();
  }
}

function nomeComprador(uid) {
  const u = compradores[uid];
  return u ? (u.nome || u.email || uid) : (uid ? uid.slice(0, 8) + "…" : "-");
}

function renderLista() {
  let arr = filtroStatus ? pedidos.filter((p) => (p.status || "") === filtroStatus) : pedidos;
  if (filtroCodigo) {
    const alvoMin = filtroCodigo.toLowerCase();
    const alvo = normalizarCodigoRetirada(filtroCodigo);
    arr = arr.filter((p) => p.id.toLowerCase().includes(alvoMin) || (alvo && codigoRetirada(p.id).includes(alvo)));
  }

  document.getElementById("lista").innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th>Codigo</th><th>Data</th><th>Comprador</th><th>Entrega</th><th class="right">Itens</th>
        <th class="right">Total (itens)</th><th>Ref</th><th>Estoque</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${
          arr
            .map((p) => {
              const { subtotal, itensCount } = derivarItensPedido(p, produtosMap);
              return `<tr>
                <td><code title="id: ${escapeHtml(p.id)}">${codigoRetirada(p.id)}</code></td>
                <td>${fmtData(p.criadoEm)}</td>
                <td>${escapeHtml(nomeComprador(p.uidComprador))}</td>
                <td>${p.modoEntrega === "entrega" ? "Entrega" : "Retirada"}</td>
                <td class="right">${itensCount}</td>
                <td class="right">${brl(subtotal)}</td>
                <td>${p.ref ? `<code>${escapeHtml(String(p.ref))}</code>` : "-"}</td>
                <td>${estoqueJaConsumido(p) ? `<span class="tag ativo">baixado</span>` : `<span class="muted">-</span>`}</td>
                <td><span class="tag ${STATUS_TAG[p.status] || ""}">${STATUS_LABEL[p.status] || p.status || "-"}</span></td>
                <td class="right"><button class="btn ghost ver" data-id="${p.id}">Ver</button></td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="10" class="muted">${filtroCodigo || filtroStatus ? "Nenhum pedido encontrado nos ultimos 300 com esse filtro." : "Nenhum pedido."}</td></tr>`
        }
      </tbody>
    </table></div>`;

  document.querySelectorAll(".ver").forEach(
    (b) => (b.onclick = () => detalhe(pedidos.find((p) => p.id === b.dataset.id)))
  );
}

function detalhe(p, statusSugerido) {
  const { linhas, subtotal, temItemSemCatalogo } = derivarItensPedido(p, produtosMap);
  const u = compradores[p.uidComprador];
  const end = p.endereco;

  const c = document.createElement("div");
  c.innerHTML = `
    <p class="muted">Codigo de retirada: <code>${codigoRetirada(p.id)}</code> &middot; <span title="${escapeHtml(p.id)}">id ${escapeHtml(p.id.slice(0, 8))}…</span></p>
    <p class="muted">${fmtData(p.criadoEm)} &middot; ${p.modoEntrega === "entrega" ? "Entrega" : "Retirada"} &middot;
      pagamento ${escapeHtml(p.pagamento?.metodo || "-")} (${escapeHtml(p.pagamento?.status || "-")})
      ${p.pagamento?.parcelas > 1 ? `&middot; ${p.pagamento.parcelas}x` : ""}
      ${p.ref ? `&middot; indicador <code>${escapeHtml(String(p.ref))}</code>` : ""}</p>

    <strong>Comprador</strong>
    <p>${escapeHtml(u?.nome || "-")}${u?.email ? ` &middot; ${escapeHtml(u.email)}` : ""}${u?.telefone ? ` &middot; ${escapeHtml(u.telefone)}` : ""}</p>
    ${
      p.modoEntrega === "entrega" && end
        ? `<p class="muted">${escapeHtml(end.endereco || "")}${end.bairro ? " &middot; " + escapeHtml(end.bairro) : ""}${end.cep ? " &middot; CEP " + escapeHtml(end.cep) : ""}</p>`
        : ""
    }

    <strong style="display:block;margin-top:12px">Itens</strong>
    <table><tbody>
      ${linhas
        .map(
          (l) => `<tr>
            <td>${l.qtd}x ${escapeHtml(l.nome)}${l.modo === "atacado" ? ' <span class="tag">atacado</span>' : ""}${l.semCatalogo ? ' <span class="tag cancelada">sem catalogo</span>' : ""}</td>
            <td class="right">${brl(l.subtotal)}</td>
          </tr>`
        )
        .join("")}
    </tbody></table>
    <div class="totais big"><span>Total (itens, sem frete)</span><span>${brl(subtotal)}</span></div>
    ${temItemSemCatalogo ? `<p style="color:var(--warn)">Algum item nao existe mais no catalogo — o total ignora esses itens.</p>` : ""}

    <strong style="display:block;margin-top:14px">Status</strong>
    <p class="muted">Atual: <strong>${STATUS_LABEL[p.status] || p.status || "-"}</strong>${estoqueJaConsumido(p) ? " &middot; estoque ja baixado" : ""}</p>
    <div class="row" style="align-items:end">
      <div>
        <label>Mudar para</label>
        <select id="novo-status">
          ${STATUS.filter((s) => s !== p.status)
            // Desfazer uma entrega ja confirmada (estorno) e so-admin — nao
            // ofereça a opcao pro vendedor (as rules ja bloqueiam mesmo).
            .filter((s) => !(perfil.role !== "admin" && p.status === "entregue" && s === "cancelado"))
            .map((s) => `<option value="${s}" ${s === statusSugerido ? "selected" : ""}>${STATUS_LABEL[s]}</option>`)
            .join("")}
        </select>
      </div>
      <div style="flex:0 0 auto"><button class="btn" id="aplicar-status">Aplicar</button></div>
    </div>
    <p class="muted" id="status-msg"></p>`;

  const bg = modal({ titulo: `Pedido ${codigoRetirada(p.id)}`, corpo: c, textoCancelar: "Fechar" });

  const sel = c.querySelector("#novo-status");
  const msg = c.querySelector("#status-msg");
  const pintarMsg = () => {
    const novo = sel.value;
    if (CONSOME_ESTOQUE.has(novo) && !estoqueJaConsumido(p))
      msg.textContent = "Ao aplicar, o estoque dos itens sera baixado do catalogo.";
    else if (novo === "cancelado" && estoqueJaConsumido(p))
      msg.textContent = "Ao cancelar, o estoque dos itens sera devolvido ao catalogo.";
    else msg.textContent = "Só muda o status (estoque nao muda).";
  };
  sel.onchange = pintarMsg;
  pintarMsg();

  c.querySelector("#aplicar-status").onclick = async () => {
    const novo = sel.value;
    const consumir = CONSOME_ESTOQUE.has(novo) && !estoqueJaConsumido(p);
    const devolver = novo === "cancelado" && estoqueJaConsumido(p);
    const aviso = consumir
      ? " O estoque dos itens sera baixado."
      : devolver
      ? " O estoque dos itens sera devolvido."
      : "";
    if (!(await confirmar(`Mudar o pedido para "${STATUS_LABEL[novo]}"?${aviso}`))) return;
    try {
      await mudarStatus(p, novo);
      toast("Pedido atualizado.", "ok");
      bg.remove();
      recarregarPedido(p.id);
    } catch (e) {
      toast(e?.message || "Falha ao atualizar o pedido.", "err");
    }
  };
}

// Id deterministico (nao um addDoc aleatorio): permite achar/atualizar o
// espelho em `vendas` de um pedido sem precisar de uma query dentro da
// transacao (o SDK cliente nao suporta query em runTransaction).
function vendaRefDoPedido(pedidoId) {
  return doc(db, "vendas", `site_${pedidoId}`);
}

async function mudarStatus(pedido, novoStatus) {
  const ref = doc(db, "pedidos", pedido.id);
  const vaiConsumir = CONSOME_ESTOQUE.has(novoStatus) && !estoqueJaConsumido(pedido);
  const vaiDevolver = novoStatus === "cancelado" && estoqueJaConsumido(pedido);
  // Confirmar entrega espelha o pedido em `vendas` (canal "site"), pra
  // aparecer na tela de Vendas — sem numero de venda da loja e sem
  // vendedor_uid (nao gera comissao). Desfazer uma entrega ja confirmada
  // (entregue -> cancelado, so admin: ver firestore.rules) cancela esse
  // espelho tambem, senao a venda ficaria "concluida" errado.
  const vendaRef = vendaRefDoPedido(pedido.id);
  const vaiCriarVenda = novoStatus === "entregue";
  const vaiCancelarVenda = novoStatus === "cancelado" && pedido.status === "entregue";

  if (!vaiConsumir && !vaiDevolver && !vaiCriarVenda && !vaiCancelarVenda) {
    // "Cura" estoqueBaixado quando quem baixou foi o site (pagamento
    // aprovado) — deixa o campo confiavel pras telas que o leem direto
    // (lista/detalhe do pedido) e pra uma eventual devolucao ao cancelar.
    const cura = estoqueJaConsumido(pedido) && pedido.estoqueBaixado !== true ? { estoqueBaixado: true } : {};
    await updateDoc(ref, { status: novoStatus, ...cura, atualizadoEm: serverTimestamp() });
    return;
  }

  await runTransaction(db, async (t) => {
    const pSnap = await t.get(ref);
    if (!pSnap.exists()) throw new Error("Pedido nao encontrado.");
    const ped = pSnap.data();
    const vendaSnap = (vaiCriarVenda || vaiCancelarVenda) ? await t.get(vendaRef) : null;

    function aplicarEfeitoVenda() {
      if (vaiCriarVenda && !(vendaSnap && vendaSnap.exists())) {
        const { linhas, subtotal } = derivarItensPedido(ped, produtosMap);
        t.set(vendaRef, {
          canal: "site",
          numero: null,
          pedidoId: pedido.id,
          codigoRetirada: codigoRetirada(pedido.id),
          data: serverTimestamp(),
          criado_em: serverTimestamp(),
          confirmado_por_uid: perfil.id,
          confirmado_por_nome: perfil.nome || "",
          vendedor_uid: null,
          vendedor_nome: null,
          cliente: compradores[ped.uidComprador]?.nome || null,
          itens: linhas.map((l) => ({
            produtoId: l.produtoId,
            nome: l.nome,
            qtd: l.qtd,
            preco_unit: l.precoUnit,
            subtotal: l.subtotal,
          })),
          subtotal,
          desconto: 0,
          total: subtotal,
          // Parcelas escolhidas pelo cliente no Checkout Pro do Mercado Pago
          // (pedido.pagamento.parcelas, gravado pelo webhook do site) — so
          // a contagem, sem valor_parcela: o site nao calcula/guarda juros
          // do parcelamento (isso e feito pelo MP na tela dele), entao nao
          // da pra saber o valor real de cada parcela pra inventar um numero.
          pagamentos: ped.pagamento?.metodo
            ? [{
                forma: ped.pagamento.metodo,
                valor: subtotal,
                ...(ped.pagamento.parcelas > 1 ? { parcelas: ped.pagamento.parcelas } : {}),
              }]
            : [],
          status: "concluida",
        });
      }
      if (vaiCancelarVenda && vendaSnap && vendaSnap.exists() && vendaSnap.data().status !== "cancelada") {
        t.update(vendaRef, { status: "cancelada", cancelada_em: serverTimestamp(), cancelada_por: perfil.id });
      }
    }

    // Reconfirma o estado do estoque no momento da transacao (evita corrida).
    const jaBaixado = estoqueJaConsumido(ped);
    // Cura estoqueBaixado quando quem baixou foi o site (pagamento
    // aprovado) — deixa o campo confiavel pras telas que o leem direto
    // e pra uma eventual devolucao ao cancelar depois.
    const cura = jaBaixado && ped.estoqueBaixado !== true ? { estoqueBaixado: true } : {};
    if (vaiConsumir && jaBaixado) {
      t.update(ref, { status: novoStatus, ...cura, atualizadoEm: serverTimestamp() });
      aplicarEfeitoVenda();
      return;
    }
    if (vaiDevolver && !jaBaixado) {
      t.update(ref, { status: novoStatus, atualizadoEm: serverTimestamp() });
      aplicarEfeitoVenda();
      return;
    }
    if (!vaiConsumir && !vaiDevolver) {
      // Estoque nao muda nessa transicao (ex.: "entregue" chegando depois
      // do estoque ja ter sido baixado antes, num status anterior — pelo
      // site ou por este sistema) — so o efeito em `vendas` importa aqui.
      t.update(ref, { status: novoStatus, ...cura, atualizadoEm: serverTimestamp() });
      aplicarEfeitoVenda();
      return;
    }

    // Agrupa itens por produto — estoque e um so pool (nao ha mais
    // separacao varejo/atacado), entao um pedido com os dois modos do
    // mesmo produto soma tudo numa unica baixa/devolucao.
    const grupos = new Map();
    for (const it of ped.itens || []) {
      const qtd = Math.max(0, Math.trunc(Number(it.quantidade ?? it.qtd) || 0));
      if (!qtd || !it.produtoId) continue;
      const g = grupos.get(it.produtoId) || { produtoId: it.produtoId, qtd: 0 };
      g.qtd += qtd;
      grupos.set(it.produtoId, g);
    }
    const entradas = [...grupos.values()];
    const lidos = [];
    for (const g of entradas) {
      const pr = doc(db, "produtos", g.produtoId);
      lidos.push({ g, pr, snap: await t.get(pr) });
    }

    if (vaiConsumir) {
      for (const { g, snap } of lidos) {
        if (!snap.exists()) throw new Error(`Um item aponta para um produto que nao existe mais (${g.produtoId}).`);
        const atual = Number(snap.data().estoque ?? 0);
        if (atual < g.qtd)
          throw new Error(`Estoque insuficiente de "${snap.data().nome || g.produtoId}": tem ${atual}, precisa ${g.qtd}.`);
      }
      for (const { g, pr, snap } of lidos) {
        const atual = Number(snap.data().estoque ?? 0);
        t.update(pr, { estoque: atual - g.qtd, atualizadoEm: serverTimestamp() });
      }
      t.update(ref, {
        status: novoStatus,
        estoqueBaixado: true,
        estoqueBaixadoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp(),
      });
      aplicarEfeitoVenda();
    } else {
      for (const { g, pr, snap } of lidos) {
        if (!snap.exists()) continue;
        const atual = Number(snap.data().estoque ?? 0);
        t.update(pr, { estoque: atual + g.qtd, atualizadoEm: serverTimestamp() });
      }
      t.update(ref, {
        status: novoStatus,
        estoqueBaixado: false,
        estoqueDevolvidoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp(),
      });
      aplicarEfeitoVenda();
    }
  });
}

// ── Leitor de QR Code (retirada na loja) ─────────────────────────────────
// O QR mostrado ao cliente (comprovante/confirmacao) codifica o codigo de
// retirada "AMR-XXXXXX" (funcao codigoRetirada() no topo do arquivo) — ou
// uma URL do site que aponta pra confirmacao do pedido. Como esse codigo
// nunca fica gravado, a busca abaixo recalcula o codigo de cada pedido ja
// carregado (ultimos 300) e compara. Le pela camera com jsQR (decodificacao
// pura, sem depender de BarcodeDetector do navegador), acha o pedido e abre
// o modal de detalhe ja com "Entregue" pre-selecionado.
async function abrirScannerQr() {
  let jsQR;
  try {
    // O pacote so exporta a funcao como default (CommonJS puro); o jsdelivr
    // anuncia um export nomeado "jsQR" que nao existe de verdade e fica
    // undefined — por isso pegamos o default, nao a desestruturacao.
    jsQR = (await import("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm")).default;
    if (typeof jsQR !== "function") throw new Error("jsQR indisponivel");
  } catch (_) {
    toast("Nao foi possivel carregar o leitor de QR Code (sem internet?).", "err");
    return;
  }

  const c = document.createElement("div");
  c.innerHTML = `
    <p class="muted">Aponte a camera para o QR Code do pedido, mostrado ao cliente na confirmacao de retirada.</p>
    <video id="qr-video" playsinline muted style="width:100%;border-radius:8px;background:#111;display:block"></video>
    <p class="muted" id="qr-status">Iniciando camera...</p>
    <div class="row" style="align-items:end;margin-top:6px">
      <div style="flex:1">
        <label>Ou digite/cole o codigo</label>
        <input id="qr-manual" placeholder="AMR-XXXXXX">
      </div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="qr-buscar">Buscar</button></div>
    </div>`;

  const bg = modal({ titulo: "Ler QR Code do pedido", corpo: c, textoCancelar: "Fechar" });

  const video = c.querySelector("#qr-video");
  const status = c.querySelector("#qr-status");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let stream = null;
  let rafId = null;
  let parado = false;

  function pararCamera() {
    if (parado) return;
    parado = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  bg.addEventListener("click", (e) => { if (e.target === bg) pararCamera(); });
  bg.querySelector(".btn.ghost").addEventListener("click", pararCamera);

  function tick() {
    if (parado) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height);
      if (code && code.data) {
        pararCamera();
        bg.remove();
        processarCodigoLido(code.data);
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    if (parado) { stream.getTracks().forEach((t) => t.stop()); return; } // modal fechado enquanto a camera abria
    status.textContent = "Aponte a camera para o QR Code.";
    rafId = requestAnimationFrame(tick);
  } catch (_) {
    status.textContent = "Nao foi possivel acessar a camera. Use o campo abaixo para digitar o codigo.";
  }

  c.querySelector("#qr-buscar").onclick = () => {
    const v = c.querySelector("#qr-manual").value.trim();
    if (!v) return;
    pararCamera();
    bg.remove();
    processarCodigoLido(v);
  };
}

/** Extrai o texto bruto do codigo de um QR/paste: o "AMR-XXXXXX" puro ou uma URL do site. */
function extrairCodigoPedido(texto) {
  const t = String(texto || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    const porQuery = u.searchParams.get("pedido") || u.searchParams.get("codigo") || u.searchParams.get("id");
    if (porQuery) return porQuery.trim();
    const partes = u.pathname.split("/").filter(Boolean);
    return partes.length ? partes[partes.length - 1].trim() : "";
  } catch (_) {
    return t; // nao e uma URL valida, assume que o proprio texto e o codigo
  }
}

async function processarCodigoLido(textoLido) {
  const bruto = extrairCodigoPedido(textoLido);
  const alvo = normalizarCodigoRetirada(bruto);
  if (!alvo) {
    toast("QR Code lido nao contem um codigo de pedido reconhecivel.", "err");
    return;
  }

  const pedido = pedidos.find((p) => codigoRetirada(p.id) === `AMR-${alvo}`);
  if (!pedido) {
    toast(`Nenhum pedido encontrado com o codigo AMR-${alvo} nos ultimos 300 pedidos carregados. Clique em "Atualizar" e tente de novo.`, "err");
    return;
  }

  if (pedido.status === "entregue") toast("Este pedido ja esta marcado como entregue.", "warn");
  else if (pedido.status === "cancelado") toast("Atencao: este pedido esta cancelado.", "warn");
  else if (pedido.status === "aguardando_pagamento") toast("Atencao: este pedido ainda esta aguardando pagamento.", "warn");

  detalhe(pedido, "entregue");
}
