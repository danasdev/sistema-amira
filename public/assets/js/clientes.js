// ── Clientes do crediario ───────────────────────────────────────────────
// Colecao `clientes` (so do sistema interno; NAO e o cliente do site, que
// vive em `usuarios`). Cada doc acumula a divida do crediario:
//   total_compras = soma do que foi vendido no crediario (com juros, se houver)
//   total_pago    = soma dos pagamentos validos (`crediario_pagamentos`)
// Os dois sao mexidos SEMPRE junto com a venda/pagamento, na mesma
// transacao, com increment() — restante = total_compras - total_pago.
// Usado no PDV (selecionar / criar na hora) e na pagina Clientes.

import { toast, modal, escapeHtml } from "./ui.js";
import { db, collection, getDocs, doc, addDoc, updateDoc, serverTimestamp } from "./db.js";

export async function listarClientes() {
  const snap = await getDocs(collection(db, "clientes"));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
}

/**
 * Modal de criar/editar cliente. `onSalvo(cliente)` recebe o cliente com id
 * (pra quem chamou atualizar a lista sem reler a colecao).
 */
export function editarCliente(c, { perfil, onSalvo } = {}) {
  const corpo = document.createElement("div");
  corpo.innerHTML = `
    <label for="c-nome">Nome completo</label><input id="c-nome" value="${escapeHtml(c?.nome || "")}" autocomplete="off">
    <label for="c-contato">Telefone / WhatsApp</label><input id="c-contato" value="${escapeHtml(c?.contato || "")}" inputmode="tel" placeholder="(11) 90000-0000" autocomplete="off">
    <details class="mais" ${c?.cpf || c?.endereco || c?.observacoes ? "open" : ""}>
      <summary>CPF, endereço e observações <span class="opc">(opcional)</span></summary>
      <label for="c-cpf">CPF</label><input id="c-cpf" value="${escapeHtml(c?.cpf || "")}" inputmode="numeric" placeholder="000.000.000-00">
      <label for="c-endereco">Endereço</label><input id="c-endereco" value="${escapeHtml(c?.endereco || "")}">
      <label for="c-obs">Observações</label>
      <textarea id="c-obs" rows="3" placeholder="Ex.: paga todo dia 10">${escapeHtml(c?.observacoes || "")}</textarea>
    </details>`;
  modal({
    titulo: c ? "Editar cliente" : "Novo cliente",
    textoConfirmar: c ? "Salvar" : "Cadastrar cliente",
    corpo,
    onConfirmar: async () => {
      const dados = {
        nome: corpo.querySelector("#c-nome").value.trim(),
        contato: corpo.querySelector("#c-contato").value.trim(),
        cpf: corpo.querySelector("#c-cpf").value.trim(),
        endereco: corpo.querySelector("#c-endereco").value.trim(),
        observacoes: corpo.querySelector("#c-obs").value.trim(),
      };
      if (!dados.nome || !dados.contato) {
        toast("Preencha o nome e o telefone do cliente.", "err");
        return false;
      }
      if (c) {
        await updateDoc(doc(db, "clientes", c.id), { ...dados, atualizado_em: serverTimestamp() });
        Object.assign(c, dados);
        toast("Cliente salvo.", "ok");
        onSalvo?.(c);
      } else {
        const novo = {
          ...dados,
          total_compras: 0,
          total_pago: 0,
          criado_em: serverTimestamp(),
          atualizado_em: serverTimestamp(),
          criado_por_uid: perfil.id,
          criado_por_nome: perfil.nome || "",
        };
        const ref = await addDoc(collection(db, "clientes"), novo);
        toast("Cliente cadastrado.", "ok");
        onSalvo?.({ id: ref.id, ...novo });
      }
    },
  });
}
