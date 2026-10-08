// ── Montante do estoque (cálculo puro, sem tela nem banco) ─────────────
// Quanto vale o que está parado em estoque, a preço de venda e a preço de
// custo. Usado no topo da tela Produtos; separado aqui para ter teste
// (tests/montante-estoque.test.mjs).

import { infoPreco, estoquePorModo } from "./produtos-schema.js";
import { round2 } from "./money.js";

/**
 * Preço de venda de uma unidade: varejo (já com desconto ativo); produto
 * vendido só no atacado entra pelo preço de atacado.
 */
export function precoVendaUnitario(produto) {
  const varejo = infoPreco(produto, "varejo").precoFinal;
  return varejo > 0 ? varejo : (Number(produto.precoAtacado) || 0);
}

/** Custo unitário cadastrado, ou null se não houver (0/vazio = sem custo). */
export function custoUnitario(custos, produtoId) {
  const c = Number(custos && custos[produtoId]);
  return Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * Soma o estoque de uma lista de produtos. Estoque zerado/negativo não entra.
 * O lucro potencial considera só produtos COM custo cadastrado (senão um
 * produto sem custo contaria como 100% de lucro).
 *
 * @param {Array<object>} produtos
 * @param {Record<string, number>} custos  produtoId → custo unitário
 * @returns {{ unidades:number, produtosComEstoque:number, valorVenda:number,
 *             valorCusto:number, lucroPotencial:number, semCusto:number }}
 */
export function calcularMontante(produtos, custos = {}) {
  let unidades = 0, produtosComEstoque = 0, venda = 0, custo = 0, vendaComCusto = 0, semCusto = 0;
  for (const p of produtos || []) {
    const q = estoquePorModo(p);
    if (q <= 0) continue;
    produtosComEstoque++;
    unidades += q;
    const v = q * precoVendaUnitario(p);
    venda += v;
    const c = custoUnitario(custos, p.id);
    if (c === null) { semCusto++; continue; }
    custo += q * c;
    vendaComCusto += v;
  }
  const valorCusto = round2(custo);
  return {
    unidades,
    produtosComEstoque,
    valorVenda: round2(venda),
    valorCusto,
    lucroPotencial: round2(vendaComCusto - valorCusto),
    semCusto
  };
}
