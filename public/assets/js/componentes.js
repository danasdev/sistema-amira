// ── Controles interativos ───────────────────────────────────────────────
// Comportamentos inspirados no Kinetics (kinetics.colorion.co), reescritos
// com os tokens da loja (base.css: .seg, .stepper, .chip, .tags, .switch).
// Servem pra trocar campo de texto digitado por escolha direta.

import { icone } from "./icons.js";
import { escapeHtml } from "./ui.js";

/**
 * Segmentado com pilula que desliza ate a opcao escolhida.
 * html: segmentadoHtml("id", [{valor, rotulo, ic?}], valorAtual)
 * ligar: segmentado(el, (valor) => ...) -> { valor(), definir(v) }
 */
export function segmentadoHtml(id, opcoes, atual, { classe = "" } = {}) {
  return `<div class="seg ${classe}" id="${id}" role="tablist">
    <span class="seg-pilula" aria-hidden="true"></span>
    ${opcoes
      .map((o) => `<button type="button" role="tab" data-valor="${escapeHtml(o.valor)}" aria-selected="${o.valor === atual}">${o.ic ? icone(o.ic, { tam: 16 }) : ""}${escapeHtml(o.rotulo)}</button>`)
      .join("")}
  </div>`;
}

export function segmentado(el, aoMudar) {
  const pilula = el.querySelector(".seg-pilula");
  const botoes = [...el.querySelectorAll("button[data-valor]")];
  const mover = (b, animar = true) => {
    if (!b) return;
    if (!animar) pilula.style.transition = "none";
    pilula.style.width = `${b.offsetWidth}px`;
    pilula.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!animar) requestAnimationFrame(() => (pilula.style.transition = ""));
  };
  const definir = (valor, avisar = false) => {
    botoes.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.valor === valor)));
    mover(botoes.find((b) => b.dataset.valor === valor));
    if (avisar) aoMudar?.(valor);
  };
  botoes.forEach((b) => (b.onclick = () => definir(b.dataset.valor, true)));
  // Medida inicial depois do layout (e de novo quando a fonte carregar / redimensionar).
  const inicial = () => mover(botoes.find((b) => b.getAttribute("aria-selected") === "true"), false);
  requestAnimationFrame(inicial);
  document.fonts?.ready.then(inicial);
  new ResizeObserver(inicial).observe(el);
  return { valor: () => botoes.find((b) => b.getAttribute("aria-selected") === "true")?.dataset.valor, definir };
}

/**
 * Stepper numerico (− valor +). `passo` e `casas` controlam o incremento.
 * html: stepperHtml({ id, valor, min, max, passo, sufixo, rotulo })
 * ligar: ligarSteppers(raiz) — liga todos os .stepper dentro da raiz.
 */
export function stepperHtml({ id = "", valor = 0, min = 0, max = 9999, passo = 1, sufixo = "", rotulo = "Valor", classe = "" }) {
  return `<div class="stepper ${classe}" data-min="${min}" data-max="${max}" data-passo="${passo}">
    <button type="button" class="st-menos" aria-label="Diminuir ${escapeHtml(rotulo)}">${icone("menos", { tam: 14 })}</button>
    <input ${id ? `id="${id}"` : ""} inputmode="decimal" value="${formatarNum(valor, passo)}" aria-label="${escapeHtml(rotulo)}">
    ${sufixo ? `<span class="sufixo">${escapeHtml(sufixo)}</span>` : ""}
    <button type="button" class="st-mais" aria-label="Aumentar ${escapeHtml(rotulo)}">${icone("mais", { tam: 14 })}</button>
  </div>`;
}

const casasDe = (passo) => (String(passo).split(".")[1] || "").length;
function formatarNum(v, passo) {
  return Number(v || 0).toFixed(casasDe(passo)).replace(".", ",");
}
const lerNum = (s) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

export function valorStepper(elOuInput) {
  const inp = elOuInput.tagName === "INPUT" ? elOuInput : elOuInput.querySelector("input");
  return lerNum(inp.value);
}

export function ligarSteppers(raiz, aoMudar) {
  raiz.querySelectorAll(".stepper").forEach((st) => {
    if (st.dataset.ligado) return;
    st.dataset.ligado = "1";
    const inp = st.querySelector("input");
    const min = Number(st.dataset.min), max = Number(st.dataset.max), passo = Number(st.dataset.passo) || 1;
    const definir = (v) => {
      const c = Math.min(max, Math.max(min, Math.round(v / passo) * passo));
      inp.value = formatarNum(c, passo);
      st.querySelector(".st-menos").disabled = c <= min;
      st.querySelector(".st-mais").disabled = c >= max;
      st.classList.remove("pulou");
      void st.offsetWidth;
      st.classList.add("pulou");
      aoMudar?.(st, c);
    };
    st.querySelector(".st-menos").onclick = () => definir(lerNum(inp.value) - passo);
    st.querySelector(".st-mais").onclick = () => definir(lerNum(inp.value) + passo);
    inp.onchange = () => definir(lerNum(inp.value));
    inp.onfocus = () => setTimeout(() => inp.select(), 0);
    inp.onkeydown = (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); definir(lerNum(inp.value) + passo); }
      if (e.key === "ArrowDown") { e.preventDefault(); definir(lerNum(inp.value) - passo); }
    };
    const v = lerNum(inp.value);
    st.querySelector(".st-menos").disabled = v <= min;
    st.querySelector(".st-mais").disabled = v >= max;
  });
}

