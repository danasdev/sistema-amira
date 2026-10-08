import { logout } from "./auth.js";

import { icone } from "./icons.js";

// [id, rotulo, href, soAdmin, icone, descricao, grupo]
const NAV = [
  ["dashboard", "Painel", "/dashboard", false, "painel", "Resumo do dia e do mês", "Loja"],
  ["pdv", "PDV", "/pdv", false, "pdv", "Registrar uma venda no balcão", "Loja"],
  ["caixa", "Caixa", "/caixa", false, "caixa", "Abrir, conferir e fechar o caixa do dia", "Loja"],
  ["vendas", "Vendas", "/vendas", false, "vendas", "Histórico de vendas da loja e do site", "Loja"],
  ["clientes", "Clientes", "/clientes", false, "clientes", "Crediário: compras, dívidas e pagamentos", "Loja"],
  ["pedidos", "Pedidos", "/pedidos", false, "pedidos", "Pedidos feitos no site", "Loja"],
  ["comissoes", "Comissões", "/comissoes", false, "comissoes", "Comissão dos vendedores por período", "Gestão"],
  ["produtos", "Produtos", "/produtos", true, "produtos", "Catálogo, preços e estoque", "Gestão"],
  ["gastos", "Gastos", "/gastos", true, "gastos", "Despesas da loja", "Gestão"],
  ["indicadores", "Indicadores", "/indicadores", true, "indicadores", "Divulgadores e comissão por link", "Gestão"],
  ["usuarios", "Usuários", "/usuarios", true, "usuarios", "Contas da equipe", "Administração"],
  ["config", "Configurações", "/config", true, "config", "Loja, pagamentos, juros e maquininha", "Administração"],
];

