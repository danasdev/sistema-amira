// ── Pagina publica da conta do crediario (/conta?t=TOKEN) ───────────────
// Sem login: o token do link e o segredo. Fala SO com a API do mesmo dominio
// (api/conta/*) — nunca com o Firestore — e nao carrega o Firebase. Mostra
// quanto o cliente comprou, pagou e deve, e deixa pagar por Pix (QR aqui
// mesmo) ou cartao (Checkout Pro do Mercado Pago, volta pra ca).

import { icone } from "../icons.js";
import { brl, round2, parseNum, valorCampo } from "../money.js";

const params = new URLSearchParams(location.search);
const token = params.get("t") || "";
const cobrancaVolta = params.get("c"); // volta do checkout de cartao
const root = document.getElementById("root");
const CHAVE_EMAIL = "amira-conta-email";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dataCurta = (ms) => (ms ? new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "");
const FORMA = { dinheiro: "Dinheiro", pix: "Pix", debito: "Débito", credito: "Cartão de crédito", online: "Online" };
const lerEmail = () => { try { return localStorage.getItem(CHAVE_EMAIL) || ""; } catch { return ""; } };
const guardarEmail = (e) => { try { localStorage.setItem(CHAVE_EMAIL, e); } catch {} };

let conta = null;
let valorEscolhido = null; // null = tudo
let metodo = "pix";
let timerStatus = null;

function toast(msg, tipo = "info") {
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toast-wrap";
    wrap.className = "toast-wrap";
    wrap.setAttribute("role", "status");
    document.body.appendChild(wrap);
  }
  const ic = { ok: "sucesso", err: "erro", warn: "aviso", info: "info" }[tipo] || "info";
  const t = document.createElement("div");
  t.className = `toast ${tipo}`;
  t.innerHTML = `<div class="t-ic">${icone(ic, { tam: 16 })}</div><div class="t-corpo"><span class="t-msg"></span></div><div class="t-barra" style="animation-duration:4500ms"></div>`;
  t.querySelector(".t-msg").textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add("saindo"); setTimeout(() => t.remove(), 200); }, 4500);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, { headers: { "Content-Type": "application/json" }, cache: "no-store", ...opcoes });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(corpo.erro || "Não foi possível falar com a loja agora."), { status: r.status });
  return corpo;
}

function moldura(conteudo) {
  root.innerHTML = `
    <main class="conta">
      <header class="conta-topo"><span class="logo-marca" role="img" aria-label="Amira"></span></header>
      ${conteudo}
      <footer class="conta-pe">${icone("seguro", { tam: 14 })}Pagamento processado pelo Mercado Pago</footer>
    </main>`;
}

function telaErro(titulo, texto) {
  moldura(`<section class="card conta-card"><div class="vazio">${icone("cadeado", { tam: 36 })}<strong>${esc(titulo)}</strong><div>${esc(texto)}</div></div></section>`);
}

async function carregar() {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return telaErro("Link inválido", "Confira o link que a loja enviou ou peça um novo.");
  if (!conta) moldura(`<section class="card conta-card conta-esqueleto"><span></span><span></span><span></span></section>`);
  try {
    conta = await api(`/api/conta/resumo?t=${encodeURIComponent(token)}`);
    render();
  } catch (e) {
    if (e.status === 404) telaErro("Link inválido ou expirado", "Peça um link novo na loja.");
    else telaErro("Não deu pra abrir sua conta", e.message);
  }
}

