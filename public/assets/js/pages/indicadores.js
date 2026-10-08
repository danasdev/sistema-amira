import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData } from "../ui.js";
import {
  db, collection, getDocs, query, orderBy, where, Timestamp,
  doc, addDoc, updateDoc, deleteDoc, serverTimestamp,
  getConfigIndicadores, periodoParaIntervalo,
} from "../db.js";
import { brl, round2 } from "../money.js";
import { baseElegivelIndicador, baseElegivelIndicadorVenda, derivarItensPedido, contaComoPago } from "../produtos-schema.js";
import { mapaDoCatalogo } from "../catalogo-cache.js";
import { vendasPdvComIndicador, noPeriodo } from "../vendas-indicador.js";

// DUAS ORIGENS somam para o indicador: pedidos do SITE com `ref` (link
// ?ref=) e vendas do PDV em que o vendedor escolheu o indicador (`ref` na
// venda). Ver ../vendas-indicador.js.

// LEITURAS (mesma cota grátis do site): o catálogo vem do cache da aba
// (../catalogo-cache.js) em vez de ser relido a cada apuração/perfil, e os
// pedidos de um período são lidos uma vez e reaproveitados pelos perfis de
// indicador — "Apurar" é o que busca de novo.

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "indicadores" });

const cfg = await getConfigIndicadores();
const siteUrl = (cfg.site_url || "").replace(/\/+$/, "");
const pct = Number(cfg.percentual ?? 5);
const excluirSlugs = cfg.categorias_excluidas || [];
const excluidasTxt = excluirSlugs.join(", ") || "(so iPhone, por prefixo)";

const agora = new Date();
let periodo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
let indicadores = [];
let vendidoPorCodigo = {}; // codigo -> { qtd, total } (todo o historico, sem filtro de periodo)
let totalGeralVendido = 0;

// Camada principal (pra excluir iPhone da base de comissao) muda raramente
// — busca uma vez e reaproveita, em vez de re-buscar a cada apuracao.
let camadaPrincipalSlugCache;
async function getCamadaPrincipalSlug() {
  if (camadaPrincipalSlugCache !== undefined) return camadaPrincipalSlugCache;
  const snap = await getDocs(query(collection(db, "camadas"), orderBy("ordem", "asc")));
  camadaPrincipalSlugCache = snap.docs.length ? (snap.docs[0].data().slug || null) : null;
  return camadaPrincipalSlugCache;
}

// Pedidos de um periodo (todos os status; quem chama filtra ref/pago).
const pedidosPorPeriodo = new Map();
function pedidosDoPeriodo(per, { fresco = false } = {}) {
  if (!fresco && pedidosPorPeriodo.has(per)) return pedidosPorPeriodo.get(per);
  const { inicio, fim } = periodoParaIntervalo(per);
  const promessa = getDocs(query(
    collection(db, "pedidos"),
    where("criadoEm", ">=", Timestamp.fromDate(inicio)),
    where("criadoEm", "<", Timestamp.fromDate(fim)),
    orderBy("criadoEm", "desc")
  ))
    .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))
    .catch((e) => { pedidosPorPeriodo.delete(per); throw e; });
  pedidosPorPeriodo.set(per, promessa);
  return promessa;
}