const iniciais = (nome) =>
  String(nome || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";

/**
 * Monta o layout (menu lateral + topo) e devolve o container de conteudo.
 * `largo: true` libera a largura toda (PDV).
 */
export function initShell({ perfil, active, largo = false }) {
  const itens = NAV.filter(([, , , soAdm]) => !soAdm || perfil.role === "admin");
  const atual = itens.find(([id]) => id === active);
  let grupoAnterior = null;
  const links = itens
    .map(([id, label, href, , ic, , grupo]) => {
      const titulo = grupo !== grupoAnterior ? `<div class="nav-grupo">${grupo}</div>` : "";
      grupoAnterior = grupo;
      return `${titulo}<a href="${href}" class="${id === active ? "on" : ""}" ${id === active ? 'aria-current="page"' : ""}>${icone(ic)}<span>${label}</span></a>`;
    })
    .join("");
  const hoje = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const root = document.getElementById("root");
  root.innerHTML = `
    <div class="app">
      <aside class="side">
        <input type="checkbox" id="nav-toggle" class="nav-toggle">
        <div class="brand">
          <span class="brand-logo" role="img" aria-label="Amira"></span>
          <small>Sistema interno</small>
          <label for="nav-toggle" class="nav-toggle-btn" aria-label="Abrir menu">
            <span class="icone-abrir">${icone("menu", { tam: 22 })}</span><span class="icone-fechar">${icone("fechar", { tam: 22 })}</span>
          </label>
        </div>
        <nav aria-label="Menu principal">${links}</nav>
        <div class="who">
          <div class="avatar" aria-hidden="true">${escapeHtml(iniciais(perfil.nome))}</div>
          <div class="quem">
            <strong>${escapeHtml(perfil.nome || "-")}</strong>
            ${perfil.role === "admin" ? "Administrador" : "Vendedor"}
          </div>
          <button id="btn-sair" title="Sair" aria-label="Sair do sistema">${icone("sair", { tam: 16 })}</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          ${atual ? `<div class="tb-ic">${icone(atual[4], { tam: 20 })}</div>` : ""}
          <div>
            <h1>${atual ? atual[1] : "Sistema Amira"}</h1>
            ${atual ? `<div class="tb-sub">${atual[5]}</div>` : ""}
          </div>
          <div class="tb-data">${hoje}</div>
        </header>
        <main class="content ${largo ? "largo" : ""}" id="conteudo"></main>
      </div>
    </div>
    <div class="toast-wrap" id="toast-wrap" role="status" aria-live="polite"></div>`;
  document.getElementById("btn-sair").onclick = () => logout();
  // Campo de dinheiro seleciona o valor ao focar: digitar ja substitui o "0,00".
  document.addEventListener("focusin", (e) => {
    if (e.target.matches?.(".campo-rs input")) setTimeout(() => e.target.select(), 0);
  });
  return document.getElementById("conteudo");
}

/** Titulo de card com icone: tituloCard("sacola", "Sacola", "<button>..") */
export function tituloCard(ic, texto, acao = "") {
  return `<div class="card-titulo">${icone(ic, { tam: 20 })}<span>${texto}</span>${acao ? `<span class="acao">${acao}</span>` : ""}</div>`;
}

/** Estado vazio que ensina: icone + frase principal + dica. */
export function vazio(ic, titulo, dica = "") {
  return `<div class="vazio">${icone(ic, { tam: 36 })}<strong>${titulo}</strong>${dica ? `<div>${dica}</div>` : ""}</div>`;
}

/**
 * Troca um "Carregando..." travado por um cartao de erro com botao de retry.
 * Use no catch de qualquer carregamento de pagina.
 */
export function erroCard(el, e, retry) {
  console.error(e);
  el.innerHTML = `
    <div class="card">
      <div class="vazio">
        ${icone("erro", { tam: 36 })}
        <strong>Não foi possível carregar esta tela.</strong>
        <div>${escapeHtml(e?.message || String(e))}</div>
        <button class="btn ghost" id="__retry" style="margin-top:14px">Tentar de novo</button>
      </div>
    </div>`;
  const b = el.querySelector("#__retry");
  if (b) b.onclick = () => (typeof retry === "function" ? retry() : location.reload());
}

const TOAST_INFO = {
  ok: { ic: "sucesso", titulo: "Pronto" },
  err: { ic: "erro", titulo: "Não deu certo" },
  warn: { ic: "aviso", titulo: "Atenção" },
  info: { ic: "info", titulo: "" },
};

/** toast(msg, "ok" | "err" | "warn" | "info"). Erro fica mais tempo na tela. */
export function toast(msg, tipo = "") {
  const wrap = document.getElementById("toast-wrap") || criarToastWrap();
  const info = TOAST_INFO[tipo] || TOAST_INFO.info;
  const dur = tipo === "err" ? 7000 : tipo === "warn" ? 5500 : 4200;
  const t = document.createElement("div");
  t.className = "toast " + (tipo || "info");
  t.setAttribute("role", tipo === "err" ? "alert" : "status");
  t.innerHTML = `
    <div class="t-ic">${icone(info.ic, { tam: 17 })}</div>
    <div class="t-corpo">${info.titulo ? `<span class="t-titulo">${info.titulo}</span>` : ""}<span class="t-msg"></span></div>
    <button class="t-fechar" aria-label="Fechar aviso">${icone("fechar", { tam: 16 })}</button>
    <div class="t-barra" style="animation-duration:${dur}ms"></div>`;
  t.querySelector(".t-msg").textContent = msg;
  // Mais de 4 avisos empilhados: some o mais antigo.
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();
  wrap.appendChild(t);

  let restante = dur;
  let inicio = Date.now();
  let timer = setTimeout(sair, restante);
  const barra = t.querySelector(".t-barra");
  // Mouse em cima pausa (da tempo de ler um erro comprido).
  t.addEventListener("mouseenter", () => {
    clearTimeout(timer);
    restante -= Date.now() - inicio;
    barra.style.animationPlayState = "paused";
  });
  t.addEventListener("mouseleave", () => {
    inicio = Date.now();
    timer = setTimeout(sair, restante);
    barra.style.animationPlayState = "running";
  });
  t.querySelector(".t-fechar").onclick = sair;
  function sair() {
    clearTimeout(timer);
    t.classList.add("saindo");
    setTimeout(() => t.remove(), 180);
  }
}

function criarToastWrap() {
  const w = document.createElement("div");
  w.className = "toast-wrap";
  w.id = "toast-wrap";
  w.setAttribute("role", "status");
  w.setAttribute("aria-live", "polite");
  document.body.appendChild(w);
  return w;
}

/**
 * modal({ titulo, corpo (string|Node), onConfirmar(bodyEl), textoConfirmar, textoCancelar, largo })
 * Esc e o X do topo equivalem a clicar no botao de cancelar (quem escuta o
 * clique nele — maquininha, camera de Pedidos — continua funcionando). Enter
 * num campo de texto confirma.
 */
export function modal({ titulo, corpo, onConfirmar, textoConfirmar = "Salvar", textoCancelar = "Cancelar", largo = false }) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  const box = document.createElement("div");
  box.className = "modal" + (largo ? " largo" : "");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");

  const head = document.createElement("div");
  head.className = "modal-head";
  const h = document.createElement("h3");
  h.textContent = titulo;
  head.appendChild(h);
  const x = document.createElement("button");
  x.className = "modal-x btn so-ic sm";
  x.style.cssText = "background:transparent;border-color:transparent;color:var(--muted)";
  x.setAttribute("aria-label", "Fechar");
  x.innerHTML = icone("fechar", { tam: 18 });
  head.appendChild(x);
  box.appendChild(head);
  box.setAttribute("aria-label", titulo);

  const body = document.createElement("div");
  body.className = "modal-body";
  if (typeof corpo === "string") body.innerHTML = corpo;
  else if (corpo) body.appendChild(corpo);
  box.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "actions";

  const voltarFoco = document.activeElement;
  const fechar = () => {
    bg.remove();
    document.removeEventListener("keydown", teclas);
    if (voltarFoco && voltarFoco.focus && voltarFoco.isConnected) voltarFoco.focus();
  };

  const bCancel = document.createElement("button");
  bCancel.className = "btn ghost";
  bCancel.textContent = textoCancelar;
  bCancel.onclick = fechar;
  actions.appendChild(bCancel);
  x.onclick = () => bCancel.click();

  let bOk = null;
  if (onConfirmar) {
    bOk = document.createElement("button");
    bOk.className = "btn";
    bOk.textContent = textoConfirmar;
    bOk.onclick = async () => {
      bOk.disabled = true;
      bOk.classList.add("carregando");
      try {
        const r = await onConfirmar(body);
        if (r !== false) fechar();
      } catch (e) {
        toast(e?.message || String(e), "err");
      } finally {
        bOk.disabled = false;
        bOk.classList.remove("carregando");
      }
    };
    actions.appendChild(bOk);
  }
  box.appendChild(actions);
  bg.appendChild(box);
  bg.addEventListener("click", (e) => { if (e.target === bg) fechar(); });

  function teclas(e) {
    if (!bg.isConnected) return document.removeEventListener("keydown", teclas);
    if ([...document.querySelectorAll(".modal-bg")].pop() !== bg) return; // so o modal do topo
    if (e.key === "Escape") {
      e.preventDefault();
      bCancel.click();
    } else if (e.key === "Enter" && bOk && !bOk.disabled && e.target.matches("input:not([type=checkbox]):not([type=radio])")) {
      e.preventDefault();
      bOk.click();
    }
  }
  document.addEventListener("keydown", teclas);
  document.body.appendChild(bg);
  // Foco no primeiro campo (ou no botao principal)
  const primeiro = body.querySelector("input:not([type=hidden]):not([readonly]):not([disabled]), select, textarea") || bOk || bCancel;
  setTimeout(() => primeiro?.focus(), 30);
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
