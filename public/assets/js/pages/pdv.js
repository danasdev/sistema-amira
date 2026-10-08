import { requireAuth } from "../auth.js";
import { auth } from "../firebase.js";
import { initShell, toast, confirmar, escapeHtml, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where,
  doc, runTransaction, serverTimestamp, getConfigSistema,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";
import { calcularComissao } from "../regras.js";
import { infoPreco, estoquePorModo } from "../produtos-schema.js";
import { invalidarCatalogo } from "../catalogo-cache.js";
import { FORMAS_JUROS, FORMAS_PARCELAVEIS, parcelasDisponiveis, taxasDe, infoParcela, resumoTotais } from "../juros.js";
import {
  TIPO_POINT, criarClientePoint, novoCobrancaId, quemPagaJuros, marcarAprovada, pagamentoDaMaquininha,
  configPointEfetiva, storageSeguro, desativarTesteLocal, totalDaCobranca,
} from "../point.js";
import { cobrarNaMaquininha } from "../point-ui.js";

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "pdv" });
root.innerHTML = `<div class="card">Carregando...</div>`;

try {
const config = await getConfigSistema();
const formas = config.formas_pagamento?.length
  ? config.formas_pagamento
  : ["dinheiro", "pix", "debito", "credito", "crediario"];
const parc = config.parcelamento || { maximo: 12, minimo_parcela: 0, juros: {} };

// Maquininha Mercado Pago Point (opcional — Configuracoes → Maquininha). Com
// ela ligada, credito/debito ganham o botao "Cobrar na maquininha"; sem ela
// (ou com a API fora do ar) o registro manual de cartao continua igual.
// "Teste local" (Configuracoes → Maquininha) liga a maquininha so NESTE
// navegador, apontando pra API local — sem mexer na config de todo mundo.
const pointCfg = configPointEfetiva(config.point, storageSeguro());
const pointAtivo = pointCfg.ativo === true;
const pointObrigatorio = pointAtivo && pointCfg.obrigatorio === true;
const clientePoint = pointAtivo
  ? criarClientePoint({ apiBase: pointCfg.api_url, obterToken: () => auth.currentUser.getIdToken() })
  : null;

// Caixa e UNICO pra loja toda — nao e "do usuario logado". Qualquer
// vendedor/admin vende contra o mesmo caixa aberto, seja quem for que
// abriu de manha.
const caixaDoc = (await getDocs(query(
  collection(db, "caixa"),
  where("status", "==", "aberto")
))).docs[0];
const caixaAbertoId = caixaDoc ? caixaDoc.id : null;

// produtos vendaveis (schema do site: `ativo`; ordena/filtra em memoria pra
// nao depender de indice composto)
const produtos = (await getDocs(collection(db, "produtos"))).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((p) => p.ativo !== false)
  .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

// preco de venda (varejo, com desconto do site aplicado); estoque e um so
// pool (nao ha mais divisao varejo/atacado)
const precoDe = (p) => infoPreco(p, "varejo").precoFinal;
const estoqueDe = (p) => estoquePorModo(p);

let carrinho = [];
let pagamentos = [];

root.innerHTML = `
  ${pointCfg.testeLocal ? `
  <div class="pt-banner-local" id="pt-banner-local">
    <div><strong>TESTE LOCAL da maquininha</strong> — ligada só neste computador, usando a API em <code>${escapeHtml(pointCfg.api_url)}</code>.
    As vendas feitas aqui são <strong>reais</strong>: gravam no sistema e baixam o estoque.</div>
    <button class="btn ghost" id="pt-local-off">Desativar teste local</button>
  </div>` : ""}
  <div class="grid auto">
    <div class="card">
      <strong>Produtos</strong>
      ${caixaAbertoId ? "" : `<p style="color:var(--warn)">Nenhum caixa aberto &mdash; vendas em dinheiro ficam bloqueadas. <a href="/caixa">Abrir caixa</a></p>`}
      <label style="margin-top:8px">Bipar codigo de barras</label>
      <input id="bipar" placeholder="Encoste o leitor e bipe o produto" autocomplete="off" inputmode="numeric">
      <input id="busca-prod" placeholder="Ou buscar por nome / codigo" style="margin-top:8px">
      <div id="resultados" style="margin-top:10px;max-height:58vh;overflow:auto"></div>
    </div>
    <div class="card">
      <strong>Venda</strong>
      <label>Cliente</label><input id="cliente" placeholder="Nome do cliente" required>
      <label>Contato</label><input id="cliente-contato" placeholder="Telefone / WhatsApp" required>
      <label>Observacoes (opcional)</label>
      <textarea id="observacoes" rows="2" placeholder="Ex.: embrulho pra presente, retirar as 18h..."></textarea>
      <div id="cart" style="margin-top:10px"></div>
      <label>Desconto (R$)</label><input id="desconto" value="0" inputmode="decimal">
      <label>Pagamentos</label>
      <div id="pags"></div>
      <button class="btn ghost" id="add-pag" style="margin-top:6px">+ Forma de pagamento</button>
      <div id="totais" style="margin-top:12px"></div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="finalizar">Finalizar venda</button>
        <button class="btn ghost" id="limpar">Limpar</button>
      </div>
    </div>
  </div>`;

const $ = (s) => root.querySelector(s);

$("#busca-prod").oninput = renderResultados;
$("#bipar").focus();
$("#bipar").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  bipar($("#bipar").value.trim());
  $("#bipar").value = "";
};
$("#desconto").oninput = renderTotais;
$("#add-pag").onclick = () => {
  const { total, pago } = calc();
  pagamentos.push({ forma: formas[0], valor: round2(Math.max(0, total - pago)), parcelas: 1 });
  renderPags();
  renderTotais();
};
$("#limpar").onclick = limpar;
$("#finalizar").onclick = finalizar;
if (pointCfg.testeLocal) {
  $("#pt-local-off").onclick = () => {
    desativarTesteLocal(storageSeguro());
    location.reload();
  };
}