function render() {
  const c = conta;
  const pct = c.comprado > 0 ? Math.min(100, (c.pago / c.comprado) * 100) : 0;
  const quitado = c.restante <= 0;
  moldura(`
    <section class="card conta-card conta-hero">
      <div class="conta-ola">Olá, ${esc(c.cliente.nome)}</div>
      <div class="conta-rot">${quitado ? "Sua conta está em dia" : "Falta pagar"}</div>
      <div class="conta-valor">${brl(Math.max(0, c.restante))}</div>
      <div class="progresso ${quitado ? "completo" : ""}"><span style="width:${pct}%"></span></div>
      <div class="conta-mini">
        <div><span>Comprado</span><strong>${brl(c.comprado)}</strong></div>
        <div><span>Já pago</span><strong>${brl(c.pago)}</strong></div>
      </div>
    </section>

    ${quitado
      ? `<section class="card conta-card"><div class="faixa ok">${icone("sucesso", { tam: 16 })}<span>Tudo pago. Obrigada pela confiança!</span></div></section>`
      : `<section class="card conta-card" id="pagar"></section>`}

    ${c.compras.length || c.pagamentos.length ? `
    <section class="card conta-card">
      <div class="card-titulo">${icone("sacola", { tam: 18 })}<span>Histórico</span></div>
      <div class="conta-lista">
        ${[
          ...c.compras.map((v) => ({ data: v.data, tipo: "compra", v })),
          ...c.pagamentos.map((p) => ({ data: p.data, tipo: "pag", p })),
        ]
          .sort((a, b) => (b.data || 0) - (a.data || 0))
          .map((x) =>
            x.tipo === "compra"
              ? `<div class="conta-item"><span class="ci-ic compra">${icone("sacola", { tam: 15 })}</span>
                  <div class="ci-txt"><strong>Compra${x.v.numero ? ` nº ${x.v.numero}` : ""}</strong><span>${esc(x.v.itens.map((i) => `${i.qtd}× ${i.nome}`).join(", "))}</span></div>
                  <div class="ci-val"><strong>${brl(x.v.valor)}</strong><span>${dataCurta(x.v.data)}</span></div></div>`
              : `<div class="conta-item"><span class="ci-ic pag">${icone("check", { tam: 15 })}</span>
                  <div class="ci-txt"><strong>Pagamento</strong><span>${esc(FORMA[x.p.forma] || x.p.forma)}${x.p.online ? " · pelo link" : ""}</span></div>
                  <div class="ci-val"><strong class="ci-pos">− ${brl(x.p.valor)}</strong><span>${dataCurta(x.p.data)}</span></div></div>`
          )
          .join("")}
      </div>
    </section>` : ""}`);
  if (!quitado) renderPagar();
}

// ── Formulario de pagamento ──────────────────────────────────────────────
function valorAtual() {
  return valorEscolhido == null ? conta.restante : valorEscolhido;
}

function renderPagar() {
  const box = document.getElementById("pagar");
  const outro = valorEscolhido != null;
  const pedirEmail = conta.precisa_email && metodo === "pix";
  box.innerHTML = `
    <div class="card-titulo">${icone("dinheiro", { tam: 18 })}<span>Pagar agora</span></div>
    <div class="seg bloco simples" role="group" aria-label="Quanto pagar">
      <button type="button" class="${outro ? "" : "on"}" data-v="tudo">Tudo · ${brl(conta.restante)}</button>
      <button type="button" class="${outro ? "on" : ""}" data-v="outro">Outro valor</button>
    </div>
    ${outro ? `<div class="flutua rs"><input id="valor" inputmode="decimal" placeholder=" " value="${valorEscolhido ? valorCampo(valorEscolhido) : ""}"><label for="valor">Quanto você quer pagar</label></div>
      <p class="dica">Entre ${brl(conta.valor_minimo)} e ${brl(conta.restante)}.</p>` : ""}
    <div class="conta-metodos" role="radiogroup" aria-label="Forma de pagamento">
      <button type="button" role="radio" aria-checked="${metodo === "pix"}" data-m="pix">${icone("pix", { tam: 22 })}<span><strong>Pix</strong><small>Aprovação na hora</small></span></button>
      <button type="button" role="radio" aria-checked="${metodo === "cartao"}" data-m="cartao">${icone("cartao", { tam: 22 })}<span><strong>Cartão</strong><small>No Mercado Pago</small></span></button>
    </div>
    ${pedirEmail ? `<div class="flutua"><input id="email" type="email" inputmode="email" autocomplete="email" placeholder=" " value="${esc(lerEmail())}"><label for="email">Seu e-mail (pro comprovante)</label></div>` : ""}
    <button class="btn lg bloco" id="btn-pagar" style="margin-top:16px">${icone(metodo === "pix" ? "pix" : "cartao", { tam: 18 })}Pagar ${brl(valorAtual())}${metodo === "pix" ? " com Pix" : " no cartão"}</button>`;

  box.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => {
    valorEscolhido = b.dataset.v === "tudo" ? null : valorEscolhido ?? 0;
    renderPagar();
    if (b.dataset.v === "outro") box.querySelector("#valor")?.focus();
  }));
  box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { metodo = b.dataset.m; renderPagar(); }));
  const inp = box.querySelector("#valor");
  if (inp) {
    inp.oninput = () => {
      valorEscolhido = round2(parseNum(inp.value));
      box.querySelector("#btn-pagar").innerHTML = `${icone(metodo === "pix" ? "pix" : "cartao", { tam: 18 })}Pagar ${brl(valorAtual())}${metodo === "pix" ? " com Pix" : " no cartão"}`;
    };
    inp.onkeydown = (e) => { if (e.key === "Enter") box.querySelector("#btn-pagar").click(); };
  }
  box.querySelector("#btn-pagar").onclick = pagar;
}

