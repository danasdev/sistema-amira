import test from "node:test";
import assert from "node:assert/strict";
import { baseElegivelIndicadorVenda } from "../public/assets/js/produtos-schema.js";

// Catálogo mínimo: camada principal "origem"; "iph" é aparelho (slug iphones).
const catalogo = new Map([
  ["perfume", { id: "perfume", filtros: { origem: ["arabes"] } }],
  ["body", { id: "body", filtros: { origem: ["body-splash"] } }],
  ["iph", { id: "iph", filtros: { origem: ["iphones"] } }],
]);
const opcoes = { camadaPrincipalSlug: "origem", excluirSlugs: [] };
const item = (produtoId, qtd, preco_unit) => ({ produtoId, qtd, preco_unit, subtotal: qtd * preco_unit });

test("vale o valor COBRADO na venda (não o preço atual do catálogo)", () => {
  const venda = { itens: [item("perfume", 2, 150)], subtotal: 300, total: 300 };
  assert.deepEqual(baseElegivelIndicadorVenda(venda, catalogo, opcoes), { base: 300, itensExcluidos: 0 });
});

test("iPhone fica fora da base, igual ao site", () => {
  const venda = { itens: [item("perfume", 1, 200), item("iph", 1, 4000)], subtotal: 4200, total: 4200 };
  const r = baseElegivelIndicadorVenda(venda, catalogo, opcoes);
  assert.equal(r.base, 200);
  assert.equal(r.itensExcluidos, 1);
});

test("slug excluído na configuração também fica fora", () => {
  const venda = { itens: [item("perfume", 1, 100), item("body", 2, 50)], subtotal: 200, total: 200 };
  const r = baseElegivelIndicadorVenda(venda, catalogo, { ...opcoes, excluirSlugs: ["Body-Splash"] });
  assert.equal(r.base, 100);
  assert.equal(r.itensExcluidos, 2);
});

test("desconto da venda é repartido na proporção", () => {
  // subtotal 400, desconto 40 (10%) -> base elegível 300 vira 270
  const venda = { itens: [item("perfume", 1, 300), item("iph", 1, 100)], subtotal: 400, desconto: 40, total: 360 };
  assert.equal(baseElegivelIndicadorVenda(venda, catalogo, opcoes).base, 270);
});

test("produto que saiu do catálogo entra pelo valor cobrado", () => {
  const venda = { itens: [item("apagado", 1, 80)], subtotal: 80, total: 80 };
  assert.equal(baseElegivelIndicadorVenda(venda, catalogo, opcoes).base, 80);
});

test("venda sem itens dá base zero", () => {
  assert.deepEqual(baseElegivelIndicadorVenda({}, catalogo, opcoes), { base: 0, itensExcluidos: 0 });
});
