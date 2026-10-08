import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml } from "../ui.js";
import {
  db, collection, getDocs, getDoc, query,
  doc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, getConfigSistema,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";
import { infoPreco, estoquePorModo, filtrosDoProduto } from "../produtos-schema.js";
import { listarCamadas, camadaPrincipal } from "../camadas.js";
import { lerCustos, salvarCusto, removerCusto } from "../custos.js";
import { invalidarCatalogo } from "../catalogo-cache.js";
import { enviarFotoProduto, miniatura } from "../imagem-upload.js";
import { configPointEfetiva, storageSeguro } from "../point.js";
import { calcularMontante, custoUnitario } from "../montante-estoque.js";

// Editor completo — grava na MESMA colecao `produtos` do site, no mesmo
// formato do admin do site (frontend/src/pages/admin/js/admin-produtos.js):
// precoVarejo/precoAtacado (dois valores), estoque (um so, compartilhado
// entre varejo e atacado), filtros{} por camada, categoria (legado = 1a
// opcao da camada principal), desconto opcional.
// Foto: upload direto para o ImageKit (mesma conta do site) — o produto
// guarda so a URL. Sem ImageKit configurado na API, cai na data URI antiga.
// Ver ../imagem-upload.js.
//
// Custo: fica FORA do produto (produtos e publico), em custos/produtos — so
// admin le. Ver ../custos.js. O topo da tela mostra o montante do estoque a
// preco de venda e a preco de custo.
//
// LEITURAS: o catalogo e lido UMA vez ao abrir a tela (sempre do servidor —
// esta e a tela que edita). Salvar/excluir/acao em massa atualiza a lista
// em memoria em vez de reler os ~200 produtos.

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "produtos" });

let produtos = [];
let camadas = [];
let camadaPrincipalSlug = null;
let custos = {};          // produtoId -> custo unitario
let custosOk = true;      // false = nao deu pra ler custos/produtos

// Base da API na Vercel (a mesma da maquininha) — so lida quando a pessoa
// envia uma foto, para nao gastar leitura a toa ao abrir a tela.
let apiBasePromessa = null;
function apiBase() {
  apiBasePromessa ||= getConfigSistema()
    .then((cfg) => configPointEfetiva(cfg.point, storageSeguro()).api_url || "")
    .catch(() => "");
  return apiBasePromessa;
}

root.innerHTML = `
  <div class="card">
    <div class="row">
      <input id="busca" placeholder="Buscar por nome, SKU ou codigo de barras">
      <select id="fativo">
        <option value="">Todos</option>
        <option value="sim">Ativos</option>
        <option value="nao">Inativos</option>
      </select>
      <button class="btn" id="novo">+ Produto</button>
    </div>
  </div>
  <div class="card">
    <div class="row" style="align-items:center">
      <span class="muted" style="flex:0 0 auto">Acao em massa (selecionados):</span>
      <button class="btn sec" id="ativar" style="flex:0 0 auto">Ativar</button>
      <button class="btn sec" id="inativar" style="flex:0 0 auto">Inativar</button>
    </div>
  </div>
  <div id="montante" style="margin-bottom:18px"></div>
  <div class="card"><div id="tabela">Carregando...</div></div>`;

document.getElementById("busca").oninput = renderTabela;
document.getElementById("fativo").onchange = renderTabela;
document.getElementById("novo").onclick = () => editar(null);
document.getElementById("ativar").onclick = () => aplicarMassa(true);
document.getElementById("inativar").onclick = () => aplicarMassa(false);

await carregar();

async function carregar() {
  let custosLidos;
  [camadas, produtos, custosLidos] = await Promise.all([
    listarCamadas().catch(() => []),
    getDocs(query(collection(db, "produtos"))).then((s) =>
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
    ),
    lerCustos().catch((e) => { console.error("Custos indisponiveis:", e); return null; }),
  ]);
  custosOk = custosLidos !== null;
  custos = custosLidos || {};
  camadaPrincipalSlug = camadaPrincipal(camadas)?.slug || null;
  ordenar();
  renderTabela();
}

function ordenar() {
  produtos.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
}

function custoDe(p) {
  return custoUnitario(custos, p.id);
}

