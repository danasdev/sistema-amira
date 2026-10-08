import test from "node:test";
import assert from "node:assert/strict";
import { calcularMontante, precoVendaUnitario, custoUnitario } from "../public/assets/js/montante-estoque.js";

const produto = (id, campos) => ({ id, ativo: true, ...campos });

test("soma unidades e valores a preço de venda e de custo", () => {
  const lista = [
    produto("a", { estoque: 3, precoVarejo: 100 }),
    produto("b", { estoque: 2, precoVarejo: 50 }),
  ];
  const m = calcularMontante(lista, { a: 40, b: 20 });
  assert.equal(m.unidades, 5);
  assert.equal(m.produtosComEstoque, 2);
  assert.equal(m.valorVenda, 400);   // 3*100 + 2*50
  assert.equal(m.valorCusto, 160);   // 3*40 + 2*20
  assert.equal(m.lucroPotencial, 240);
  assert.equal(m.semCusto, 0);
});

test("estoque zerado ou negativo não entra", () => {
  const m = calcularMontante([
    produto("a", { estoque: 0, precoVarejo: 100 }),
    produto("b", { estoque: -2, precoVarejo: 100 }),
    produto("c", { estoque: 1, precoVarejo: 10 }),
  ], {});
  assert.equal(m.unidades, 1);
  assert.equal(m.produtosComEstoque, 1);
  assert.equal(m.valorVenda, 10);
});

test("produto sem custo conta na venda, não no custo nem no lucro", () => {
  const m = calcularMontante([
    produto("a", { estoque: 2, precoVarejo: 100 }),
    produto("b", { estoque: 1, precoVarejo: 80 }), // sem custo
  ], { a: 30 });
  assert.equal(m.valorVenda, 280);
  assert.equal(m.valorCusto, 60);
  assert.equal(m.lucroPotencial, 140); // só o "a": 200 - 60
  assert.equal(m.semCusto, 1);
});

test("preço de venda usa o desconto ativo e cai no atacado quando não há varejo", () => {
  assert.equal(precoVendaUnitario({ precoVarejo: 100, descontoAtivo: true, descontoPercentual: 10 }), 90);
  assert.equal(precoVendaUnitario({ precoVarejo: 0, precoAtacado: 35 }), 35);
  assert.equal(precoVendaUnitario({}), 0);
});

test("custo vazio, zero ou inválido vale como 'sem custo'", () => {
  assert.equal(custoUnitario({ a: 0 }, "a"), null);
  assert.equal(custoUnitario({ a: "abc" }, "a"), null);
  assert.equal(custoUnitario({}, "a"), null);
  assert.equal(custoUnitario({ a: 12.5 }, "a"), 12.5);
});

test("arredonda para centavos", () => {
  const m = calcularMontante([produto("a", { estoque: 3, precoVarejo: 0.1 })], { a: 0.07 });
  assert.equal(m.valorVenda, 0.3);
  assert.equal(m.valorCusto, 0.21);
});