// Mesmo calculo do site (frontend/src/pages/services/pedidos.js:
// codigoRetirada) e ja usado em pedidos.js — so pra referenciar o pedido
// na lista de apuracao sem expor o id bruto do documento.
const AMBIGUOS_RETIRADA = { O: "0", I: "1", L: "1", U: "V" };
function codigoRetirada(pedidoId) {
  const base = String(pedidoId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(-6)
    .padStart(6, "X");
  const limpo = [...base].map((c) => AMBIGUOS_RETIRADA[c] || c).join("");
  return `AMR-${limpo}`;
}

root.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:center">
      <button class="btn" id="novo">+ Indicador</button>
      <span class="muted">Comissao: <strong>${pct}%</strong> &middot; link do indicador nao expira &middot; sem comissao: iPhone${excluirSlugs.length ? " + " + escapeHtml(excluidasTxt) : ""} &middot; <a href="/config">alterar</a></span>
    </div>
  </div>
  <div class="card">
    <div id="tabela">Carregando...</div>
    <p class="muted" id="total-geral" style="margin-top:8px"></p>
  </div>

  <div class="card">
    <strong>Apuracao de comissoes &mdash; pedidos do site</strong>
    <p class="muted">Considera <code>pedidos</code> com um <code>ref</code> de indicador (link <code>?ref=</code>) que ja foram pagos (aguardando pagamento e cancelados ficam de fora, mesmo depois do pedido avancar pra preparando/enviado/entregue). O total e derivado do catalogo atual; iPhone nao entra na base. Pagamento e manual.</p>
    <div class="row">
      <div><label>Periodo</label><input type="month" id="periodo" value="${periodo}"></div>
      <div style="align-self:end"><button class="btn" id="apurar">Apurar</button></div>
    </div>
    <div id="apuracao" style="margin-top:10px"></div>
  </div>`;

document.getElementById("novo").onclick = () => editar(null);
document.getElementById("apurar").onclick = () => {
  periodo = document.getElementById("periodo").value || periodo;
  apurar();
};

await carregar();
await carregarTotaisVendidos();
await apurar();

function normalizaCodigo(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "")
    .slice(0, 24);
}

function linkDe(codigo) {
  const base = siteUrl || "https://SEU-SITE";
  return `${base}/?ref=${encodeURIComponent(codigo)}`;
}

async function carregar() {
  const snap = await getDocs(query(collection(db, "indicadores"), orderBy("nome")));
  indicadores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderTabela();
}

// Total vendido por indicador, olhando TODO o historico de `pedidos` com
// `ref` ja pagos — nao depende do filtro de periodo da apuracao de
// comissao. Total bruto dos itens (sem excluir iPhone), pois aqui e "quanto
// o indicador vendeu", nao a base de comissao.
async function carregarTotaisVendidos() {
  try {
    const [pedidosSnap, produtosMap, vendasPdv] = await Promise.all([
      getDocs(query(collection(db, "pedidos"), where("ref", "!=", ""))),
      mapaDoCatalogo(),
      vendasPdvComIndicador({ fresco: true }),
    ]);
    const pedidos = pedidosSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => contaComoPago(p.status));

    vendidoPorCodigo = {};
    totalGeralVendido = 0;
    for (const p of pedidos) {
      const cod = String(p.ref);
      const { subtotal } = derivarItensPedido(p, produtosMap);
      const a = vendidoPorCodigo[cod] || (vendidoPorCodigo[cod] = { qtd: 0, total: 0 });
      a.qtd++;
      a.total = round2(a.total + subtotal);
      totalGeralVendido = round2(totalGeralVendido + subtotal);
    }
    // vendas do PDV: vale o total cobrado (ja com desconto)
    for (const v of vendasPdv) {
      const cod = String(v.ref);
      const total = Number(v.total) || 0;
      const a = vendidoPorCodigo[cod] || (vendidoPorCodigo[cod] = { qtd: 0, total: 0 });
      a.qtd++;
      a.total = round2(a.total + total);
      totalGeralVendido = round2(totalGeralVendido + total);
    }
  } catch (_) {
    vendidoPorCodigo = {};
    totalGeralVendido = 0;
  }
  renderTabela();
}

function renderTabela() {
  document.getElementById("tabela").innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th>Nome</th><th>Codigo</th><th>Link</th><th class="right">Vendas</th>
        <th class="right">Total vendido</th><th>Contato</th><th>Ativo</th><th></th>
      </tr></thead>
      <tbody>
        ${
          indicadores
            .map((r) => {
              const v = vendidoPorCodigo[r.codigo] || { qtd: 0, total: 0 };
              return `<tr>
                <td><button class="btn ghost perfil" data-id="${r.id}">${escapeHtml(r.nome || "-")}</button></td>
                <td><code>${escapeHtml(r.codigo || "")}</code></td>
                <td><button class="btn ghost copiar" data-cod="${escapeHtml(r.codigo || "")}">Copiar link</button></td>
                <td class="right">${v.qtd}</td>
                <td class="right">${brl(v.total)}</td>
                <td>${escapeHtml(r.contato || "")}</td>
                <td><span class="tag ${r.ativo === false ? "inativo" : "ativo"}">${r.ativo === false ? "inativo" : "ativo"}</span></td>
                <td class="right"><button class="btn ghost editar" data-id="${r.id}">Editar</button></td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="8" class="muted">Nenhum indicador cadastrado.</td></tr>`
        }
      </tbody>
    </table></div>`;

  document.getElementById("total-geral").textContent =
    `Total vendido por todos os indicadores (historico completo): ${brl(totalGeralVendido)}.`;

  document.querySelectorAll(".editar").forEach(
    (b) => (b.onclick = () => editar(indicadores.find((r) => r.id === b.dataset.id)))
  );
  document.querySelectorAll(".perfil").forEach(
    (b) => (b.onclick = () => verPerfil(indicadores.find((r) => r.id === b.dataset.id)))
  );
  document.querySelectorAll(".copiar").forEach(
    (b) => (b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(linkDe(b.dataset.cod));
        toast("Link copiado.", "ok");
      } catch (_) {
        toast(linkDe(b.dataset.cod), "");
      }
    })
  );
}

