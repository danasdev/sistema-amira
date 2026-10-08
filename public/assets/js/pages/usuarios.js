import { requireAuth, criarVendedor } from "../auth.js";
import { initShell, toast, modal, escapeHtml } from "../ui.js";
import { db, collection, getDocs, query, where, doc, updateDoc } from "../db.js";
import { parseNum } from "../money.js";

const BASES = ["total", "total_sem_desconto", "margem"];

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "usuarios" });

carregar();

async function carregar() {
  root.innerHTML = `<div class="card">Carregando...</div>`;
  // A colecao `usuarios` e compartilhada com o site (clientes da loja tem
  // role "cliente"). Aqui so interessa a equipe — o filtro vai na consulta,
  // senao cada abertura da tela lia TODOS os clientes da loja. Ordena em
  // memoria (orderBy("nome") junto exigiria indice composto).
  const us = (await getDocs(query(collection(db, "usuarios"), where("role", "in", ["admin", "vendedor"])))).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

  root.innerHTML = `
    <div class="card"><button class="btn" id="novo">+ Novo vendedor</button></div>
    <div class="card">
      <div class="tabela-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Comissao</th><th>Ativo</th><th></th></tr></thead>
        <tbody>
          ${us
            .map(
              (u) => `<tr>
                <td>${escapeHtml(u.nome || "-")}</td>
                <td>${escapeHtml(u.email || "")}</td>
                <td>${u.role === "admin" ? "Administrador" : u.role === "vendedor" ? "Vendedor" : escapeHtml(u.role || "-")}</td>
                <td>${
                  u.comissao?.percentual != null
                    ? `${u.comissao.percentual}% (${u.comissao.base || "padrao"})`
                    : `<span class="muted">padrao da loja</span>`
                }</td>
                <td><span class="tag ${u.ativo === false ? "inativo" : "ativo"}">${u.ativo === false ? "inativo" : "ativo"}</span></td>
                <td class="right">${
                  u.id === perfil.id ? "" : `<button class="btn ghost edit" data-id="${u.id}">Editar</button>`
                }</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table></div>
    </div>`;

  document.getElementById("novo").onclick = novo;
  document.querySelectorAll(".edit").forEach(
    (b) => (b.onclick = () => editar(us.find((u) => u.id === b.dataset.id)))
  );
}

function campoComissao(u) {
  return `
    <div class="row">
      <div><label>Base da comissao</label>
        <select id="b">
          <option value="">padrao da loja</option>
          ${BASES.map((x) => `<option ${x === u?.comissao?.base ? "selected" : ""}>${x}</option>`).join("")}
        </select>
      </div>
      <div><label>Percentual (%)</label><input id="p" value="${u?.comissao?.percentual ?? ""}"></div>
    </div>`;
}

function lerComissao(c) {
  const comissao = {};
  if (c.querySelector("#b").value) comissao.base = c.querySelector("#b").value;
  if (c.querySelector("#p").value !== "") comissao.percentual = parseNum(c.querySelector("#p").value);
  return comissao;
}

function novo() {
  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="n">
    <label>E-mail</label><input id="e" type="email">
    <label>Senha provisoria (min. 6)</label><input id="s" type="text" value="amira123">
    ${campoComissao(null)}`;
  modal({
    titulo: "Novo vendedor",
    corpo: c,
    textoConfirmar: "Criar",
    onConfirmar: async () => {
      const nome = c.querySelector("#n").value.trim();
      const email = c.querySelector("#e").value.trim();
      const senha = c.querySelector("#s").value;
      if (!nome || !email || senha.length < 6) {
        toast("Preencha nome, e-mail e senha (min. 6).", "err");
        return false;
      }
      try {
        await criarVendedor({ nome, email, senha, comissao: lerComissao(c) });
        toast("Vendedor criado.", "ok");
        carregar();
      } catch (e) {
        toast(
          e?.code === "auth/email-already-in-use"
            ? "E-mail ja cadastrado."
            : e?.message || "Erro ao criar vendedor.",
          "err"
        );
        return false;
      }
    },
  });
}

function editar(u) {
  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="n" value="${escapeHtml(u.nome || "")}">
    ${campoComissao(u)}
    <label style="text-transform:none"><input type="checkbox" id="a" ${u.ativo === false ? "" : "checked"} style="width:auto"> Usuario ativo</label>`;
  modal({
    titulo: `Editar ${u.nome || ""}`,
    corpo: c,
    onConfirmar: async () => {
      await updateDoc(doc(db, "usuarios", u.id), {
        nome: c.querySelector("#n").value.trim(),
        comissao: lerComissao(c),
        ativo: c.querySelector("#a").checked,
      });
      toast("Usuario atualizado.", "ok");
      carregar();
    },
  });
}
