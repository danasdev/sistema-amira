// ── Vendas do PDV atribuídas a um indicador ────────────────────────────
// No PDV dá para escolher o indicador da venda (lista de `indicadores`); a
// venda grava `ref` = código do indicador — o MESMO campo que o pedido do
// site grava a partir do link ?ref=. Assim as duas origens somam na
// comissão do indicador (página Indicadores, Painel, filtro de Vendas).
//
// Leitura: só as vendas que TÊM indicador (`ref != ""` — índice automático
// de campo único; venda sem indicador nem tem o campo). Lido uma vez por
// página e filtrado por período em memória.

import { db, collection, getDocs, query, where } from "./db.js";

let pendente = null;

/** Vendas da loja, concluídas, com indicador (todo o histórico). */
export function vendasPdvComIndicador({ fresco = false } = {}) {
  if (fresco || !pendente) {
    pendente = getDocs(query(collection(db, "vendas"), where("ref", "!=", "")))
      .then((s) => s.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((v) => v.canal === "loja" && v.status === "concluida"))
      .catch((e) => { pendente = null; throw e; });
  }
  return pendente;
}

const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);

/** Recorte de um período [inicio, fim) (Date). */
export function noPeriodo(vendas, inicio, fim) {
  const a = inicio.getTime();
  const b = fim.getTime();
  return vendas.filter((v) => {
    const t = millis(v.data);
    return t >= a && t < b;
  });
}
