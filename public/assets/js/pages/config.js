import { requireAuth } from "../auth.js";
import { initShell, toast, escapeHtml } from "../ui.js";
import { icone } from "../icons.js";
import { auth } from "../firebase.js";
import { db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "../db.js";
import { parseNum, valorCampo } from "../money.js";
import { FORMAS_JUROS } from "../juros.js";
import { criarClientePoint, storageSeguro, lerTesteLocal, ativarTesteLocal, desativarTesteLocal } from "../point.js";
import {
  segmentadoHtml, segmentado, stepperHtml, ligarSteppers, valorStepper,
  tagsInput, botaoSalvar, switchHtml, linhaHtml,
} from "../componentes.js";

// Configuracoes no estilo "Ajustes": uma aba por assunto, listas agrupadas
// e controles de escolha (interruptor, pilulas, stepper, etiquetas) no lugar
// de texto digitado. O que cada aba grava e o mesmo de antes.

const FORMAS_CONHECIDAS = [
  { valor: "dinheiro", rotulo: "Dinheiro", ic: "dinheiro", cor: "verde" },
  { valor: "pix", rotulo: "Pix", ic: "pix", cor: "azul" },
  { valor: "debito", rotulo: "Débito", ic: "debito", cor: "cinza" },
  { valor: "credito", rotulo: "Crédito", ic: "cartao", cor: "" },
  { valor: "crediario", rotulo: "Crediário", ic: "crediario", cor: "ouro" },
];
const BASES = [
  { valor: "total", rotulo: "Valor pago", sub: "Sobre o total pago pelo cliente, já com desconto." },
  { valor: "total_sem_desconto", rotulo: "Preço cheio", sub: "Sobre os itens a preço de tabela, ignorando o desconto." },
  { valor: "margem", rotulo: "Margem", sub: "Sobre venda menos custo. Fica em zero enquanto o produto não tiver custo." },
];
const FORMA_LABEL = { credito: "Crédito", crediario: "Crediário", debito: "Débito" };
const ABAS = [
  { valor: "loja", rotulo: "Loja", ic: "produtos" },
  { valor: "vendas", rotulo: "Vendas", ic: "pdv" },
  { valor: "parcelas", rotulo: "Parcelamento", ic: "desconto" },
  { valor: "maquininha", rotulo: "Maquininha", ic: "cartao" },
  { valor: "indicadores", rotulo: "Indicadores", ic: "indicadores" },
];

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "config" });

const [snapSis, snapInd] = await Promise.all([
  getDoc(doc(db, "configuracoes", "sistema")),
  getDoc(doc(db, "configuracoes", "indicadores")),
]);
const cfg = snapSis.exists() ? snapSis.data() : {};
const com = cfg.comissao || {};
const parc = cfg.parcelamento || {};
const point = cfg.point || {};
const ind = snapInd.exists() ? snapInd.data() : {};

const formasAtuais = cfg.formas_pagamento ?? ["dinheiro", "pix", "debito", "credito"];
// Formas personalizadas que ja existam no banco continuam aparecendo.
const formasLista = [
  ...FORMAS_CONHECIDAS,
  ...formasAtuais.filter((f) => !FORMAS_CONHECIDAS.some((k) => k.valor === f)).map((f) => ({ valor: f, rotulo: f, ic: "tag", cor: "cinza" })),
];
// Tabela de juros em memoria: { forma: { "n": {cliente, loja} } }
const juros = Object.fromEntries(FORMAS_JUROS.map((f) => [f, { ...(parc.juros?.[f] || {}) }]));
let formaJuros = "credito";
const abaInicial = ABAS.some((a) => a.valor === location.hash.slice(1)) ? location.hash.slice(1) : "loja";
const baseAtual = com.base || "total";

