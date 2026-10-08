import { logout } from "./auth.js";

const NAV = [
  ["dashboard", "Painel", "/dashboard"],
  ["pdv", "PDV", "/pdv"],
  ["caixa", "Caixa", "/caixa"],
  ["gastos", "Gastos", "/gastos", true],
  ["produtos", "Produtos", "/produtos", true],
  ["vendas", "Vendas", "/vendas"],
  ["clientes", "Clientes", "/clientes"],
  ["pedidos", "Pedidos", "/pedidos"],
  ["comissoes", "Comissoes", "/comissoes"],
  ["indicadores", "Indicadores", "/indicadores", true],
  ["usuarios", "Usuarios", "/usuarios", true],
  ["config", "Configuracoes", "/config", true],
];

/** Monta o layout (menu lateral + topo) e devolve o container de conteudo. */
export function initShell({ perfil, active }) {
  const itens = NAV.filter(([, , , soAdm]) => !soAdm || perfil.role === "admin");
  const root = document.getElementById("root");
  root.innerHTML = `
    <div class="app">
      <aside class="side">
        <input type="checkbox" id="nav-toggle" class="nav-toggle">
        <div class="brand">
          <img class="brand-logo" src="/assets/img/amira-logo.png" alt="Amira">
          <small>Sistema interno</small>
          <label for="nav-toggle" class="nav-toggle-btn" aria-label="Abrir menu">
            <span class="icone-abrir">&#9776;</span><span class="icone-fechar">&times;</span>
          </label>
        </div>
        <nav>
          ${itens
            .map(([id, label, href]) => `<a href="${href}" class="${id === active ? "on" : ""}">${label}</a>`)
            .join("")}
        </nav>
        <div class="who">
          <div><strong>${escapeHtml(perfil.nome || "-")}</strong></div>
          <div>${perfil.role === "admin" ? "Administrador" : "Vendedor"}</div>
          <button id="btn-sair">Sair</button>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">${(itens.find(([id]) => id === active) || [, "Sistema Amira"])[1]}</div>
        <div class="content" id="conteudo"></div>
      </div>
    </div>
    <div class="toast-wrap" id="toast-wrap"></div>`;
  document.getElementById("btn-sair").onclick = () => logout();
  return document.getElementById("conteudo");
}

/**
 * Troca um "Carregando..." travado por um cartao de erro com botao de retry.
 * Use no catch de qualquer carregamento de pagina.
 */
export function erroCard(el, e, retry) {
  console.error(e);
  el.innerHTML = `
    <div class="card">
      <strong>Nao foi possivel carregar.</strong>
      <p class="muted">${escapeHtml(e?.message || String(e))}</p>
      <button class="btn ghost" id="__retry" style="margin-top:10px">Tentar de novo</button>
    </div>`;
  const b = el.querySelector("#__retry");
  if (b) b.onclick = () => (typeof retry === "function" ? retry() : location.reload());
}

export function toast(msg, tipo = "") {
  const wrap = document.getElementById("toast-wrap") || document.body;
  const t = document.createElement("div");
  t.className = "toast " + tipo;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/** modal({ titulo, corpo (string|Node), onConfirmar(bodyEl), textoConfirmar, textoCancelar }) */
export function modal({ titulo, corpo, onConfirmar, textoConfirmar = "Salvar", textoCancelar = "Cancelar" }) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  const box = document.createElement("div");
  box.className = "modal";

  const h = document.createElement("h3");
  h.textContent = titulo;
  box.appendChild(h);

  const body = document.createElement("div");
  if (typeof corpo === "string") body.innerHTML = corpo;
  else if (corpo) body.appendChild(corpo);
  box.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "actions";

  const bCancel = document.createElement("button");
  bCancel.className = "btn ghost";
  bCancel.textContent = textoCancelar;
  bCancel.onclick = () => bg.remove();
  actions.appendChild(bCancel);

  if (onConfirmar) {
    const bOk = document.createElement("button");
    bOk.className = "btn";
    bOk.textContent = textoConfirmar;
    bOk.onclick = async () => {
      bOk.disabled = true;
      try {
        const r = await onConfirmar(body);
        if (r !== false) bg.remove();
      } catch (e) {
        toast(e?.message || String(e), "err");
      } finally {
        bOk.disabled = false;
      }
    };
    actions.appendChild(bOk);
  }
  box.appendChild(actions);
  bg.appendChild(box);
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}

export function confirmar(mensagem, { textoConfirmar = "Confirmar" } = {}) {
  return new Promise((resolve) => {
    const bg = modal({
      titulo: "Confirmar",
      corpo: `<p>${escapeHtml(mensagem)}</p>`,
      textoConfirmar,
      onConfirmar: () => resolve(true),
      textoCancelar: "Cancelar",
    });
    bg.querySelector(".btn.ghost").addEventListener("click", () => resolve(false));
    bg.addEventListener("click", (e) => { if (e.target === bg) resolve(false); });
  });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function fmtData(ts) {
  if (!ts) return "-";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d)) return "-";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
