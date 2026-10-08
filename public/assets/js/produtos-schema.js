// ── Schema de produto do SITE (flora-5754a) — helpers ────────────────────
// O sistema interno le/escreve a MESMA colecao `produtos` do site. Estes
// helpers sao a porta unica pros campos do site (precoVarejo, estoque,
// filtros{}, desconto...), portados de frontend/src/pages/services/produtos.js
// e services/iphones.js do repo do site. Mantido pequeno de proposito.
//
// O PRECO ainda tem dois modos (varejo/atacado, campos precoVarejo/
// precoAtacado) — cada um com seu proprio valor. O ESTOQUE, porem, e um so
// (campo `estoque`, compartilhado com o site): nao ha mais separacao de
// estoque entre varejo e atacado (existiu por um tempo como estoqueVarejo/
// estoqueAtacado, hoje descontinuado).

/**
 * Preco de exibicao/venda, aplicando o desconto configurado pelo admin
 * (so no varejo; atacado e o valor exato do painel).
 * @returns {{ precoFinal:number, precoOriginal:number, temDesconto:boolean, percentual:number }}
 */
export function infoPreco(produto, modo = "varejo") {
  if (modo === "atacado") {
    const preco = Number(produto.precoAtacado) || 0;
    return { precoFinal: preco, precoOriginal: preco, temDesconto: false, percentual: 0 };
  }
  const base = Number(produto.precoVarejo) || 0;
  const pct = Number(produto.descontoPercentual) || 0;
  if (produto.descontoAtivo === true && pct >= 1 && pct <= 90) {
    const precoFinal = Math.round(base * (1 - pct / 100) * 100) / 100;
    return { precoFinal, precoOriginal: base, temDesconto: true, percentual: pct };
  }
  return { precoFinal: base, precoOriginal: base, temDesconto: false, percentual: 0 };
}

/**
 * Estoque do produto. Um so pool pra varejo e atacado (nao ha mais
 * `estoqueVarejo`/`estoqueAtacado` separados) — o parametro `modo` fica so
 * por compatibilidade de chamada, nao muda o resultado.
 */
export function estoquePorModo(produto) {
  return Number(produto.estoque) || 0;
}

/**
 * Um pedido do site conta como "venda de verdade" (pago)? O pedido continua
 * sendo rastreado (preparando/enviado/entregue) DEPOIS de pago, entao o
 * status muda com o tempo — o que importa e ter saido de
 * aguardando_pagamento e nao ter sido cancelado.
 */
export function contaComoPago(status) {
  return status !== "aguardando_pagamento" && status !== "cancelado";
}

/** O produto existe na modalidade? (cada modo exige o proprio preco > 0) */
export function disponivelNoModo(produto, modo = "varejo") {
  if (modo === "atacado") return (Number(produto.precoAtacado) || 0) > 0;
  return (Number(produto.precoVarejo) || 0) > 0;
}

/**
 * Opcoes de cada camada que o produto tem, com a ponte do campo legado
 * `categoria` para a camada principal.
 * @returns {{ [camadaSlug:string]: string[] }}
 */
export function filtrosDoProduto(produto, camadaPrincipalSlug = null) {
  const cru = (produto && produto.filtros && typeof produto.filtros === "object") ? produto.filtros : {};
  const norm = {};
  for (const [camada, opcoes] of Object.entries(cru)) {
    norm[camada] = Array.isArray(opcoes) ? opcoes.map(String) : [];
  }
  if (
    camadaPrincipalSlug &&
    (!norm[camadaPrincipalSlug] || norm[camadaPrincipalSlug].length === 0) &&
    produto && produto.categoria
  ) {
    norm[camadaPrincipalSlug] = [String(produto.categoria)];
  }
  return norm;
}

/** O slug (ou nome) pertence a secao de iPhones? (prefixo "iphone") */
export function slugEhIphone(valor) {
  return String(valor || "").toLowerCase().startsWith("iphone");
}

/**
 * O produto e um iPhone? Olha as opcoes do produto na camada principal
 * (ou o campo legado `categoria`).
 */
export function produtoEhIphone(produto, camadaPrincipalSlug = null) {
  const doProduto = filtrosDoProduto(produto, camadaPrincipalSlug);
  const naPrincipal = camadaPrincipalSlug ? (doProduto[camadaPrincipalSlug] || []) : [];
  return naPrincipal.some(slugEhIphone) || slugEhIphone(produto.categoria);
}

/**
 * Deriva itens e subtotal de um pedido do SITE a partir do catalogo atual.
 * O pedido nao guarda valor: cada item e {produtoId, quantidade, modo}. O
 * preco vem de `infoPreco` (varejo com desconto do site, ou atacado). Nao
 * calcula frete (o catalogo do sistema nao tem tabela de frete).
 * @param {object} pedido
 * @param {Map<string,object>} produtosMap  produtoId -> produto
 * @returns {{ linhas:Array, subtotal:number, itensCount:number, temItemSemCatalogo:boolean }}
 */