root.innerHTML = `
<div class="config-wrap">
  <div class="config-abas">${segmentadoHtml("abas", ABAS, abaInicial, { classe: "vidro-seg" })}</div>

  <section class="config-painel" data-aba="loja">
    <div class="lista-rotulo">Identificação</div>
    <div class="lista">
      ${linhaHtml({ ic: "produtos", titulo: "Nome da loja", sub: "Aparece no recibo", controle: `<input id="nome" value="${escapeHtml(cfg.nome_loja ?? "Amira")}" placeholder="Amira" autocomplete="off">` })}
      ${linhaHtml({ ic: "nota", cor: "cinza", titulo: "CNPJ", controle: `<input id="cnpj" value="${escapeHtml(cfg.cnpj ?? "")}" placeholder="00.000.000/0000-00" inputmode="numeric" autocomplete="off">` })}
    </div>
    <div class="barra-salvar"><button class="btn" id="salvar-loja">Salvar</button></div>
  </section>

  <section class="config-painel" data-aba="vendas">
    <div class="lista-rotulo">Formas de pagamento no PDV</div>
    <div class="lista" id="lista-formas">
      ${formasLista.map((f) => linhaHtml({ ic: f.ic, cor: f.cor, titulo: escapeHtml(f.rotulo), controle: switchHtml(`forma-${f.valor}`, formasAtuais.includes(f.valor), f.rotulo) })).join("")}
    </div>

    <div class="lista-rotulo">Comissão dos vendedores</div>
    <div class="lista">
      ${linhaHtml({ ic: "comissoes", titulo: "Calcular sobre", sub: `<span id="base-sub">${BASES.find((b) => b.valor === baseAtual)?.sub || ""}</span>`, classe: "coluna", controle: segmentadoHtml("base", BASES, baseAtual, { classe: "bloco" }) })}
      ${linhaHtml({ ic: "tendencia", cor: "ouro", titulo: "Percentual padrão", controle: stepperHtml({ id: "pct", valor: com.percentual_padrao ?? 0, min: 0, max: 50, passo: 0.5, sufixo: "%", rotulo: "Percentual padrão" }) })}
    </div>
    <div class="barra-salvar"><button class="btn" id="salvar-vendas">Salvar</button></div>
  </section>

  <section class="config-painel" data-aba="parcelas">
    <div class="lista-rotulo">Limites</div>
    <div class="lista">
      ${linhaHtml({ ic: "desconto", titulo: "Parcelar em até", controle: stepperHtml({ id: "parc-max", valor: parc.maximo ?? 12, min: 1, max: 24, passo: 1, sufixo: "x", rotulo: "Máximo de parcelas" }) })}
      ${linhaHtml({ ic: "dinheiro", cor: "verde", titulo: "Parcela mínima", sub: "Venda pequena oferece menos parcelas", controle: `<div class="campo-rs"><input id="parc-min" value="${valorCampo(parc.minimo_parcela ?? 0)}" inputmode="decimal"></div>` })}
    </div>

    <div class="lista-rotulo" style="display:flex;align-items:center;gap:10px;margin-right:4px">
      <span style="flex:1">Juros por parcela</span>
      ${segmentadoHtml("forma-juros", FORMAS_JUROS.map((f) => ({ valor: f, rotulo: FORMA_LABEL[f] })), formaJuros)}
    </div>
    <div class="lista sem-ic"><div class="juros-grade" id="juros-grade"></div></div>
    <p class="lista-nota">Cliente: acrescentado ao que o cliente paga. Loja: custo da maquininha sobre o valor original. Zero nos dois = sem juros.</p>
    <div class="barra-salvar"><button class="btn" id="salvar-parc">Salvar</button></div>
  </section>

  <section class="config-painel" data-aba="maquininha">
    <div class="lista-rotulo">Mercado Pago Point</div>
    <div class="lista">
      ${linhaHtml({ ic: "cartao", titulo: "Cobrar na maquininha", sub: "Botão no PDV para crédito e débito", controle: switchHtml("point-ativo", point.ativo === true, "Cobrar na maquininha") })}
      ${linhaHtml({ ic: "cadeado", cor: "cinza", titulo: "Exigir a maquininha", sub: "Bloqueia cartão registrado à mão", controle: switchHtml("point-obrigatorio", point.obrigatorio === true, "Exigir a maquininha"), classe: point.ativo === true ? "" : "desligada" })}
      ${linhaHtml({ ic: "pedidos", cor: "azul", titulo: "Endereço da API", sub: "Vazio = mesmo domínio do sistema", controle: `<input id="point-api" type="url" value="${escapeHtml(point.api_url ?? "")}" placeholder="https://…vercel.app" autocomplete="off">` })}
    </div>
    <div class="barra-salvar">
      <button class="btn ghost" id="testar-point">${icone("sucesso", { tam: 16 })}Testar conexão</button>
      <button class="btn" id="salvar-point">Salvar</button>
    </div>
    <div id="point-terminais" style="margin-bottom:var(--s-6)"></div>

    <details class="mais">
      <summary>Testar só neste computador</summary>
      <div class="lista" style="margin-top:8px">
        ${linhaHtml({ ic: "pdv", cor: "ouro", titulo: "API local", sub: `<span id="point-local-status"></span>`, controle: `<input id="point-local-url" type="url" value="http://localhost:3001" autocomplete="off">` })}
      </div>
      <p class="lista-nota">Vale só neste navegador. As vendas são reais: use um valor pequeno.</p>
      <div class="barra-salvar">
        <button class="btn ghost" id="point-local-desativar">Desativar</button>
        <button class="btn sec" id="point-local-ativar">Ativar aqui</button>
      </div>
    </details>
  </section>

  <section class="config-painel" data-aba="indicadores">
    <div class="lista-rotulo">Link de indicação (?ref=)</div>
    <div class="lista">
      ${linhaHtml({ ic: "pedidos", cor: "azul", titulo: "Endereço do site", sub: "Base para montar o link", controle: `<input id="ind-site" type="url" value="${escapeHtml(ind.site_url ?? "")}" placeholder="https://…" autocomplete="off">` })}
      ${linhaHtml({ ic: "indicadores", titulo: "Comissão do indicador", controle: stepperHtml({ id: "ind-pct", valor: ind.percentual ?? 5, min: 0, max: 50, passo: 0.5, sufixo: "%", rotulo: "Comissão do indicador" }) })}
      ${linhaHtml({ ic: "fechar", cor: "cinza", titulo: "Sem comissão", sub: "Categorias fora da base (iPhone já é excluído)", classe: "coluna", controle: `<div id="ind-cat"></div>` })}
    </div>
    <div class="barra-salvar"><button class="btn" id="salvar-ind">Salvar</button></div>
  </section>
</div>`;

