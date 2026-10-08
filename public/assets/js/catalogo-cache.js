// ── Catálogo em cache por aba (sessionStorage) ─────────────────────────
// Painel, Pedidos, Vendas (indicadores) e Indicadores precisam do catálogo
// só para PREÇO e CLASSIFICAÇÃO (derivar o total de um pedido do site,
// excluir iPhone da base de comissão). Antes cada tela — e cada clique em
// "Apurar"/"Atualizar" — relia a coleção `produtos` inteira: ~200 leituras
// por vez, no MESMO Firestore (e na mesma cota grátis) do site.
//
// Aqui o catálogo é lido uma vez e reaproveitado por MAX_IDADE_MS enquanto
// a aba estiver aberta. Telas que GRAVAM produto ou estoque (Produtos, PDV)
// chamam invalidarCatalogo() depois de gravar.
//
// ⚠️ NÃO use para decidir estoque: quem baixa/devolve estoque relê o
// produto dentro da transação (PDV, Pedidos). E a tela de Produtos lê
// sempre do servidor — é ela que edita.
//
// Timestamps (criadoEm/atualizadoEm) voltam do cache como {seconds,
// nanoseconds} simples, sem os métodos do Firestore — nenhuma tela que usa
// este cache precisa deles.

import { db, collection, getDocs } from "./db.js";

const CHAVE = "sistema-amira:catalogo:v1";
const MAX_IDADE_MS = 10 * 60 * 1000;

let emMemoria = null; // { t, produtos }
let pendente = null;

function lerSessao() {
  try {
    const bruto = sessionStorage.getItem(CHAVE);
    return bruto ? JSON.parse(bruto) : null;
  } catch (_) {
    return null;
  }
}

function gravarSessao(valor) {
  try {
    sessionStorage.setItem(CHAVE, JSON.stringify(valor));
  } catch (_) {
    // sem espaço / storage bloqueado: fica só em memória nesta página
  }
}

// Foto em base64 (legado) não serve para preço nem classificação e
// estouraria o sessionStorage — fica de fora do cache.
function semFotoEmbutida(p) {
  const leve = { ...p };
  if (typeof leve.imagemURL === "string" && leve.imagemURL.startsWith("data:")) leve.imagemURL = "";
  if (Array.isArray(leve.imagensExtras)) leve.imagensExtras = leve.imagensExtras.filter((u) => !String(u).startsWith("data:"));
  return leve;
}

/**
 * Lista de produtos (todos, ativos e inativos).
 * @param {{ fresco?: boolean }} [opcoes]  fresco: ignora o cache e relê
 * @returns {Promise<Array<object>>}
 */
export async function produtosDoCatalogo({ fresco = false } = {}) {
  const agora = Date.now();
  if (!fresco) {
    const atual = emMemoria || lerSessao();
    if (atual && agora - atual.t < MAX_IDADE_MS && Array.isArray(atual.produtos)) {
      emMemoria = atual;
      return atual.produtos;
    }
    if (pendente) return pendente; // duas telas/blocos pedindo ao mesmo tempo: uma leitura só
  }
  pendente = getDocs(collection(db, "produtos"))
    .then((snap) => {
      const produtos = snap.docs.map((d) => semFotoEmbutida({ id: d.id, ...d.data() }));
      emMemoria = { t: Date.now(), produtos };
      gravarSessao(emMemoria);
      return produtos;
    })
    .finally(() => { pendente = null; });
  return pendente;
}

/** Map id → produto, o formato que derivarItensPedido/baseElegivelIndicador usam. */
export async function mapaDoCatalogo(opcoes) {
  const produtos = await produtosDoCatalogo(opcoes);
  return new Map(produtos.map((p) => [p.id, p]));
}

/** Descarta o cache (chamar depois de gravar produto ou estoque). */
export function invalidarCatalogo() {
  emMemoria = null;
  try { sessionStorage.removeItem(CHAVE); } catch (_) { /* ignora */ }
}