function editar(r) {
  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="r-nome" value="${escapeHtml(r?.nome || "")}">
    <label>Codigo do link (usado em ?ref=)</label>
    <input id="r-cod" value="${escapeHtml(r?.codigo || "")}" placeholder="ex.: JOAO ou MARIA02">
    <label>Contato (telefone / e-mail)</label><input id="r-contato" value="${escapeHtml(r?.contato || "")}">
    <label style="text-transform:none"><input type="checkbox" id="r-ativo" ${r?.ativo === false ? "" : "checked"} style="width:auto"> Indicador ativo</label>
    <p class="muted" id="r-preview">${r ? "Link: " + escapeHtml(linkDe(r.codigo || "")) : ""}</p>
    ${r ? `<button class="btn danger" id="r-del" style="margin-top:12px">Excluir indicador</button>` : ""}`;

  const codInput = c.querySelector("#r-cod");
  const preview = c.querySelector("#r-preview");
  codInput.oninput = () => {
    codInput.value = normalizaCodigo(codInput.value);
    preview.textContent = codInput.value ? "Link: " + linkDe(codInput.value) : "";
  };

  const bg = modal({
    titulo: r ? "Editar indicador" : "Novo indicador",
    corpo: c,
    onConfirmar: async () => {
      const nome = c.querySelector("#r-nome").value.trim();
      const codigo = normalizaCodigo(c.querySelector("#r-cod").value);
      const contato = c.querySelector("#r-contato").value.trim();
      const ativo = c.querySelector("#r-ativo").checked;

      if (!nome || !codigo) {
        toast("Nome e codigo sao obrigatorios.", "err");
        return false;
      }
      const dup = indicadores.find((x) => x.codigo === codigo && x.id !== r?.id);
      if (dup) {
        toast(`Codigo "${codigo}" ja e do indicador ${dup.nome}.`, "err");
        return false;
      }

      const dados = { nome, codigo, contato, ativo, atualizadoEm: serverTimestamp(), atualizadoPor: perfil.id };
      if (r) await updateDoc(doc(db, "indicadores", r.id), dados);
      else await addDoc(collection(db, "indicadores"), { ...dados, criadoEm: serverTimestamp() });
      toast("Indicador salvo.", "ok");
      carregar();
    },
  });

  if (r)
    c.querySelector("#r-del").onclick = async () => {
      if (!(await confirmar(`Excluir "${r.nome}"? Os pedidos ja atribuidos continuam no historico.`))) return;
      await deleteDoc(doc(db, "indicadores", r.id));
      bg.remove();
      toast("Indicador excluido.", "ok");
      carregar();
    };
}

// Perfil do indicador: vendas/comissao apurada num periodo escolhido (a
// comissao em si e repassada manualmente, fora do sistema, uma vez por mes
// — este numero e so a base de calculo) + uma caixa de anotacoes internas
// persistida em indicadores/{id}.anotacoes.
function verPerfil(r) {
  const v = vendidoPorCodigo[r.codigo] || { qtd: 0, total: 0 };
  const c = document.createElement("div");
  c.innerHTML = `
    <p class="muted">Codigo <code>${escapeHtml(r.codigo || "")}</code>
      ${r.contato ? `&middot; ${escapeHtml(r.contato)}` : ""}
      &middot; <span class="tag ${r.ativo === false ? "inativo" : "ativo"}">${r.ativo === false ? "inativo" : "ativo"}</span></p>

    <div class="row" style="align-items:end">
      <div><label>Periodo</label><input type="month" id="pf-periodo" value="${periodo}"></div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="pf-ver">Ver periodo</button></div>
    </div>
    <div id="pf-stats" style="margin-top:10px">Apurando...</div>

    <div class="totais big" style="margin-top:10px">
      <span>Total vendido (historico completo)</span><span>${brl(v.total)}</span>
    </div>
    <p class="muted">${v.qtd} venda(s) no historico (pedidos pagos do site + vendas do PDV). A comissao e repassada manualmente, uma vez por mes.</p>

    <label style="margin-top:14px">Anotacoes</label>
    <textarea id="pf-anotacoes" rows="4" placeholder="Anotacoes internas sobre este indicador (combinados, historico de pagamento, etc.)">${escapeHtml(r.anotacoes || "")}</textarea>`;

  const bg = modal({
    titulo: `Perfil — ${r.nome || r.codigo}`,
    corpo: c,
    textoConfirmar: "Salvar anotacoes",
    textoCancelar: "Fechar",
    onConfirmar: async () => {
      const anotacoes = c.querySelector("#pf-anotacoes").value.trim();
      await updateDoc(doc(db, "indicadores", r.id), {
        anotacoes,
        atualizadoEm: serverTimestamp(),
        atualizadoPor: perfil.id,
      });
      r.anotacoes = anotacoes;
      toast("Anotacoes salvas.", "ok");
    },
  });

  async function apurarPeriodoPerfil() {
    const stats = c.querySelector("#pf-stats");
    stats.innerHTML = "Apurando...";
    const per = c.querySelector("#pf-periodo").value || periodo;
    try {
      const { inicio, fim } = periodoParaIntervalo(per);
      const [todosDoPeriodo, produtosMap, camadaPrincipalSlug, vendasPdv] = await Promise.all([
        pedidosDoPeriodo(per),
        mapaDoCatalogo(),
        getCamadaPrincipalSlug(),
        vendasPdvComIndicador(),
      ]);
      const pedidos = todosDoPeriodo.filter((p) => p.ref === r.codigo && contaComoPago(p.status));
      const vendasDoIndicador = noPeriodo(vendasPdv, inicio, fim).filter((v) => v.ref === r.codigo);

      let qtd = 0;
      let base = 0;
      for (const p of pedidos) {
        qtd++;
        base = round2(base + baseElegivelIndicador(p, produtosMap, { camadaPrincipalSlug, excluirSlugs }).base);
      }
      for (const v of vendasDoIndicador) {
        qtd++;
        base = round2(base + baseElegivelIndicadorVenda(v, produtosMap, { camadaPrincipalSlug, excluirSlugs }).base);
      }
      const comissao = round2(base * pct / 100);

      stats.innerHTML = `
        <div class="totais"><span>Vendas no periodo (site ${pedidos.length} + loja ${vendasDoIndicador.length})</span><span>${qtd}</span></div>
        <div class="totais"><span>Base elegivel (sem iPhone)</span><span>${brl(base)}</span></div>
        <div class="totais big"><span>Comissao a receber (${pct}%)</span><span>${brl(comissao)}</span></div>`;
    } catch (e) {
      stats.innerHTML = `<p style="color:var(--warn)">Nao foi possivel apurar (${escapeHtml(e?.message || "")}).</p>`;
    }
  }

  c.querySelector("#pf-ver").onclick = apurarPeriodoPerfil;
  apurarPeriodoPerfil();
}

async function apurar() {
  const box = document.getElementById("apuracao");
  box.innerHTML = `<p class="muted">Apurando...</p>`;

  const { inicio, fim } = periodoParaIntervalo(periodo);
  let pedidos, produtosMap, camadaPrincipalSlug, vendasPdv;
  try {
    [pedidos, produtosMap, camadaPrincipalSlug, vendasPdv] = await Promise.all([
      pedidosDoPeriodo(periodo, { fresco: true }),
      mapaDoCatalogo(),
      getCamadaPrincipalSlug(),
      vendasPdvComIndicador(),
    ]);
  } catch (e) {
    box.innerHTML = `<p style="color:var(--warn)">Nao foi possivel apurar (${escapeHtml(e?.message || "")}).</p>`;
    return;
  }

  const nomePorCodigo = Object.fromEntries(indicadores.map((r) => [r.codigo, r]));

  // Lista venda por venda (nao agregado por indicador) — o resumo por
  // indicador fica so no "Perfil" de cada um (botao na tabela acima).
  const opcoesBase = { camadaPrincipalSlug, excluirSlugs };
  const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);
  const doSite = pedidos
    .filter((p) => p.ref && contaComoPago(p.status))
    .map((p) => ({
      data: p.criadoEm, ref: p.ref, origem: "Site",
      idHtml: `<code title="id: ${escapeHtml(p.id)}">${codigoRetirada(p.id)}</code>`,
      base: baseElegivelIndicador(p, produtosMap, opcoesBase).base,
    }));
  const daLoja = noPeriodo(vendasPdv, inicio, fim).map((v) => ({
    data: v.data, ref: v.ref, origem: "Loja",
    idHtml: `Venda #${escapeHtml(String(v.numero ?? "-"))}`,
    base: baseElegivelIndicadorVenda(v, produtosMap, opcoesBase).base,
  }));
  const comRef = [...doSite, ...daLoja]
    .map((l) => ({ ...l, comissao: round2(l.base * pct / 100) }))
    .sort((a, b) => millis(b.data) - millis(a.data));

  const linhas = comRef
    .map((l) => {
      const rev = nomePorCodigo[l.ref];
      return `<tr>
        <td>${fmtData(l.data)}</td>
        <td>${escapeHtml(rev?.nome || `(codigo ${escapeHtml(String(l.ref))} sem cadastro)`)}</td>
        <td><code>${escapeHtml(String(l.ref))}</code></td>
        <td>${l.origem}</td>
        <td>${l.idHtml}</td>
        <td class="right">${brl(l.base)}</td>
        <td class="right">${brl(l.comissao)}</td>
      </tr>`;
    })
    .join("");

  const totBase = round2(comRef.reduce((s, l) => s + l.base, 0));
  const totCom = round2(comRef.reduce((s, l) => s + l.comissao, 0));

  box.innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th>Data</th><th>Indicador</th><th>Codigo</th><th>Origem</th><th>Pedido / venda</th>
        <th class="right">Base elegivel</th><th class="right">Comissao (${pct}%)</th>
      </tr></thead>
      <tbody>
        ${linhas || `<tr><td colspan="7" class="muted">Sem vendas com indicador no periodo.</td></tr>`}
        ${linhas ? `<tr><td colspan="5"><strong>TOTAL (${comRef.length})</strong></td><td class="right"><strong>${brl(totBase)}</strong></td><td class="right"><strong>${brl(totCom)}</strong></td></tr>` : ""}
      </tbody>
    </table></div>
    <p class="muted">Site: total derivado dos precos atuais do catalogo (pedido do site nao guarda valor). Loja: valor cobrado na venda do PDV, com o desconto repartido. iPhone fica fora da base nos dois. Pagamento manual. Resumo por indicador no "Perfil" (clique no nome, na tabela acima).</p>`;
}