/** Chips de escolha multipla: <div class="chips"> com <button class="chip" data-valor aria-pressed>. */
export function chipsHtml(id, opcoes, marcados) {
  const set = new Set(marcados);
  return `<div class="chips" id="${id}">${opcoes
    .map((o) => `<button type="button" class="chip" data-valor="${escapeHtml(o.valor)}" aria-pressed="${set.has(o.valor)}">${o.ic ? icone(o.ic, { tam: 15 }) : ""}${escapeHtml(o.rotulo)}</button>`)
    .join("")}</div>`;
}
export function ligarChips(el, aoMudar) {
  el.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true"));
      aoMudar?.(valoresChips(el));
    };
  });
}
export const valoresChips = (el) => [...el.querySelectorAll('.chip[aria-pressed="true"]')].map((c) => c.dataset.valor);

/** Entrada de etiquetas: Enter/virgula cria, x ou Backspace remove. */
export function tagsInput(el, valores = [], { normalizar = (s) => s.trim(), placeholder = "Digite e tecle Enter" } = {}) {
  let lista = [...valores];
  const pintar = () => {
    el.innerHTML = lista
      .map((v, i) => `<span class="tag-i">${escapeHtml(v)}<button type="button" data-i="${i}" aria-label="Remover ${escapeHtml(v)}">${icone("fechar", { tam: 12 })}</button></span>`)
      .join("") + `<input placeholder="${lista.length ? "" : escapeHtml(placeholder)}" aria-label="Adicionar">`;
    const inp = el.querySelector("input");
    el.querySelectorAll(".tag-i button").forEach((b) => (b.onclick = () => { lista.splice(+b.dataset.i, 1); pintar(); el.querySelector("input").focus(); }));
    inp.onkeydown = (e) => {
      if ((e.key === "Enter" || e.key === ",") && inp.value.trim()) {
        e.preventDefault();
        const v = normalizar(inp.value);
        if (v && !lista.includes(v)) lista.push(v);
        pintar();
        el.querySelector("input").focus();
      } else if (e.key === "Backspace" && !inp.value && lista.length) {
        lista.pop();
        pintar();
        el.querySelector("input").focus();
      }
    };
  };
  el.classList.add("tags");
  el.onclick = (e) => { if (e.target === el) el.querySelector("input").focus(); };
  pintar();
  return { valores: () => {
    const pend = normalizar(el.querySelector("input").value || "");
    return pend && !lista.includes(pend) ? [...lista, pend] : [...lista];
  } };
}

/** Contador que sobe ate o valor (Odometer Count-up). `fmt` formata o numero. */
export function contar(el, alvo, fmt = (n) => String(Math.round(n)), dur = 900) {
  if (!el) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !alvo) { el.textContent = fmt(alvo); return; }
  const t0 = performance.now();
  const passo = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(2, -10 * p); // ease-out exponencial
    el.textContent = fmt(alvo * (p === 1 ? 1 : e));
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/**
 * Botao com estado (Status Pill): normal -> salvando -> "Salvo" verde -> normal.
 * `acao` pode retornar false pra cancelar sem mostrar "Salvo".
 */
export function botaoSalvar(btn, acao) {
  const original = btn.innerHTML;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.classList.add("carregando");
    let ok = false;
    try {
      ok = (await acao()) !== false;
    } finally {
      btn.classList.remove("carregando");
      btn.disabled = false;
    }
    if (!ok) return;
    btn.classList.add("salvo");
    btn.innerHTML = `${icone("check", { tam: 16 })}Salvo`;
    setTimeout(() => {
      btn.classList.remove("salvo");
      btn.innerHTML = original;
    }, 1600);
  };
}

/** Interruptor: <label class="switch"><input type="checkbox"><span></span></label> */
export function switchHtml(id, ligado, rotulo) {
  return `<label class="switch"><input type="checkbox" id="${id}" ${ligado ? "checked" : ""} role="switch" aria-label="${escapeHtml(rotulo)}"><span></span></label>`;
}

/** Linha de lista agrupada (estilo Ajustes). */
export function linhaHtml({ ic, cor = "", titulo, sub = "", controle = "", classe = "" }) {
  return `<div class="linha ${classe}">
    ${ic ? `<span class="l-ic ${cor}">${icone(ic, { tam: 17 })}</span>` : ""}
    <div class="l-txt"><div class="l-tit">${titulo}</div>${sub ? `<div class="l-sub">${sub}</div>` : ""}</div>
    ${controle ? `<div class="l-ctl">${controle}</div>` : ""}
  </div>`;
}
