import { requireAuth } from "../auth.js";
import { initShell, toast, confirmar, escapeHtml, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where,
  doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp,
  periodoParaIntervalo,
} from "../db.js";
import { brl, round2 } from "../money.js";

const { perfil } = await requireAuth();
const ehAdm = perfil.role === "admin";
const root = initShell({ perfil, active: "comissoes" });

const agora = new Date();
let periodo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;

// mapa uid -> nome
const vendedores = {};
if (ehAdm) {
  // So a equipe: `usuarios` tambem guarda TODOS os clientes do site, e ler
  // a colecao inteira so para achar os vendedores crescia com a loja.
  (await getDocs(query(collection(db, "usuarios"), where("role", "in", ["admin", "vendedor"]))))
    .forEach((d) => (vendedores[d.id] = d.data().nome || d.id));
} else {
  vendedores[perfil.id] = perfil.nome || perfil.id;
}

root.innerHTML = `
  <div class="card">
    <div class="row">
      <div><label>Periodo</label><input type="month" id="periodo" value="${periodo}"></div>
      <div style="align-self:end"><button class="btn" id="buscar">Buscar</button></div>
    </div>
  </div>
  <div id="res"><div class="card">Carregando...</div></div>`;

document.getElementById("buscar").onclick = () => {
  periodo = document.getElementById("periodo").value || periodo;
  carregar();
};

carregar();

async function carregar() {
  const res = document.getElementById("res");
  res.innerHTML = `<div class="card">Carregando...</div>`;
  try {
  const { inicio, fim } = periodoParaIntervalo(periodo);
  const ini = Timestamp.fromDate(inicio);
  const f = Timestamp.fromDate(fim);

  let vendas;
  if (ehAdm) {
    vendas = (await getDocs(query(
      collection(db, "vendas"),
      where("canal", "==", "loja"),
      where("status", "==", "concluida"),
      where("data", ">=", ini),
      where("data", "<", f)
    ))).docs.map((d) => d.data());
  } else {
    vendas = (await getDocs(query(
      collection(db, "vendas"),
      where("vendedor_uid", "==", perfil.id),
      where("data", ">=", ini),
      where("data", "<", f)
    ))).docs
      .map((d) => d.data())
      .filter((v) => v.canal === "loja" && v.status === "concluida");
  }

  const agg = {};
  vendas.forEach((v) => {
    const uid = v.vendedor_uid || "sem_vendedor";
    const a = agg[uid] || (agg[uid] = { qtd: 0, vendas: 0, comissao: 0 });
    a.qtd++;
    a.vendas = round2(a.vendas + (v.total || 0));
    a.comissao = round2(a.comissao + (v.comissao?.valor || 0));
  });

  // status de fechamento
  const fechInfo = {};
  if (ehAdm) {
    (await getDocs(collection(db, "comissoes", periodo, "vendedores"))).forEach(
      (d) => (fechInfo[d.id] = d.data())
    );
  } else {
    const d = await getDoc(doc(db, "comissoes", periodo, "vendedores", perfil.id));
    if (d.exists()) fechInfo[perfil.id] = d.data();
  }

  const linhas = Object.entries(agg)
    .sort((a, b) => (vendedores[a[0]] || a[0]).localeCompare(vendedores[b[0]] || b[0]))
    .map(([uid, a]) => {
      const st = fechInfo[uid]?.status;
      return `<tr>
        <td>${escapeHtml(vendedores[uid] || uid)}</td>
        <td class="right">${a.qtd}</td>
        <td class="right">${brl(a.vendas)}</td>
        <td class="right">${brl(a.comissao)}</td>
        <td>${st ? `<span class="tag ${st === "pago" ? "ativo" : "sem_estoque"}">${st}</span>` : `<span class="muted">aberto</span>`}</td>
        ${
          ehAdm
            ? `<td class="right">
                <button class="btn ghost fechar" data-uid="${uid}" data-v="${a.vendas}" data-c="${a.comissao}" data-q="${a.qtd}">Fechar</button>
                <button class="btn ghost pago" data-uid="${uid}">Pago</button>
              </td>`
            : ""
        }
      </tr>`;
    })
    .join("");

  res.innerHTML = `
    <div class="card">
      <strong>Comissoes &mdash; ${periodo}</strong>
      <p class="muted">Considera apenas vendas da loja fisica concluidas. A base pode variar por vendedor.</p>
      <div class="tabela-wrap"><table>
        <thead><tr>
          <th>Vendedor</th><th class="right">Qtd</th><th class="right">Total vendas</th><th class="right">Comissao</th><th>Situacao</th>
          ${ehAdm ? "<th></th>" : ""}
        </tr></thead>
        <tbody>${linhas || `<tr><td class="muted">Sem vendas no periodo.</td></tr>`}</tbody>
      </table></div>
    </div>`;

  if (ehAdm) {
    res.querySelectorAll(".fechar").forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmar(`Fechar comissao de ${vendedores[b.dataset.uid] || b.dataset.uid} em ${periodo}?`)))
          return;
        await setDoc(doc(db, "comissoes", periodo), { periodo, atualizado_em: serverTimestamp() }, { merge: true });
        await setDoc(
          doc(db, "comissoes", periodo, "vendedores", b.dataset.uid),
          {
            total_vendas: +b.dataset.v,
            total_comissao: +b.dataset.c,
            qtd_vendas: +b.dataset.q,
            status: "fechado",
            fechado_em: serverTimestamp(),
          },
          { merge: true }
        );
        toast("Periodo fechado para o vendedor.", "ok");
        carregar();
      };
    });
    res.querySelectorAll(".pago").forEach((b) => {
      b.onclick = async () => {
        try {
          await updateDoc(doc(db, "comissoes", periodo, "vendedores", b.dataset.uid), {
            status: "pago",
            pago_em: serverTimestamp(),
          });
          toast("Marcado como pago.", "ok");
          carregar();
        } catch (_) {
          toast("Feche o periodo antes de marcar como pago.", "warn");
        }
      };
    });
  }
  } catch (e) {
    erroCard(res, e, carregar);
  }
}
