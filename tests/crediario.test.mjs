import test from "node:test";
import assert from "node:assert/strict";
import { valorNoCaixa, dividaDoCrediario, saldoCliente, resumoCaixa } from "../public/assets/js/crediario.js";

test("credito parcelado entra no caixa so com uma parcela (valor original)", () => {
  assert.equal(valorNoCaixa({ forma: "credito", valor: 300, parcelas: 3, valor_com_juros: 330 }), 100);
  assert.equal(valorNoCaixa({ forma: "credito", valor: 100, parcelas: 3 }), 33.33);
});

test("credito a vista, debito, pix e dinheiro entram inteiros", () => {
  assert.equal(valorNoCaixa({ forma: "credito", valor: 250 }), 250);
  assert.equal(valorNoCaixa({ forma: "debito", valor: 80 }), 80);
  assert.equal(valorNoCaixa({ forma: "dinheiro", valor: 50.5 }), 50.5);
});

test("linha de crediario nao entra no caixa (o pago na hora vem de crediario_pagamentos)", () => {
  assert.equal(valorNoCaixa({ forma: "crediario", valor: 500, entrada: 100 }), 0);
});

test("divida do crediario usa o valor com juros quando ha", () => {
  assert.equal(dividaDoCrediario({ forma: "crediario", valor: 200, valor_com_juros: 220 }), 220);
  assert.equal(dividaDoCrediario({ forma: "crediario", valor: 200 }), 200);
  assert.equal(dividaDoCrediario({ forma: "pix", valor: 200 }), 0);
});

test("saldo do cliente", () => {
  assert.deepEqual(saldoCliente({ total_compras: 500, total_pago: 120.1 }), { compras: 500, pago: 120.1, restante: 379.9 });
  assert.deepEqual(saldoCliente({}), { compras: 0, pago: 0, restante: 0 });
});

test("resumo do caixa: parcela do credito + recebimentos do crediario", () => {
  const vendas = [
    { total: 300, pagamentos: [{ forma: "credito", valor: 300, parcelas: 3 }] },
    { total: 100, pagamentos: [{ forma: "dinheiro", valor: 40 }, { forma: "pix", valor: 60 }] },
    { total: 500, pagamentos: [{ forma: "crediario", valor: 500, entrada: 100 }] },
  ];
  const recebimentos = [
    { forma: "dinheiro", valor: 100 }, // entrada da venda acima
    { forma: "pix", valor: 50 }, // lancamento em Clientes
  ];
  const r = resumoCaixa({ vendas, recebimentos });
  assert.deepEqual(r.porForma, { credito: 100, dinheiro: 40, pix: 60 });
  assert.deepEqual(r.recebidoCrediario, { dinheiro: 100, pix: 50 });
  assert.equal(r.totalRecebido, 350);
  assert.equal(r.creditoAReceber, 200);
  assert.equal(r.crediarioFiado, 400);
  assert.equal(r.vendidoTabela, 900);
});