const $ = (s) => root.querySelector(s);
ligarSteppers(root, (st) => {
  if (st.querySelector("#parc-max")) desenharJuros();
});

// ── Abas ─────────────────────────────────────────────────────────────────
function mostrarAba(aba) {
  root.querySelectorAll(".config-painel").forEach((p) => (p.hidden = p.dataset.aba !== aba));
  history.replaceState(null, "", `#${aba}`);
}
segmentado($("#abas"), mostrarAba);
mostrarAba(abaInicial);

// ── Loja ─────────────────────────────────────────────────────────────────
// CNPJ formatado enquanto digita (so numeros na entrada).
$("#cnpj").oninput = (e) => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 14);
  e.target.value = d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
};
botaoSalvar($("#salvar-loja"), async () => {
  const nome = $("#nome").value.trim();
  if (!nome) {
    toast("Informe o nome da loja.", "err");
    return false;
  }
  await setDoc(doc(db, "configuracoes", "sistema"), { nome_loja: nome, cnpj: $("#cnpj").value.trim(), atualizadoEm: serverTimestamp() }, { merge: true });
});

// ── Vendas: formas + comissao ────────────────────────────────────────────
const segBase = segmentado($("#base"), (v) => ($("#base-sub").textContent = BASES.find((b) => b.valor === v)?.sub || ""));
botaoSalvar($("#salvar-vendas"), async () => {
  const formas = formasLista.map((f) => f.valor).filter((f) => $(`#forma-${CSS.escape(f)}`)?.checked);
  if (!formas.length) {
    toast("Deixe pelo menos uma forma de pagamento ligada.", "err");
    return false;
  }
  await setDoc(
    doc(db, "configuracoes", "sistema"),
    {
      formas_pagamento: formas,
      comissao: { base: segBase.valor(), percentual_padrao: valorStepper($("#pct")) },
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
});

// ── Parcelamento: grade 1x..max por forma ────────────────────────────────
// Cada quantidade ate o maximo aparece pronta pra ajustar (sem "+ adicionar
// parcela" nem linha repetida). Zero/zero = sem juros, e nao e gravado.
function lerGradeParaMemoria() {
  root.querySelectorAll("#juros-grade [data-n]").forEach((cel) => {
    const n = cel.dataset.n;
    const campo = cel.dataset.campo;
    const v = Math.max(0, valorStepper(cel.querySelector(".stepper")));
    const t = juros[formaJuros][n] || (juros[formaJuros][n] = { cliente: 0, loja: 0 });
    t[campo] = v;
  });
}
function desenharJuros() {
  const max = formaJuros === "debito" ? 1 : Math.max(1, Math.trunc(valorStepper($("#parc-max"))) || 1);
  const tab = juros[formaJuros];
  const cel = (n, campo, rot) =>
    `<div class="jg-cel" data-n="${n}" data-campo="${campo}">${stepperHtml({ valor: Number(tab[n]?.[campo]) || 0, min: 0, max: 99, passo: 0.5, sufixo: "%", rotulo: `${rot} em ${n}x` })}</div>`;
  $("#juros-grade").innerHTML =
    `<div class="jg-cab">${formaJuros === "debito" ? "" : "Vezes"}</div><div class="jg-cab">Cliente paga</div><div class="jg-cab">Custo da loja</div>` +
    Array.from({ length: max }, (_, i) => String(i + 1))
      .map((n) => `<div class="jg-x">${formaJuros === "debito" ? "À vista" : `${n}x`}</div>${cel(n, "cliente", "Juros do cliente")}${cel(n, "loja", "Custo da loja")}`)
      .join("");
  ligarSteppers($("#juros-grade"), () => lerGradeParaMemoria());
}
segmentado($("#forma-juros"), (f) => {
  lerGradeParaMemoria();
  formaJuros = f;
  desenharJuros();
});
desenharJuros();

botaoSalvar($("#salvar-parc"), async () => {
  lerGradeParaMemoria();
  const maximo = Math.max(1, Math.trunc(valorStepper($("#parc-max"))) || 12);
  // updateDoc com caminhos pontilhados (nao setDoc({merge:true})): merge do
  // Firestore em mapa aninhado e RECURSIVO — uma parcela zerada continuaria
  // no banco. Caminho pontilhado substitui o mapa daquela forma inteiro.
  const dados = {
    "parcelamento.maximo": maximo,
    "parcelamento.minimo_parcela": Math.max(0, parseNum($("#parc-min").value)),
    atualizadoEm: serverTimestamp(),
  };
  for (const forma of FORMAS_JUROS) {
    const limite = forma === "debito" ? 1 : maximo;
    dados[`parcelamento.juros.${forma}`] = Object.fromEntries(
      Object.entries(juros[forma])
        .filter(([n, t]) => Number(n) <= limite && (t.cliente > 0 || t.loja > 0))
        .map(([n, t]) => [n, { cliente: Number(t.cliente) || 0, loja: Number(t.loja) || 0 }])
    );
  }
  try {
    await updateDoc(doc(db, "configuracoes", "sistema"), dados);
  } catch (_) {
    // Doc "sistema" pode nao existir ainda (primeira configuracao).
    await setDoc(
      doc(db, "configuracoes", "sistema"),
      {
        parcelamento: {
          maximo: dados["parcelamento.maximo"],
          minimo_parcela: dados["parcelamento.minimo_parcela"],
          juros: Object.fromEntries(FORMAS_JUROS.map((f) => [f, dados[`parcelamento.juros.${f}`]])),
        },
        atualizadoEm: serverTimestamp(),
      },
      { merge: true }
    );
  }
});
$("#parc-min").onchange = () => ($("#parc-min").value = valorCampo(parseNum($("#parc-min").value)));

// ── Maquininha Point ─────────────────────────────────────────────────────
$("#point-ativo").onchange = () => {
  const ligado = $("#point-ativo").checked;
  $("#point-obrigatorio").closest(".linha").classList.toggle("desligada", !ligado);
  if (!ligado) $("#point-obrigatorio").checked = false;
};
$("#point-obrigatorio").onchange = () => {
  if ($("#point-obrigatorio").checked && !$("#point-ativo").checked) {
    $("#point-ativo").checked = true;
    $("#point-ativo").onchange();
  }
};
botaoSalvar($("#salvar-point"), async () => {
  const dados = {
    ativo: $("#point-ativo").checked,
    obrigatorio: $("#point-obrigatorio").checked,
    api_url: $("#point-api").value.trim().replace(/\/+$/, ""),
  };
  // merge recursivo do Firestore e ok aqui: sao so 3 escalares dentro de `point`
  await setDoc(doc(db, "configuracoes", "sistema"), { point: dados, atualizadoEm: serverTimestamp() }, { merge: true });
});

// Onde o teste vai bater: com o "teste local" ligado, na API local; senao na
// URL do campo (ainda nao salva — da pra conferir antes de gravar).
const storage = storageSeguro();
function baseDaApi() {
  const local = lerTesteLocal(storage);
  return local ? local.api_url : $("#point-api").value.trim().replace(/\/+$/, "");
}
function clientePointDaTela() {
  return criarClientePoint({ apiBase: baseDaApi(), obterToken: () => auth.currentUser.getIdToken() });
}

const ROTULO_CHECK = { ok: "OK", aviso: "Atenção", erro: "Falta" };

function htmlChecklist(d) {
  return `
    <ul class="pt-checks">${d.checks
      .map(
        (c) => `<li class="pt-check ${escapeHtml(c.nivel)}">
          <span class="pt-check-tag">${ROTULO_CHECK[c.nivel] || escapeHtml(c.nivel)}</span>
          <div>
            <strong>${escapeHtml(c.titulo)}</strong>
            <div>${escapeHtml(c.detalhe)}</div>
            ${c.acao ? `<div class="muted">→ ${escapeHtml(c.acao)}</div>` : ""}
          </div>
        </li>`
      )
      .join("")}</ul>
    <div class="faixa ${d.ok ? "ok" : "erro"}">${icone(d.ok ? "sucesso" : "erro", { tam: 16 })}<span>${
      d.ok ? "Tudo pronto pra cobrar." : "Ainda faltam ajustes nos itens marcados como “Falta”."
    }</span></div>`;
}

function htmlTerminais(d) {
  if (!d.terminais.length) return "";
  return `
    <div class="lista-rotulo" style="margin-top:var(--s-5)">Terminais</div>
    <div class="lista">${d.terminais
      .map((t) =>
        linhaHtml({
          ic: "cartao",
          cor: t.modo === "PDV" ? "verde" : "cinza",
          titulo: `<code>${escapeHtml(t.id)}</code>${t.selecionado ? ` <span class="tag ativo">em uso</span>` : ""}`,
          sub: t.modo === "PDV" ? "Modo PDV: recebe as cobranças do sistema" : `Modo ${escapeHtml(t.modo || "?")}: funciona sozinha`,
          controle:
            t.modo === "PDV"
              ? `<button class="btn ghost pt-modo" data-id="${escapeHtml(t.id)}" data-modo="STANDALONE">Modo autônomo</button>`
              : `<button class="btn sec pt-modo" data-id="${escapeHtml(t.id)}" data-modo="PDV">Modo PDV</button>`,
        })
      )
      .join("")}</div>`;
}

// Explica a falha em vez de so repetir a mensagem crua.
function htmlFalha(e, base) {
  const onde = base ? `<code>${escapeHtml(base)}</code>` : "a API deste site";
  let dica;
  if (e?.rede) {
    dica = `Sem resposta de ${onde}. Confira se a API está no ar (local: <code>npm run api:dev</code>) e se <code>${escapeHtml(location.origin)}</code> está em <code>CORS_ORIGINS</code>. Detalhes no console (F12).`;
  } else if (e?.status === 401) {
    dica = `A API recusou o login. A service account precisa ser do projeto <code>flora-5754a</code>.`;
  } else if (e?.status === 403) {
    dica = `Só administradores podem testar a conexão.`;
  } else if (!base) {
    dica = `Endereço vazio e não há API neste domínio. Preencha o endereço ou use o teste local.`;
  } else if (e?.status === 404) {
    dica = `Rota de diagnóstico não encontrada em ${onde}. Confira o endereço e a versão publicada.`;
  } else {
    dica = `Confira o endereço da API e se ela está no ar.`;
  }
  return `<div class="faixa erro">${icone("erro", { tam: 16 })}<div><strong>${escapeHtml(e?.message || "Falha ao consultar.")}</strong><div>${dica}</div></div></div>`;
}

async function testarConexao() {
  const box = $("#point-terminais");
  const base = baseDaApi();
  const btn = $("#testar-point");
  btn.classList.add("carregando");
  btn.disabled = true;
  box.innerHTML = "";
  try {
    const d = await clientePointDaTela().diagnostico();
    // Um servidor qualquer pode responder 200 sem ser a nossa API.
    if (!d || !Array.isArray(d.checks)) {
      throw Object.assign(new Error("A resposta não parece ser da API da maquininha."), { status: 404 });
    }
    box.innerHTML = htmlChecklist(d) + htmlTerminais(d);
    box.querySelectorAll(".pt-modo").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.classList.add("carregando");
        try {
          await clientePointDaTela().definirModo(b.dataset.id, b.dataset.modo);
          toast(b.dataset.modo === "PDV" ? "Maquininha em modo PDV." : "Maquininha em modo autônomo.", "ok");
          testarConexao();
        } catch (err) {
          b.disabled = false;
          b.classList.remove("carregando");
          toast(err?.message || "Não foi possível trocar o modo.", "err");
        }
      };
    });
  } catch (e) {
    box.innerHTML = htmlFalha(e, base);
  } finally {
    btn.classList.remove("carregando");
    btn.disabled = false;
  }
}
$("#testar-point").onclick = testarConexao;

