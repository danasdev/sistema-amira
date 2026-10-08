// ── Preço de custo dos produtos (só admin) ─────────────────────────────
// O custo NÃO fica no documento do produto: `produtos` é público (o site lê
// sem login), então qualquer pessoa leria o custo pela API. Ele mora num
// documento só, fechado para quem não é admin (firestore.rules):
//
//   custos/produtos  { valores: { [produtoId]: number }, atualizadoEm }
//
// Um documento único = UMA leitura traz o custo do catálogo inteiro (o
// montante do estoque na tela de Produtos sai daí). ~200 produtos cabem com
// folga no limite de 1 MB do documento.

import { db, doc, getDoc, setDoc, updateDoc, deleteField, serverTimestamp } from "./db.js";

const REF = () => doc(db, "custos", "produtos");

/** @returns {Promise<Record<string, number>>} produtoId → custo unitário */
export async function lerCustos() {
  const snap = await getDoc(REF());
  const valores = snap.exists() ? snap.data().valores : null;
  return valores && typeof valores === "object" ? { ...valores } : {};
}

/**
 * Grava (ou apaga, com custo vazio/0) o custo de um produto. Merge: não
 * mexe no custo dos outros produtos.
 * @param {string} produtoId
 * @param {number|null} custo
 */
export async function salvarCusto(produtoId, custo) {
  const valor = Number(custo);
  if (!Number.isFinite(valor) || valor <= 0) return removerCusto(produtoId);
  await setDoc(REF(), { valores: { [produtoId]: Math.round(valor * 100) / 100 }, atualizadoEm: serverTimestamp() }, { merge: true });
}

/** Tira o custo de um produto (ex.: produto excluído). */
export async function removerCusto(produtoId) {
  try {
    await updateDoc(REF(), { [`valores.${produtoId}`]: deleteField(), atualizadoEm: serverTimestamp() });
  } catch (e) {
    if (e?.code !== "not-found") throw e; // documento ainda não existe: nada a apagar
  }
}