export function derivarItensPedido(pedido, produtosMap) {
  const linhas = [];
  let subtotal = 0;
  let itensCount = 0;
  let temItemSemCatalogo = false;
  for (const it of pedido.itens || []) {
    const produto = produtosMap.get(it.produtoId);
    const qtd = Math.max(0, Math.trunc(Number(it.quantidade ?? it.qtd) || 0));
    const modo = it.modo === "atacado" ? "atacado" : "varejo";
    const precoUnit = produto ? infoPreco(produto, modo).precoFinal : 0;
    const linhaSub = Math.round(precoUnit * qtd * 100) / 100;
    subtotal += linhaSub;
    itensCount += qtd;
    if (!produto) temItemSemCatalogo = true;
    linhas.push({
      produtoId: it.produtoId,
      nome: produto ? (produto.nome || "(sem nome)") : `(produto removido: ${it.produtoId})`,
      qtd,
      modo,
      precoUnit,
      subtotal: linhaSub,
      semCatalogo: !produto,
    });
  }
  return { linhas, subtotal: Math.round(subtotal * 100) / 100, itensCount, temItemSemCatalogo };
}

/**
 * Base elegivel para comissao de indicador num pedido do SITE. O pedido nao
 * guarda valores: cada item e {produtoId, quantidade, modo}. Deriva o preco
 * de `produtosMap` e ignora itens de iPhone / de slug excluido.
 * @param {object} pedido            documento de `pedidos`
 * @param {Map<string,object>} produtosMap  produtoId -> produto
 * @param {{camadaPrincipalSlug?:string, excluirSlugs?:string[]}} opcoes
 * @returns {{ base:number, itensExcluidos:number }}
 */
export function baseElegivelIndicador(pedido, produtosMap, {
  camadaPrincipalSlug = null,
  excluirSlugs = [],
} = {}) {
  const excl = new Set((excluirSlugs || []).map((s) => String(s).toLowerCase().trim()));
  let base = 0;
  let itensExcluidos = 0;
  for (const it of pedido.itens || []) {
    const produto = produtosMap.get(it.produtoId);
    if (!produto) continue;
    const qtd = Math.max(0, Math.trunc(Number(it.quantidade) || 0));
    const modo = it.modo === "atacado" ? "atacado" : "varejo";

    if (excluidoDaBaseIndicador(produto, camadaPrincipalSlug, excl)) {
      itensExcluidos += qtd;
      continue;
    }
    base += infoPreco(produto, modo).precoFinal * qtd;
  }
  return { base: Math.round(base * 100) / 100, itensExcluidos };
}

// O produto fica de fora da base de comissao de indicador? (iPhone, ou
// marcado com um slug excluido em configuracoes/indicadores)
function excluidoDaBaseIndicador(produto, camadaPrincipalSlug, excl) {
  const slugsProduto = filtrosDoProduto(produto, camadaPrincipalSlug)[camadaPrincipalSlug] || [];
  return produtoEhIphone(produto, camadaPrincipalSlug) ||
    slugsProduto.some((s) => excl.has(String(s).toLowerCase())) ||
    excl.has(String(produto.categoria || "").toLowerCase());
}

/**
 * Base elegivel para comissao de indicador numa venda do PDV (colecao
 * `vendas`, canal "loja", com `ref` = codigo do indicador). Diferente do
 * pedido do site, a venda GUARDA o preco de cada item (preco_unit/subtotal)
 * — vale o que foi cobrado, nao o preco atual do catalogo. Mesma exclusao do
 * site (iPhone / slugs excluidos), olhando o produto no catalogo; item de
 * produto que nao existe mais entra (nao da para saber se era iPhone, e o
 * valor cobrado e conhecido).
 *
 * O desconto da venda (em R$, sobre o total) e repartido na proporcao: a
 * base e a soma dos itens elegiveis x (total / subtotal).
 *
 * @param {object} venda             documento de `vendas`
 * @param {Map<string,object>} produtosMap  produtoId -> produto
 * @param {{camadaPrincipalSlug?:string, excluirSlugs?:string[]}} opcoes
 * @returns {{ base:number, itensExcluidos:number }}
 */
export function baseElegivelIndicadorVenda(venda, produtosMap, {
  camadaPrincipalSlug = null,
  excluirSlugs = [],
} = {}) {
  const excl = new Set((excluirSlugs || []).map((s) => String(s).toLowerCase().trim()));
  let elegivel = 0;
  let somaItens = 0;
  let itensExcluidos = 0;
  for (const it of venda.itens || []) {
    const qtd = Math.max(0, Number(it.qtd) || 0);
    const valor = Number.isFinite(Number(it.subtotal)) ? Number(it.subtotal) : (Number(it.preco_unit) || 0) * qtd;
    somaItens += valor;
    const produto = produtosMap.get(it.produtoId);
    if (produto && excluidoDaBaseIndicador(produto, camadaPrincipalSlug, excl)) {
      itensExcluidos += qtd;
      continue;
    }
    elegivel += valor;
  }
  const subtotal = Number(venda.subtotal) || somaItens;
  const total = Number.isFinite(Number(venda.total)) ? Number(venda.total) : subtotal;
  const fator = subtotal > 0 ? Math.min(1, Math.max(0, total / subtotal)) : 1;
  return { base: Math.round(elegivel * fator * 100) / 100, itensExcluidos };
}