// ── Montante do estoque ─────────────────────────────────────────────────
// Soma do que esta parado em estoque, dos produtos LISTADOS (respeita a
// busca e o filtro de ativo — sem filtro, e o estoque inteiro). Estoque
// negativo/zerado nao entra.
function renderMontante(lista) {
  const m = calcularMontante(lista, custos);
  const { unidades, semCusto } = m;
  const comEstoque = m.produtosComEstoque, venda = m.valorVenda, custo = m.valorCusto, lucro = m.lucroPotencial;
  const filtrado = (document.getElementById("busca").value || "").trim() || document.getElementById("fativo").value;

  const kpi = (rotulo, valor, nota = "") =>
    `<div class="card kpi"><div class="l">${rotulo}</div><div class="n">${valor}</div>${nota ? `<div class="muted" style="font-size:12px;margin-top:4px">${nota}</div>` : ""}</div>`;

  document.getElementById("montante").innerHTML = `
    <strong style="display:block;margin-bottom:8px">Montante em estoque${filtrado ? " &mdash; produtos listados" : ""}</strong>
    <div class="grid cols-4">
      ${kpi("Unidades em estoque", unidades.toLocaleString("pt-BR"), `${comEstoque} produto(s)`)}
      ${kpi("A preco de venda", brl(venda))}
      ${kpi("A preco de custo", custosOk ? brl(custo) : "&mdash;",
        custosOk && semCusto ? `<span style="color:var(--warn)">${semCusto} produto(s) com estoque sem custo</span>` : "")}
      ${kpi("Lucro bruto potencial", custosOk ? brl(lucro) : "&mdash;", "so produtos com custo cadastrado")}
    </div>
    ${custosOk ? "" : `<p style="color:var(--warn);margin:0">Nao foi possivel ler os custos (so administradores tem acesso).</p>`}`;
}

function rotuloPrincipal(p) {
  const slugs = camadaPrincipalSlug ? (filtrosDoProduto(p, camadaPrincipalSlug)[camadaPrincipalSlug] || []) : [];
  const principal = camadaPrincipal(camadas);
  if (!principal || slugs.length === 0) return "";
  return slugs.map((s) => principal.opcoes.find((o) => o.slug === s)?.nome || s).join(", ");
}

