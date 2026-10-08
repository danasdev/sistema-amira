// ── Foto de produto: ImageKit (com reserva em base64) ──────────────────
// As fotos dos produtos moram no ImageKit, na mesma conta do site: o
// documento do produto guarda só a URL (https://ik.imagekit.io/...). Antes a
// foto era gravada em base64 DENTRO do produto, e cada produto pesava
// ~90 KB em toda leitura — no site e aqui. Ver docs/IMAGENS_IMAGEKIT.md no
// repo do site.
//
// Fluxo: reduz a foto num <canvas> → pede a assinatura a POST
// {apiBase}/api/imagekit-auth (só admin) → envia direto ao ImageKit →
// devolve a URL. `apiBase` é a mesma API da Vercel usada pela maquininha
// (config.point.api_url; "" = mesma origem).
//
// RESERVA: se a API não tiver o ImageKit configurado (503 naoConfigurado)
// ou não existir (404), a foto volta a ser data URI comprimida, como antes —
// o cadastro nunca trava por causa disso.

import { auth } from "./firebase.js";

const URL_UPLOAD_IMAGEKIT = "https://upload.imagekit.io/api/v1/files/upload";
const LADO_ENVIO = 1600;
const QUALIDADE_ENVIO = 0.86;
const ALVO_BYTES_RESERVA = 300 * 1024;

let imagekitIndisponivel = false;

function lerArquivoComoDataURL(arquivo) {
  return new Promise((resolve, reject) => {
    if (!arquivo || !arquivo.type.startsWith("image/")) {
      reject(new Error("Escolha um arquivo de imagem (JPG, PNG, WEBP...)."));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
    fr.readAsDataURL(arquivo);
  });
}

function desenharReduzida(dataURL, maxLado) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const maior = Math.max(width, height);
      if (maior > maxLado) {
        const escala = maxLado / maior;
        width = Math.round(width * escala);
        height = Math.round(height * escala);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // PNG transparente -> JPEG com fundo branco
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("Imagem invalida ou corrompida."));
    img.src = dataURL;
  });
}

// Modo antigo (reserva): data URI que cabe no limite de 1 MB do documento.
async function comprimirComoDataURI(bruto) {
  const tentativas = [[1100, 0.72], [950, 0.62], [800, 0.55], [640, 0.5]];
  let saida = "";
  for (const [lado, q] of tentativas) {
    saida = (await desenharReduzida(bruto, lado)).toDataURL("image/jpeg", q);
    if (saida.length <= ALVO_BYTES_RESERVA * 1.37) break; // 1.37 ~= overhead do base64
  }
  return saida;
}

async function assinatura(apiBase) {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error("Entre no sistema de novo para enviar fotos.");
  const base = String(apiBase || "").replace(/\/+$/, "");
  let resp;
  try {
    resp = await fetch(`${base}/api/imagekit-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await usuario.getIdToken()}` },
      body: "{}"
    });
  } catch (_) {
    return null; // API fora do ar / sem CORS: cai na reserva
  }
  let corpo = {};
  try { corpo = await resp.json(); } catch (_) { /* sem JSON */ }
  if ((resp.status === 503 && corpo.naoConfigurado) || resp.status === 404) return null;
  if (!resp.ok) throw new Error(corpo.erro || "Nao foi possivel autorizar o envio da foto.");
  return corpo;
}

/**
 * Prepara a foto escolhida e devolve o valor para `imagemURL`.
 * @param {File} arquivo
 * @param {{ apiBase?: string }} [opcoes]
 * @returns {Promise<{ valor: string, modo: "imagekit" | "base64" }>}
 */
export async function enviarFotoProduto(arquivo, { apiBase = "" } = {}) {
  const bruto = await lerArquivoComoDataURL(arquivo);

  const ass = imagekitIndisponivel ? null : await assinatura(apiBase);
  if (!ass) {
    if (!imagekitIndisponivel) console.warn("[sistema] ImageKit indisponivel — foto salva em base64 (modo antigo).");
    imagekitIndisponivel = true;
    return { valor: await comprimirComoDataURI(bruto), modo: "base64" };
  }

  const canvas = await desenharReduzida(bruto, LADO_ENVIO);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Nao foi possivel processar a imagem."))), "image/jpeg", QUALIDADE_ENVIO)
  );

  const form = new FormData();
  form.append("file", blob, "produto.jpg");
  form.append("fileName", "produto.jpg");
  form.append("folder", "/amira/produtos");
  form.append("useUniqueFileName", "true"); // foto trocada = URL nova, sem cache velho
  form.append("publicKey", ass.publicKey);
  form.append("signature", ass.signature);
  form.append("expire", String(ass.expire));
  form.append("token", ass.token);

  const resp = await fetch(URL_UPLOAD_IMAGEKIT, { method: "POST", body: form });
  let corpo = {};
  try { corpo = await resp.json(); } catch (_) { /* sem JSON */ }
  if (!resp.ok || typeof corpo.url !== "string") {
    console.error("[sistema] Falha no envio ao ImageKit:", resp.status, corpo);
    throw new Error("Nao foi possivel enviar a foto agora. Tente de novo.");
  }
  return { valor: corpo.url, modo: "imagekit" };
}

/** Miniatura via ImageKit (?tr=w-N); outras URLs/data URI passam intactas. */
export function miniatura(url, largura = 160) {
  const texto = String(url || "");
  try {
    if (!new URL(texto).hostname.endsWith("imagekit.io")) return texto;
  } catch (_) {
    return texto;
  }
  return `${texto}${texto.includes("?") ? "&" : "?"}tr=w-${largura},c-at_max`;
}