async function pagar() {
  const btn = document.getElementById("btn-pagar");
  const valor = round2(valorAtual());
  if (!(valor >= conta.valor_minimo) || valor > conta.restante) {
    return toast(`Escolha um valor entre ${brl(conta.valor_minimo)} e ${brl(conta.restante)}.`, "err");
  }
  const email = document.getElementById("email")?.value.trim() || "";
  if (conta.precisa_email && metodo === "pix") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      document.getElementById("email")?.focus();
      return toast("Informe um e-mail válido pra receber o comprovante.", "err");
    }
    guardarEmail(email);
  }
  btn.disabled = true;
  btn.classList.add("carregando");
  try {
    const r = await api("/api/conta/pagar", { method: "POST", body: JSON.stringify({ t: token, valor, metodo, ...(email ? { email } : {}) }) });
    if (r.checkout_url) {
      location.href = r.checkout_url; // Checkout Pro; volta pra ca com ?c=
      return;
    }
    mostrarPix(r);
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false;
    btn.classList.remove("carregando");
  }
}

// ── Pix: QR + copia-e-cola, acompanha ate aprovar ────────────────────────
function mostrarPix(r) {
  const box = document.getElementById("pagar");
  box.innerHTML = `
    <div class="card-titulo">${icone("pix", { tam: 18 })}<span>Pague com Pix</span><span class="acao conta-valor-pq">${brl(r.valor)}</span></div>
    <div class="conta-qr">${r.pix.qr_code_base64 ? `<img alt="QR code do Pix" src="data:image/png;base64,${esc(r.pix.qr_code_base64)}">` : ""}</div>
    <p class="dica" style="text-align:center">Abra o app do banco e escaneie, ou copie o código.</p>
    <button class="btn sec bloco" id="copiar-pix">${icone("copiar", { tam: 16 })}Copiar código Pix</button>
    <div class="conta-esperando" id="esperando"><span class="ponto"></span>Aguardando o pagamento…</div>
    <button class="btn ghost bloco" id="voltar-pix" style="margin-top:8px">Escolher outro valor ou forma</button>`;
  box.querySelector("#copiar-pix").onclick = async () => {
    try {
      await navigator.clipboard.writeText(r.pix.qr_code);
      const b = box.querySelector("#copiar-pix");
      b.innerHTML = `${icone("check", { tam: 16 })}Código copiado`;
      setTimeout(() => (b.innerHTML = `${icone("copiar", { tam: 16 })}Copiar código Pix`), 2000);
    } catch {
      prompt("Copie o código Pix:", r.pix.qr_code);
    }
  };
  box.querySelector("#voltar-pix").onclick = () => { pararStatus(); renderPagar(); };
  acompanhar(r.cobranca, 30 * 60 * 1000);
}

function pararStatus() {
  if (timerStatus) clearTimeout(timerStatus);
  timerStatus = null;
}

function acompanhar(cobranca, duracaoMs, aoTerminar) {
  pararStatus();
  const fim = Date.now() + duracaoMs;
  const tick = async () => {
    try {
      const s = await api(`/api/conta/status?t=${encodeURIComponent(token)}&c=${encodeURIComponent(cobranca)}`);
      if (s.status === "aprovado") return sucesso(s.valor);
      if (s.status === "recusado" || s.status === "cancelado") {
        aoTerminar?.();
        toast(s.status === "recusado" ? "O pagamento foi recusado. Tente outra forma." : "O pagamento foi cancelado.", "err");
        return renderPagar();
      }
    } catch (_) { /* rede instavel: tenta de novo */ }
    if (Date.now() < fim) timerStatus = setTimeout(tick, document.hidden ? 8000 : 3500);
    else { aoTerminar?.(); const e = document.getElementById("esperando"); if (e) e.innerHTML = "O código expirou. Gere outro pagamento."; }
  };
  timerStatus = setTimeout(tick, 2500);
}

function sucesso(valor) {
  pararStatus();
  const box = document.getElementById("pagar");
  if (box) {
    box.innerHTML = `
      <div class="conta-sucesso">
        <svg viewBox="0 0 52 52" class="check-anim" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
        <strong>Pagamento confirmado</strong>
        <span>${brl(valor)} já foi descontado da sua conta.</span>
      </div>`;
  }
  toast("Pagamento confirmado. Obrigada!", "ok");
  setTimeout(carregar, 2600);
}

// Volta do checkout do cartao: confirma o pagamento antes de mostrar a conta.
async function voltaDoCartao() {
  await carregar();
  if (!conta) return;
  history.replaceState(null, "", `${location.pathname}?t=${encodeURIComponent(token)}`);
  const box = document.getElementById("pagar");
  if (box) box.innerHTML = `<div class="conta-esperando"><span class="ponto"></span>Confirmando o pagamento no cartão…</div>`;
  acompanhar(cobrancaVolta, 2 * 60 * 1000, () => renderPagar());
}

if (cobrancaVolta && /^conta_[A-Za-z0-9-]{8,60}$/.test(cobrancaVolta)) voltaDoCartao();
else carregar();
