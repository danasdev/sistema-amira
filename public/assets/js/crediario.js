import { round2 } from "./money.js";

// ── Crediario e parcelado: o que entra no caixa ─────────────────────────
// Venda parcelada NAO entra inteira no caixa:
//   credito parcelado -> entra so UMA parcela (valor original / parcelas);
//                        o resto chega nos meses seguintes pela operadora.
//   crediario         -> entra so o que o cliente pagou na hora ("valor de
//                        parcela paga" no PDV). O resto vira divida no perfil
//                        do cliente (pagina Clientes). Esse valor pago e um
//                        doc em `crediario_pagamentos` (origem "pdv"), igual
//                        aos pagamentos lancados depois em Clientes (origem
//                        "lancamento") — o caixa soma esses docs pelo
//                        `caixa_id`, nao a linha "crediario" da venda.
// Tudo em valor ORIGINAL (de tabela), como o resto do caixa — juros do
// cliente ficam de fora, igual ja era.

/** Quanto de UMA linha de pagamento da venda entra no caixa da sessao. */
export function valorNoCaixa(p) {
  const valor = Number(p?.valor) || 0;
  if (p?.forma === "crediario") return 0;
  const parcelas = Math.max(1, Math.trunc(p?.parcelas) || 1);
  if (p?.forma === "credito" && parcelas > 1) return round2(valor / parcelas);
  return round2(valor);
}

/** Divida que uma linha de crediario gera (com o juros do cliente, se houver). */
export function dividaDoCrediario(p) {
  if (p?.forma !== "crediario") return 0;
  return round2(p.valor_com_juros ?? p.valor ?? 0);
}

/** Compras, pago e restante de um cliente (campos acumulados no doc). */
export function saldoCliente(c) {
  const compras = round2(c?.total_compras || 0);
  const pago = round2(c?.total_pago || 0);
  return { compras, pago, restante: round2(compras - pago) };
}

/**
 * Numeros do caixa aberto a partir das vendas concluidas e dos recebimentos
 * de crediario (docs `crediario_pagamentos` validos) da sessao.
 * @returns {{porForma, recebidoCrediario, totalRecebido, creditoAReceber, crediarioFiado, vendidoTabela}}
 */
export function resumoCaixa({ vendas = [], recebimentos = [] }) {
  const porForma = {};
  let creditoAReceber = 0;
  let crediarioFiado = 0;
  let vendidoTabela = 0;
  for (const v of vendas) {
    vendidoTabela += Number(v.total) || 0;
    for (const p of v.pagamentos || []) {
      const noCaixa = valorNoCaixa(p);
      if (p.forma !== "crediario") porForma[p.forma] = round2((porForma[p.forma] || 0) + noCaixa);
      if (p.forma === "credito") creditoAReceber += (Number(p.valor) || 0) - noCaixa;
      // Vendas antigas (antes do perfil de cliente) nao tem `entrada`: o
      // crediario delas inteiro conta como fiado aqui.
      if (p.forma === "crediario") crediarioFiado += (Number(p.valor) || 0) - (Number(p.entrada) || 0);
    }
  }
  const recebidoCrediario = {};
  for (const r of recebimentos) {
    recebidoCrediario[r.forma] = round2((recebidoCrediario[r.forma] || 0) + (Number(r.valor) || 0));
  }
  const soma = (o) => Object.values(o).reduce((s, v) => s + v, 0);
  return {
    porForma,
    recebidoCrediario,
    totalRecebido: round2(soma(porForma) + soma(recebidoCrediario)),
    creditoAReceber: round2(creditoAReceber),
    crediarioFiado: round2(crediarioFiado),
    vendidoTabela: round2(vendidoTabela),
  };
}