// ── Teste local (so neste navegador) ─────────────────────────────────────
function atualizarStatusLocal() {
  const local = lerTesteLocal(storage);
  $("#point-local-status").innerHTML = local ? `<span class="tag ativo">ativo neste navegador</span>` : "Desligado";
  $("#point-local-desativar").disabled = !local;
  if (local) $("#point-local-url").value = local.api_url;
}
$("#point-local-ativar").onclick = () => {
  const r = ativarTesteLocal(storage, $("#point-local-url").value);
  if (!r.ok) return toast(r.erro, "err");
  toast("Teste local ligado neste navegador.", "ok");
  atualizarStatusLocal();
};
$("#point-local-desativar").onclick = () => {
  desativarTesteLocal(storage);
  toast("Teste local desligado.", "ok");
  atualizarStatusLocal();
};
atualizarStatusLocal();

// ── Indicadores ──────────────────────────────────────────────────────────
const categorias = tagsInput($("#ind-cat"), ind.categorias_excluidas ?? ["iphones"], {
  normalizar: (s) => s.trim().toLowerCase().replace(/,/g, ""),
  placeholder: "slug da categoria + Enter",
});
botaoSalvar($("#salvar-ind"), async () => {
  await setDoc(
    doc(db, "configuracoes", "indicadores"),
    {
      site_url: $("#ind-site").value.trim().replace(/\/+$/, ""),
      percentual: valorStepper($("#ind-pct")),
      categorias_excluidas: categorias.valores(),
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
});