function renderTabela() {
  const termo = (document.getElementById("busca").value || "").toLowerCase().trim();
  const fativo = document.getElementById("fativo").value;
  const lista = produtos.filter((p) => {
    if (termo &&
      !(p.nome || "").toLowerCase().includes(termo) &&
      !(p.sku || "").toLowerCase().includes(termo) &&
      !(p.codigoBarras || "").toLowerCase().includes(termo)) return false;
    if (fativo === "sim" && p.ativo === false) return false;
    if (fativo === "nao" && p.ativo !== false) return false;
    return true;
  });
  renderMontante(lista);

  document.getElementById("tabela").innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th><input type="checkbox" id="chk-all" style="width:auto"></th>
        <th>Nome</th><th>Cod. barras</th><th>${escapeHtml(camadaPrincipal(camadas)?.nome || "Filtro")}</th>
        <th class="right">Varejo</th><th class="right">Custo</th><th class="right">Estoque</th>
        <th>Ativo</th><th></th>
      </tr></thead>
      <tbody>
        ${
          lista
            .map(
              (p) => `<tr>
                <td><input type="checkbox" class="chk" data-id="${p.id}" style="width:auto"></td>
                <td>${escapeHtml(p.nome || "")}</td>
                <td>${escapeHtml(p.codigoBarras || "")}</td>
                <td>${escapeHtml(rotuloPrincipal(p))}</td>
                <td class="right">${brl(infoPreco(p, "varejo").precoFinal)}</td>
                <td class="right">${custoDe(p) === null ? `<span class="muted">-</span>` : brl(custoDe(p))}</td>
                <td class="right">${estoquePorModo(p)}</td>
                <td><span class="tag ${p.ativo === false ? "inativo" : "ativo"}">${p.ativo === false ? "inativo" : "ativo"}</span></td>
                <td class="right"><button class="btn ghost editar" data-id="${p.id}">Editar</button></td>
              </tr>`
            )
            .join("") || `<tr><td colspan="9" class="muted">Nenhum produto.</td></tr>`
        }
      </tbody>
    </table></div>`;

  document.querySelectorAll(".editar").forEach(
    (b) => (b.onclick = () => editar(produtos.find((p) => p.id === b.dataset.id)))
  );
  const all = document.getElementById("chk-all");
  if (all) all.onchange = (e) =>
    document.querySelectorAll(".chk").forEach((c) => (c.checked = e.target.checked));
}

function editar(p) {
  let imagemAtual = p?.imagemURL || "";
  const camadasHtml = camadas.length
    ? camadas
        .map((cam, i) => {
          const marcadas = filtrosDoProduto(p || {}, camadaPrincipalSlug)[cam.slug] || [];
          return `<fieldset style="border:1px solid var(--linha,#ddd);border-radius:8px;padding:8px;margin:6px 0">
            <legend>${escapeHtml(cam.nome)}${i === 0 ? " <span class='tag ativo'>principal</span>" : ""}</legend>
            ${
              cam.opcoes.length
                ? cam.opcoes
                    .map(
                      (op) => `<label style="text-transform:none;display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0">
                        <input type="checkbox" data-camada="${escapeHtml(cam.slug)}" value="${escapeHtml(op.slug)}" ${marcadas.includes(op.slug) ? "checked" : ""} style="width:auto">
                        ${escapeHtml(op.nome)}</label>`
                    )
                    .join("")
                : `<span class="muted">Sem opcoes nesta camada.</span>`
            }
          </fieldset>`;
        })
        .join("")
    : `<p style="color:var(--warn)">As camadas de filtro nao carregaram. Voce ainda pode editar nome, preco, estoque e foto &mdash; a classificacao atual do produto (categoria/filtros) sera <strong>preservada</strong>. Cadastre/ajuste as camadas em "Camadas de filtro" no admin do site.</p>`;

  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="f-nome" value="${escapeHtml(p?.nome || "")}">
    <label>Codigo de barras (EAN) &mdash; obrigatorio</label>
    <input id="f-ean" inputmode="numeric" value="${escapeHtml(p?.codigoBarras || "")}" placeholder="Bipe o produto ou digite o EAN">
    <label>Descricao</label><textarea id="f-desc" rows="2">${escapeHtml(p?.descricao || "")}</textarea>
    <label>Foto do produto</label>
    <div class="row" style="align-items:center;gap:10px">
      <div id="f-img-preview" style="width:72px;height:72px;flex:0 0 auto;border-radius:8px;border:1px solid var(--linha,#ddd);background:#fff center/contain no-repeat"></div>
      <label class="btn sec" style="flex:0 0 auto;cursor:pointer">
        <span id="f-img-txt">Escolher foto</span>
        <input type="file" id="f-img" accept="image/*" hidden>
      </label>
      <button type="button" class="btn ghost" id="f-img-rm" style="flex:0 0 auto">Remover</button>
    </div>
    <p class="muted" id="f-img-msg" style="margin:4px 0 0">A foto e enviada para o ImageKit (a mesma hospedagem do site).</p>
    <div class="row">
      <div><label>Preco varejo</label><input id="f-pv" value="${p?.precoVarejo ?? ""}"></div>
      <div><label>Preco atacado</label><input id="f-pa" value="${p?.precoAtacado ?? ""}"></div>
      <div><label>Peso (g)</label><input id="f-peso" type="number" value="${p?.peso ?? 0}"></div>
    </div>
    <div class="row">
      <div><label>Estoque</label><input id="f-est" type="number" value="${p ? estoquePorModo(p) : 0}"></div>
      <div><label>Preco de custo (so admin ve)</label><input id="f-custo" value="${p && custoDe(p) !== null ? custoDe(p) : ""}" placeholder="opcional" ${custosOk ? "" : "disabled"}></div>
    </div>
    <label>Camadas de filtro</label>
    ${camadasHtml}
    <div class="row">
      <label style="text-transform:none"><input type="checkbox" id="f-ativo" ${p?.ativo === false ? "" : "checked"} style="width:auto"> Ativo (visivel na loja)</label>
      <label style="text-transform:none"><input type="checkbox" id="f-destaque" ${p?.destaque === true ? "checked" : ""} style="width:auto"> Destaque na home</label>
      <label style="text-transform:none"><input type="checkbox" id="f-frete" ${p?.freteDisponivel === false ? "" : "checked"} style="width:auto"> Tem entrega</label>
    </div>
    <div class="row">
      <label style="text-transform:none"><input type="checkbox" id="f-desc-on" ${p?.descontoAtivo === true ? "checked" : ""} style="width:auto"> Desconto ativo</label>
      <div><label>Desconto (%) 1&ndash;90</label><input id="f-desc-pct" value="${p?.descontoPercentual ?? ""}"></div>
    </div>
    ${p ? `<button class="btn danger" id="f-del" style="margin-top:14px">Excluir produto</button>` : ""}`;

  // Foto: `imagemAtual` guarda o valor corrente (URL do ImageKit, ou data URI
  // legado/reserva); so muda quando a pessoa escolhe/remove.
  const imgInput = c.querySelector("#f-img");
  const imgPreview = c.querySelector("#f-img-preview");
  const imgTxt = c.querySelector("#f-img-txt");
  const imgRm = c.querySelector("#f-img-rm");
  const imgMsg = c.querySelector("#f-img-msg");

  function pintarPreview() {
    imgPreview.style.backgroundImage = imagemAtual ? `url("${miniatura(imagemAtual, 160)}")` : "";
    imgTxt.textContent = imagemAtual ? "Trocar foto" : "Escolher foto";
    imgRm.style.display = imagemAtual ? "" : "none";
  }
  pintarPreview();

  imgInput.onchange = async () => {
    const arq = imgInput.files && imgInput.files[0];
    if (!arq) return;
    imgTxt.textContent = "Enviando...";
    imgMsg.textContent = "Enviando a foto...";
    try {
      const { valor, modo } = await enviarFotoProduto(arq, { apiBase: await apiBase() });
      imagemAtual = valor;
      imgMsg.textContent = modo === "imagekit"
        ? "Foto enviada. Ela vale depois de salvar o produto."
        : `ImageKit indisponivel — foto salva no modo antigo (${Math.round(valor.length / 1024)} KB).`;
    } catch (e) {
      imgMsg.textContent = e.message || "Nao foi possivel processar a imagem.";
    } finally {
      imgInput.value = "";
      pintarPreview();
    }
  };
  imgRm.onclick = () => { imagemAtual = ""; imgMsg.textContent = "Sem foto."; pintarPreview(); };

  const bg = modal({
    titulo: p ? "Editar produto" : "Novo produto",
    corpo: c,
    onConfirmar: async () => {
      const filtros = {};
      c.querySelectorAll('input[type="checkbox"][data-camada]:checked').forEach((cb) => {
        (filtros[cb.dataset.camada] ||= []).push(cb.value);
      });
      const categoriaLegado = (camadaPrincipalSlug && filtros[camadaPrincipalSlug]?.[0]) || "";

      const descontoAtivo = c.querySelector("#f-desc-on").checked;
      const descontoPercentual = parseNum(c.querySelector("#f-desc-pct").value);
      const precoVarejo = parseNum(c.querySelector("#f-pv").value);
      const custoTxt = c.querySelector("#f-custo").value.trim();
      const custoNovo = custoTxt ? parseNum(custoTxt) : null;
      const estoqueNovo = Math.trunc(parseNum(c.querySelector("#f-est").value));
      // Estoque so vai no update se a pessoa MUDOU o numero: a tela pode
      // estar aberta ha horas, e regravar o valor antigo apagaria as baixas
      // feitas pelo PDV/site nesse meio tempo.
      const mexeuEstoque = !p || estoqueNovo !== estoquePorModo(p);
      const precoAtacado = parseNum(c.querySelector("#f-pa").value);

      // Se as camadas nao carregaram, um produto existente NAO tem a
      // classificacao mexida (evita zerar filtros/categoria no site num save
      // que so queria trocar preco/estoque/foto). Produto novo entra sem
      // classificacao mesmo — o admin ajusta depois no site.
      const semCamadas = camadas.length === 0;
      const dados = {
        nome: c.querySelector("#f-nome").value.trim(),
        codigoBarras: c.querySelector("#f-ean").value.trim(),
        descricao: c.querySelector("#f-desc").value.trim(),
        imagemURL: imagemAtual,
        ...(semCamadas
          ? (p ? {} : { filtros: {}, categoria: "" })
          : { filtros, categoria: categoriaLegado }),
        peso: Math.trunc(parseNum(c.querySelector("#f-peso").value)),
        precoVarejo,
        precoAtacado: precoAtacado > 0 ? precoAtacado : null,
        ...(mexeuEstoque ? { estoque: estoqueNovo } : {}),
        descontoAtivo,
        descontoTipo: descontoAtivo ? "percentual" : null,
        descontoPercentual: descontoAtivo ? descontoPercentual : null,
        freteDisponivel: c.querySelector("#f-frete").checked,
        ativo: c.querySelector("#f-ativo").checked,
        destaque: c.querySelector("#f-destaque").checked,
        atualizadoEm: serverTimestamp(),
      };

      if (!dados.nome) { toast("Nome e obrigatorio.", "err"); return false; }
      if (!/^\d{8,14}$/.test(dados.codigoBarras)) {
        toast("Codigo de barras (EAN) obrigatorio: 8 a 14 digitos.", "err"); return false;
      }
      const dup = produtos.find((x) => (x.codigoBarras || "") === dados.codigoBarras && x.id !== p?.id);
      if (dup) { toast(`Codigo de barras ja usado por "${dup.nome}".`, "err"); return false; }
      if (camadaPrincipalSlug && !(filtros[camadaPrincipalSlug]?.length)) {
        toast("Marque ao menos uma opcao na camada principal.", "err"); return false;
      }
      if ((dados.precoVarejo || 0) <= 0 && (dados.precoAtacado || 0) <= 0) {
        toast("Configure pelo menos preco de varejo e/ou de atacado.", "err"); return false;
      }
      if (descontoAtivo && (descontoPercentual < 1 || descontoPercentual > 90)) {
        toast("Desconto deve ser um percentual entre 1 e 90.", "err"); return false;
      }
      if (custoNovo !== null && !(custoNovo >= 0)) {
        toast("Preco de custo invalido.", "err"); return false;
      }

      let id = p?.id;
      if (p) {
        await updateDoc(doc(db, "produtos", p.id), dados);
      } else {
        const ref = await addDoc(collection(db, "produtos"), {
          ...dados,
          imagensExtras: [],
          criadoEm: serverTimestamp(),
        });
        id = ref.id;
      }
      if (custosOk && (custoNovo ?? null) !== custoDe(p || { id })) {
        try {
          await salvarCusto(id, custoNovo);
          if (custoNovo > 0) custos[id] = round2(custoNovo); else delete custos[id];
        } catch (e) {
          toast("Produto salvo, mas o custo nao foi gravado: " + (e?.message || ""), "warn");
        }
      }
      invalidarCatalogo();
      // Uma leitura (o produto salvo) em vez de reler o catalogo inteiro.
      await atualizarNaLista(id);
      toast("Produto salvo.", "ok");
    },
  });

  if (p)
    c.querySelector("#f-del").onclick = async () => {
      if (!(await confirmar(`Excluir "${p.nome}"? Esta acao nao pode ser desfeita.`))) return;
      await deleteDoc(doc(db, "produtos", p.id));
      if (custoDe(p) !== null) await removerCusto(p.id).catch(() => {});
      delete custos[p.id];
      produtos = produtos.filter((x) => x.id !== p.id);
      invalidarCatalogo();
      bg.remove();
      toast("Produto excluido.", "ok");
      renderTabela();
    };
}

async function aplicarMassa(ativo) {
  const ids = [...document.querySelectorAll(".chk:checked")].map((c) => c.dataset.id);
  if (!ids.length) return toast("Selecione ao menos um produto.", "warn");
  if (!(await confirmar(`${ativo ? "Ativar" : "Inativar"} ${ids.length} produto(s)?`))) return;
  const batch = writeBatch(db);
  ids.forEach((id) => batch.update(doc(db, "produtos", id), { ativo, atualizadoEm: serverTimestamp() }));
  await batch.commit();
  const marcados = new Set(ids);
  produtos.forEach((p) => { if (marcados.has(p.id)) p.ativo = ativo; });
  invalidarCatalogo();
  toast("Feito.", "ok");
  renderTabela();
}

// Relê SO o produto salvo e troca na lista em memoria.
async function atualizarNaLista(id) {
  try {
    const snap = await getDoc(doc(db, "produtos", id));
    produtos = produtos.filter((x) => x.id !== id);
    if (snap.exists()) produtos.push({ id: snap.id, ...snap.data() });
    ordenar();
    renderTabela();
  } catch (_) {
    await carregar(); // sem conseguir reler o item, recarrega tudo
  }
}