renderResultados();
renderCart();
renderPags();
renderTotais();

// Recarregar/fechar a aba com cobranca na maquininha em curso (ou ja
// aprovada e ainda sem venda) perderia o vinculo: o cliente pagou, o
// sistema nao sabe. O navegador pergunta antes.
window.addEventListener("beforeunload", (e) => {
  if (pagamentos.some((p) => p.point)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function renderResultados() {
  const termo = $("#busca-prod").value.toLowerCase().trim();
  const lista = produtos
    .filter(
      (p) =>
        !termo ||
        (p.nome || "").toLowerCase().includes(termo) ||
        (p.sku || "").toLowerCase().includes(termo) ||
        (p.codigoBarras || "").toLowerCase().includes(termo)
    )
    .slice(0, 40);
  $("#resultados").innerHTML =
    lista
      .map(
        (p) => `<div class="cart-line">
          <div class="nm">
            <div>${escapeHtml(p.nome)}</div>
            <div class="muted">${escapeHtml(p.codigoBarras || p.sku || "")} &middot; ${brl(precoDe(p))} &middot; estoque ${estoqueDe(p)}</div>
          </div>
          <button class="btn sec add" data-id="${p.id}" ${estoqueDe(p) <= 0 ? "disabled" : ""}>Add</button>
        </div>`
      )
      .join("") || `<p class="muted">Nada encontrado.</p>`;
  $("#resultados")
    .querySelectorAll(".add")
    .forEach((b) => (b.onclick = () => addItem(b.dataset.id)));
}

function bipar(codigo) {
  if (!codigo) return;
  const p = produtos.find((x) => (x.codigoBarras || "") === codigo);
  if (!p) return toast(`Codigo ${codigo} nao encontrado (produto inativo?).`, "warn");
  addItem(p.id);
  $("#bipar").focus();
}

function addItem(id) {
  const p = produtos.find((x) => x.id === id);
  const linha = carrinho.find((l) => l.produtoId === id);
  const qAtual = linha ? linha.qtd : 0;
  if (qAtual + 1 > estoqueDe(p)) return toast("Estoque insuficiente.", "warn");
  if (linha) linha.qtd++;
  else
    carrinho.push({
      produtoId: id,
      sku: p.sku || "",
      codigoBarras: p.codigoBarras || "",
      nome: p.nome,
      preco_unit: precoDe(p),
      preco_custo: 0, // catalogo do site nao guarda custo
      qtd: 1,
    });
  renderCart();
  renderTotais();
}

function renderCart() {
  $("#cart").innerHTML =
    carrinho
      .map(
        (l, i) => `<div class="cart-line">
          <div class="nm">${escapeHtml(l.nome)}<div class="muted">${brl(l.preco_unit)}</div></div>
          <input type="number" min="1" value="${l.qtd}" data-i="${i}" class="q">
          <div style="width:84px;text-align:right">${brl(l.preco_unit * l.qtd)}</div>
          <button class="btn ghost rm" data-i="${i}">&times;</button>
        </div>`
      )
      .join("") || `<p class="muted">Carrinho vazio.</p>`;

  $("#cart")
    .querySelectorAll(".q")
    .forEach((inp) => {
      inp.onchange = () => {
        const i = +inp.dataset.i;
        const q = Math.max(1, Math.trunc(+inp.value || 1));
        const p = produtos.find((x) => x.id === carrinho[i].produtoId);
        if (q > estoqueDe(p)) {
          toast("Estoque insuficiente.", "warn");
          inp.value = carrinho[i].qtd;
          return;
        }
        carrinho[i].qtd = q;
        renderCart();
        renderTotais();
      };
    });
  $("#cart")
    .querySelectorAll(".rm")
    .forEach((b) => {
      b.onclick = () => {
        carrinho.splice(+b.dataset.i, 1);
        renderCart();
        renderTotais();
      };
    });
}

function renderPags() {
  $("#pags").innerHTML = pagamentos
    .map((pg, i) => {
      const parcelavel = FORMAS_PARCELAVEIS.has(pg.forma);
      // Com cobranca na maquininha criada (em andamento ou aprovada) a linha
      // fica travada: forma, valor e parcelas ja foram pra maquininha e o
      // que vale agora e o que ela reportar.
      const pt = pg.point;
      const travado = pt ? "disabled" : "";
      let linhaParcelas = "";
      if (parcelavel) {
        // Linha travada nao recalcula as opcoes: as parcelas podem ter sido
        // trocadas pelo cliente na maquininha e nao podem ser "corrigidas".
        const opcoes = pt ? [pg.parcelas || 1] : parcelasDisponiveis(pg.valor, parc);
        const numParcelas = opcoes.includes(pg.parcelas) ? pg.parcelas : 1;
        if (!pt) pg.parcelas = numParcelas;
        linhaParcelas = `
          <div class="cart-line">
            <select data-i="${i}" class="pp" ${travado}>
              ${opcoes
                .map((n) => {
                  const j = taxasDe(config, pg.forma, n).cliente;
                  return `<option value="${n}" ${n === numParcelas ? "selected" : ""}>${n}x${j ? ` (${j}% juros)` : " sem juros"}</option>`;
                })
                .join("")}
            </select>
          </div>`;
      }
      // Mostra a taxa do CLIENTE (somada ao que ele paga) e da LOJA (custo de
      // maquininha/financiamento, descontado do que a loja recebe) pra
      // qualquer forma em FORMAS_JUROS — inclusive debito, que nao parcela
      // mas pode ter taxa a vista configurada em "1". Sem isso o vendedor nao
      // tinha como ver o custo da loja antes de finalizar a venda.
      let linhaTaxa = "";
      // Com cobranca na maquininha o que vale sao os numeros dela (linha
      // "Cobrado na maquininha"), nao a estimativa da tabela.
      if (!pt && FORMAS_JUROS.includes(pg.forma)) {
        const { pctCliente, pctLoja, valorComJuros, custoLoja, valorParcela, parcelas } = infoPagamento(pg);
        const partes = pctCliente || pctLoja
          ? [
              parcelavel && parcelas > 1 ? `${parcelas}x de ${brl(valorParcela)}` : "",
              `cliente: ${pctCliente ? `+${pctCliente}% (total ${brl(valorComJuros)})` : "sem juros"}`,
              `loja: ${pctLoja ? `-${pctLoja}% (${brl(custoLoja)} de custo)` : "sem custo"}`,
            ].filter(Boolean)
          : [`sem taxa configurada pra ${pg.forma}${parcelavel ? ` em ${pg.parcelas}x` : ""} — ajuste em Configuracoes`];
        linhaTaxa = `<p class="muted" style="margin:2px 0 8px;font-size:12px">${partes.join(" &middot; ")}</p>`;
      }
      // Botao/estado da maquininha (so credito e debito, e so com Point ligado).
      let linhaPoint = "";
      if (clientePoint && TIPO_POINT[pg.forma]) {
        if (pt && pt.status === "processed") {
          linhaPoint = `<div class="pt-linha">
            <span class="pt-ok">Cobrado na maquininha</span>
            <span class="muted">${escapeHtml(descricaoAprovada(pg))}</span>
            ${perfil.role === "admin" ? `<button class="btn ghost pt-estornar" data-i="${i}">Estornar</button>` : ""}
          </div>`;
        } else if (pt) {
          linhaPoint = `<div class="pt-linha">
            <span class="pt-pend">Cobranca em andamento na maquininha</span>
            <button class="btn ghost pt-acompanhar" data-i="${i}">Acompanhar</button>
          </div>`;
        } else {
          linhaPoint = `<div class="pt-linha">
            <button class="btn sec pt-cobrar" data-i="${i}" ${pg.valor > 0 ? "" : "disabled"}>Cobrar na maquininha</button>
          </div>`;
        }
      }
      return `<div class="cart-line">
        <select data-i="${i}" class="pf" ${travado}>${formas
          .map((f) => `<option ${f === pg.forma ? "selected" : ""}>${f}</option>`)
          .join("")}</select>
        <input class="pv" data-i="${i}" value="${pg.valor}" inputmode="decimal" style="width:120px" ${travado}>
        <button class="btn ghost prm" data-i="${i}" ${travado}>&times;</button>
      </div>${linhaParcelas}${linhaPoint}${linhaTaxa}`;
    })
    .join("");
  $("#pags")
    .querySelectorAll(".pf")
    .forEach(
      (s) =>
        (s.onchange = () => {
          const pg = pagamentos[+s.dataset.i];
          pg.forma = s.value;
          pg.parcelas = 1;
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pv")
    .forEach(
      (inp) =>
        (inp.onchange = () => {
          pagamentos[+inp.dataset.i].valor = round2(parseNum(inp.value));
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pp")
    .forEach(
      (s) =>
        (s.onchange = () => {
          pagamentos[+s.dataset.i].parcelas = Math.trunc(+s.value) || 1;
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".prm")
    .forEach((b) => {
      b.onclick = () => {
        pagamentos.splice(+b.dataset.i, 1);
        renderPags();
        renderTotais();
      };
    });
  $("#pags").querySelectorAll(".pt-cobrar").forEach((b) => (b.onclick = () => cobrarLinha(pagamentos[+b.dataset.i])));
  $("#pags").querySelectorAll(".pt-acompanhar").forEach((b) => (b.onclick = () => acompanharLinha(pagamentos[+b.dataset.i])));
  $("#pags").querySelectorAll(".pt-estornar").forEach((b) => (b.onclick = () => estornarLinha(pagamentos[+b.dataset.i])));
}

// ── Cobranca na maquininha (Mercado Pago Point) ──────────────────────────
function descricaoAprovada(pg) {
  const pt = pg.point;
  const partes = [];
  if (pt.bandeira) partes.push(pt.bandeira);
  partes.push(FORMAS_PARCELAVEIS.has(pg.forma) && pg.parcelas > 1 ? `${pg.parcelas}x` : "a vista");
  if (pt.valor_pago != null) partes.push(`${brl(pt.valor_pago)} cobrado`);
  if (pt.custo_loja != null) partes.push(`taxa ${brl(pt.custo_loja)}`);
  return partes.join(" · ");
}

// Topo do modal da maquininha: o TOTAL que o cliente vai pagar (em destaque) e,
// embaixo, parcelas, valor original e juros. Com juros pro cliente o total e
// estimativa pela tabela (o percentual real do juros e do Mercado Pago).
function resumoCobranca(pg, parcelas) {
  const taxas = taxasDe(config, pg.forma, parcelas);
  const t = totalDaCobranca({ valor: pg.valor, parcelas, taxas, quemPaga: quemPagaJuros({ tipo: TIPO_POINT[pg.forma], parcelas, taxas }) });
  const partes = [`${pg.forma}${t.parcelas > 1 ? ` em ${t.parcelas}x de ${brl(t.valorParcela)}` : ""}`];
  if (t.juros > 0) partes.push(`valor original ${brl(t.valorOriginal)}`, `juros do cliente ${brl(t.juros)}`);
  else partes.push("sem juros pro cliente");
  return { rotulo: "Total a cobrar do cliente", total: brl(t.total), estimado: t.estimado, detalhe: partes.join(" · ") };
}

// A linha e um objeto (nao um indice): enquanto o modal esta aberto a tela
// fica bloqueada, mas o objeto continua valendo mesmo se a lista mudar.
function aplicarResultadoPoint(pg, r) {
  if (!pagamentos.includes(pg)) return;
  if (r.resultado === "aprovada") {
    marcarAprovada(pg, r.cobranca);
    toast("Pagamento aprovado na maquininha.", "ok");
  } else if (r.resultado === "pendente") {
    // Modal fechado com a cobranca ainda viva: a linha continua travada.
    toast("A cobranca segue na maquininha. Use \"Acompanhar\" na linha do pagamento.", "warn");
  } else {
    delete pg.point; // nada foi cobrado: destrava a linha
    if (r.resultado === "falhou") toast(r.erro?.message || "Nao foi possivel cobrar na maquininha.", "err");
    else if (r.resultado === "inexistente") toast("A cobranca nao chegou a ser criada. Tente de novo.", "warn");
  }
  renderPags();
  renderTotais();
}

async function cobrarLinha(pg) {
  const tipo = pg && TIPO_POINT[pg.forma];
  if (!tipo || pg.point || !(pg.valor > 0)) return;
  const parcelas = tipo === "credit_card" ? Math.max(1, Math.trunc(pg.parcelas) || 1) : 1;
  const cobrancaId = novoCobrancaId();
  pg.point = { cobrancaId, status: "pendente" };
  renderPags();
  renderTotais();
  const r = await cobrarNaMaquininha({
    cliente: clientePoint,
    cobrancaId,
    params: {
      cobrancaId,
      tipo,
      valor: pg.valor,
      parcelas,
      // Quem paga o juros segue a tabela ja configurada: cliente com juros > 0
      // no parcelamento = o cliente paga; senao a loja absorve.
      quemPagaJuros: quemPagaJuros({ tipo, parcelas, taxas: taxasDe(config, pg.forma, parcelas) }),
    },
    resumo: resumoCobranca(pg, parcelas),
  });
  aplicarResultadoPoint(pg, r);
}

async function acompanharLinha(pg) {
  if (!pg?.point || pg.point.status === "processed") return;
  const r = await cobrarNaMaquininha({
    cliente: clientePoint,
    cobrancaId: pg.point.cobrancaId,
    jaCriada: true,
    resumo: resumoCobranca(pg, pg.parcelas || 1),
  });
  aplicarResultadoPoint(pg, r);
}

// Desfazer uma cobranca ja aprovada = estorno total no cartao (so admin: o
// servidor tambem confere).
async function estornarLinha(pg) {
  if (!pg?.point || pg.point.status !== "processed") return;
  const valor = pg.point.valor_pago ?? pg.valor;
  if (!(await confirmar(`Estornar ${brl(valor)} no cartao do cliente? O pagamento e cancelado na maquininha.`, { textoConfirmar: "Estornar" }))) return;
  try {
    await clientePoint.estornar(pg.point.cobrancaId);
    delete pg.point;
    toast("Pagamento estornado.", "ok");
    renderPags();
    renderTotais();
  } catch (e) {
    toast(e?.message || "Falha ao estornar.", "err");
  }
}

function calc() {
  const subtotal = round2(carrinho.reduce((s, l) => s + l.preco_unit * l.qtd, 0));
  const desconto = Math.max(0, round2(parseNum($("#desconto").value)));
  const total = round2(subtotal - desconto);
  // `pago` continua validando contra o valor ORIGINAL (pg.valor) de cada
  // forma — o juros do cliente e um acrescimo no que a maquininha cobra,
  // nao muda quanto do total da venda aquela forma "cobre". Isso mantem a
  // validacao pago===total intacta mesmo com juros de verdade.
  const pago = round2(pagamentos.reduce((s, p) => s + (p.valor || 0), 0));
  return { subtotal, desconto, total, pago };
}

// Info completa de juros pra um pagamento — mesma regra usada em renderPags,
// no preview do total e na hora de gravar a venda: forma parcelavel usa a
// quantidade escolhida, as demais (ex.: debito) usam sempre 1x.
function infoPagamento(p) {
  const parcelas = FORMAS_PARCELAVEIS.has(p.forma) ? Math.max(1, Math.trunc(p.parcelas) || 1) : 1;
  return { parcelas, ...infoParcela(p.valor || 0, parcelas, taxasDe(config, p.forma, parcelas)) };
}

// pg.valor continua sendo o valor ORIGINAL (de tabela) alocado pra essa
// forma — os campos de juros abaixo sao aditivos, pra nao mexer em nada que
// ja le `valor`/`total` da venda (comissao do vendedor, listagem de Vendas,
// dashboard, relatorios). So grava os campos de juros quando ha taxa
// configurada pra essa forma+parcelas (cobre credito/crediario parcelado E
// credito/debito a vista com taxa de maquininha). Usada tanto no preview
// (renderTotais) quanto ao finalizar, pra nunca divergir do que e salvo.
function pagamentosComJuros(pags) {
  return pags.map((p) => {
    // Pago na maquininha: valem os numeros que ela informou (custo real,
    // valor cobrado, parcelas); o que faltar cai na estimativa da tabela.
    if (p.point?.status === "processed") {
      const est = infoPagamento({ ...p, parcelas: p.point.parcelas ?? p.parcelas });
      return pagamentoDaMaquininha(p, est, FORMAS_PARCELAVEIS.has(p.forma));
    }
    const valor = round2(p.valor);
    const base = { forma: p.forma, valor };
    if (!FORMAS_JUROS.includes(p.forma)) return base;
    const { parcelas, pctCliente, pctLoja, valorComJuros, custoLoja, valorLiquido, valorParcela } = infoPagamento(p);
    if (!pctCliente && !pctLoja) return base;
    return {
      ...base,
      ...(FORMAS_PARCELAVEIS.has(p.forma) && parcelas > 1 ? { parcelas, valor_parcela: valorParcela } : {}),
      juros_pct: pctCliente,
      pct_loja: pctLoja,
      valor_com_juros: valorComJuros,
      custo_loja: custoLoja,
      valor_liquido: valorLiquido,
    };
  });
}

function agregarJuros(pagsComJuros) {
  const totalComJuros = round2(pagsComJuros.reduce((s, p) => s + (p.valor_com_juros ?? p.valor), 0));
  const custoLojaTotal = round2(pagsComJuros.reduce((s, p) => s + (p.custo_loja || 0), 0));
  const valorLiquido = round2(pagsComJuros.reduce((s, p) => s + (p.valor_liquido ?? p.valor), 0));
  return { totalComJuros, custoLojaTotal, valorLiquido };
}

// O "Total" grande e o que o cliente PAGA (ja com juros, o que a maquininha
// cobra); logo abaixo o valor original do produto, o custo da loja e o que a
// loja recebe. As contas estao em resumoTotais (juros.js, com testes). O
// "Finalizar" continua validando em valor ORIGINAL (calc), nada mudou nisso.
function renderTotais() {
  const { subtotal, desconto, total, pago } = calc();
  const r = resumoTotais({ total, pago, pagamentos: pagamentosComJuros(pagamentos) });
  const notaTotal = r.mostrarOriginal
    ? ` <small class="totais-nota">a cobrar do cliente${r.estimadoCobranca ? " (estimado)" : ""}</small>`
    : "";
  $("#totais").innerHTML = `
    <div class="totais"><span>Subtotal</span><span>${brl(subtotal)}</span></div>
    <div class="totais"><span>Desconto</span><span>- ${brl(desconto)}</span></div>
    <div class="totais big"><span>Total${notaTotal}</span><span>${brl(r.totalCobrado)}</span></div>
    ${r.mostrarOriginal ? `<div class="totais"><span>Valor original</span><span>${brl(r.valorOriginal)}</span></div>` : ""}
    ${r.mostrarReceber ? `<div class="totais"><span>Custo da loja (maquininha/financiamento)</span><span>- ${brl(r.custoLojaTotal)}</span></div>` : ""}
    ${r.mostrarReceber ? `<div class="totais"><span>Valor a receber${r.estimadoReceber ? " (estimado)" : ""}</span><span>${brl(r.valorAReceber)}</span></div>` : ""}
    <div class="totais"><span>Pago</span><span>${brl(r.pagoCobrado)}</span></div>
    <div class="totais"><span>${r.falta > 0 ? "Falta" : r.falta < 0 ? "Troco" : "&mdash;"}</span><span>${brl(Math.abs(r.falta))}</span></div>`;
}

// Zera a tela (sem perguntar nada). Usado depois de vender e pelo "Limpar".
function resetarVenda() {
  carrinho = [];
  pagamentos = [];
  $("#cliente").value = "";
  $("#cliente-contato").value = "";
  $("#observacoes").value = "";
  $("#desconto").value = "0";
  renderResultados();
  renderCart();
  renderPags();
  renderTotais();
}

// Botao "Limpar". Cobranca na maquininha nao some sozinha: limpar a tela com
// dinheiro ja cobrado no cartao (ou uma cobranca aberta) deixaria um
// pagamento sem venda — entao estorna/cancela antes, ou nao deixa limpar.
async function limpar() {
  const aprovadas = pagamentos.filter((p) => p.point?.status === "processed");
  const pendentes = pagamentos.filter((p) => p.point && p.point.status !== "processed");

  if (aprovadas.length) {
    if (perfil.role !== "admin")
      return toast("Ha pagamento aprovado na maquininha neste carrinho. Finalize a venda ou peca a um administrador para estornar.", "err");
    const total = round2(aprovadas.reduce((s, p) => s + (p.point.valor_pago ?? p.valor), 0));
    const ok = await confirmar(
      `Ha ${aprovadas.length} pagamento(s) ja cobrado(s) na maquininha (${brl(total)}). Limpar vai ESTORNAR no cartao. Continuar?`,
      { textoConfirmar: "Estornar e limpar" }
    );
    if (!ok) return;
    try {
      for (const p of aprovadas) await clientePoint.estornar(p.point.cobrancaId);
    } catch (e) {
      return toast(e?.message || "Falha ao estornar. Nada foi limpo.", "err");
    }
  }

  for (const p of pendentes) {
    try {
      const { cobranca } = await clientePoint.cancelar(p.point.cobrancaId);
      if (cobranca?.status === "processed") {
        // Foi aprovada na maquininha no mesmo instante: o dinheiro JA foi cobrado.
        // Nao limpa (perderia o pagamento): a linha passa a "cobrada".
        marcarAprovada(p, cobranca);
        renderPags();
        renderTotais();
        return toast("Esse pagamento foi aprovado na maquininha antes de cancelar. Finalize a venda ou use Limpar de novo pra estornar.", "warn");
      }
      if (!cobranca?.final) throw new Error("A cobranca ainda esta aberta na maquininha. Cancele por la e tente de novo.");
    } catch (e) {
      // O MP so cancela pela API antes de a cobranca chegar na maquininha; depois, so por la.
      if (e?.codigo === "na_maquininha") {
        return toast("A cobranca esta aberta na maquininha e so da pra cancelar por la: aperte o X na maquininha e clique em Limpar de novo.", "err");
      }
      return toast(e?.message || "Nao foi possivel cancelar a cobranca em andamento.", "err");
    }
  }
  resetarVenda();
}

async function finalizar() {
  if (!carrinho.length) return toast("Carrinho vazio.", "warn");
  if (!$("#cliente").value.trim()) return toast("Informe o nome do cliente.", "err");
  if (!$("#cliente-contato").value.trim()) return toast("Informe o contato do cliente.", "err");
  const { subtotal, desconto, total, pago } = calc();
  if (total < 0) return toast("Desconto maior que o subtotal.", "err");
  if (round2(pago) !== total)
    return toast(`Os valores das formas de pagamento somam ${brl(pago)}, mas o valor original da venda e ${brl(total)}.`, "err");
  const temDinheiro = pagamentos.some((p) => p.forma === "dinheiro" && p.valor > 0);
  if (temDinheiro && !caixaAbertoId)
    return toast("Abra o caixa para receber em dinheiro.", "err");
  if (pagamentos.some((p) => p.point && p.point.status !== "processed"))
    return toast("Ha cobranca em andamento na maquininha. Conclua ou cancele antes de finalizar.", "warn");
  // Com a exigencia ligada, cartao so entra na venda se passou pela maquininha
  // (senao da pra registrar "credito" sem cobrar nada).
  if (pointObrigatorio && pagamentos.some((p) => TIPO_POINT[p.forma] && p.valor > 0 && p.point?.status !== "processed"))
    return toast("Credito e debito precisam ser cobrados na maquininha (botao \"Cobrar na maquininha\").", "err");

  const btn = $("#finalizar");
  btn.disabled = true;
  try {
    const itensVenda = carrinho.map((l) => ({
      produtoId: l.produtoId,
      sku: l.sku,
      codigoBarras: l.codigoBarras,
      nome: l.nome,
      qtd: l.qtd,
      preco_unit: round2(l.preco_unit),
      preco_custo: round2(l.preco_custo || 0),
      subtotal: round2(l.preco_unit * l.qtd),
    }));
    const comissao = calcularComissao({ itens: itensVenda, subtotal, total, config, perfil });
    const cliente = $("#cliente").value.trim() || null;
    const clienteContato = $("#cliente-contato").value.trim() || null;
    const observacoes = $("#observacoes").value.trim() || null;
    const pagamentosSalvos = pagamentosComJuros(pagamentos);
    const { totalComJuros, custoLojaTotal, valorLiquido } = agregarJuros(pagamentosSalvos);

    const numero = await runTransaction(db, async (t) => {
      const contRef = doc(db, "contadores", "vendas");
      const contSnap = await t.get(contRef);
      const prox = (contSnap.exists() ? contSnap.data().ultimo_numero || 0 : 0) + 1;

      const estoques = [];
      for (const it of itensVenda) {
        const ref = doc(db, "produtos", it.produtoId);
        const s = await t.get(ref);
        if (!s.exists()) throw new Error(`Produto ${it.nome} nao encontrado.`);
        const est = s.data().estoque ?? 0;
        if (est < it.qtd) throw new Error(`Estoque insuficiente de ${it.nome} (disponivel: ${est}).`);
        estoques.push({ ref, novo: est - it.qtd });
      }

      t.set(contRef, { ultimo_numero: prox }, { merge: true });
      // Regra do site: um vendedor so pode alterar `estoque`/`atualizadoEm`
      // em produtos — nada mais nesse update.
      estoques.forEach((e) =>
        t.update(e.ref, {
          estoque: e.novo,
          atualizadoEm: serverTimestamp(),
        })
      );
      t.set(doc(collection(db, "vendas")), {
        numero: prox,
        canal: "loja",
        data: serverTimestamp(),
        criado_em: serverTimestamp(),
        vendedor_uid: perfil.id,
        vendedor_nome: perfil.nome || "",
        cliente,
        cliente_contato: clienteContato,
        observacoes,
        itens: itensVenda,
        subtotal,
        desconto,
        total,
        total_com_juros: totalComJuros,
        custo_loja_total: custoLojaTotal,
        valor_liquido: valorLiquido,
        pagamentos: pagamentosSalvos,
        status: "concluida",
        caixa_id: caixaAbertoId || null,
        comissao,
      });
      return prox;
    });

    toast(`Venda #${numero} registrada.`, "ok");
    recibo({ numero, itens: itensVenda, subtotal, desconto, total, totalComJuros, pagamentos: pagamentosSalvos, cliente, clienteContato, observacoes });

    // atualiza estoque em memoria
    itensVenda.forEach((it) => {
      const p = produtos.find((x) => x.id === it.produtoId);
      if (p) p.estoque = estoqueDe(p) - it.qtd;
    });
    invalidarCatalogo(); // estoque mudou: as outras telas desta aba releem
    resetarVenda();
  } catch (e) {
    toast(e?.message || "Falha ao registrar venda.", "err");
  } finally {
    btn.disabled = false;
  }
}

function recibo(v) {
  const w = window.open("", "_blank", "width=360,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Venda #${v.numero}</title>
  <body style="font-family:system-ui;padding:16px;font-size:13px;color:#2b2430">
    <h3 style="margin:0">${escapeHtml(config.nome_loja || "Amira")}</h3>
    <div>Venda #${v.numero} &mdash; ${new Date().toLocaleString("pt-BR")}</div>
    <div>Vendedor: ${escapeHtml(perfil.nome || "")}</div>
    ${v.cliente ? `<div>Cliente: ${escapeHtml(v.cliente)}</div>` : ""}
    ${v.clienteContato ? `<div>Contato: ${escapeHtml(v.clienteContato)}</div>` : ""}
    ${v.observacoes ? `<div>Obs: ${escapeHtml(v.observacoes)}</div>` : ""}
    <hr>
    <table style="width:100%;border-collapse:collapse">
      ${v.itens
        .map(
          (it) =>
            `<tr><td>${it.qtd}x ${escapeHtml(it.nome)}</td><td style="text-align:right">${brl(it.subtotal)}</td></tr>`
        )
        .join("")}
    </table>
    <hr>
    <div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${brl(v.subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Desconto</span><span>- ${brl(v.desconto)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:700"><span>Total</span><span>${brl(v.total)}</span></div>
    ${v.totalComJuros && v.totalComJuros !== v.total ? `<div style="display:flex;justify-content:space-between;font-weight:700"><span>Total com juros</span><span>${brl(v.totalComJuros)}</span></div>` : ""}
    ${v.pagamentos
      .map(
        (p) =>
          `<div style="display:flex;justify-content:space-between"><span>${p.forma}${p.parcelas > 1 ? ` (${p.parcelas}x de ${brl(p.valor_parcela)})` : ""}</span><span>${brl(p.valor_com_juros ?? p.valor)}</span></div>`
      )
      .join("")}
    <hr>
    <div style="text-align:center">Obrigada pela preferencia!</div>
    <button onclick="window.print()" style="margin-top:12px;width:100%;padding:8px">Imprimir</button>
  </body>`);
  w.document.close();
}
} catch (e) {
  erroCard(root, e);
}
