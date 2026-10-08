// ── POST /api/imagekit-auth ────────────────────────────────────────────
// Assina o envio de UMA foto de produto para o ImageKit.
//
// As fotos dos produtos moram no ImageKit (mesma conta do site — ver
// docs/IMAGENS_IMAGEKIT.md no repo do site); o documento do produto guarda
// só a URL. A foto vai direto do navegador para o ImageKit, mas o envio
// precisa de uma assinatura feita com a CHAVE PRIVADA, que nunca vai para o
// navegador. Esta função confere que quem pede é admin e devolve uma
// assinatura de uso único:
//   signature = HMAC-SHA1(chavePrivada, token + expire)  (hex)
//
// Sem as env vars (IMAGEKIT_PUBLIC_KEY / IMAGEKIT_PRIVATE_KEY /
// IMAGEKIT_URL_ENDPOINT) responde 503 + naoConfigurado — a tela de
// Produtos então cai na foto em base64 (modo antigo) em vez de travar.

const crypto = require("crypto");
const { aplicarCors } = require("./_lib/cors");
const { erroHttp, responderErro } = require("./_lib/http");
const { tokenDaRequisicao, exigirAdmin } = require("./_lib/firebase-admin");

const VALIDADE_SEGUNDOS = 10 * 60;

function configuracao(env = process.env) {
  const publicKey = String(env.IMAGEKIT_PUBLIC_KEY || "").trim();
  const privateKey = String(env.IMAGEKIT_PRIVATE_KEY || "").trim();
  const urlEndpoint = String(env.IMAGEKIT_URL_ENDPOINT || "").trim().replace(/\/+$/, "");
  if (!publicKey || !privateKey || !urlEndpoint) return null;
  return { publicKey, privateKey, urlEndpoint };
}

function assinar(privateKey, agora = Date.now()) {
  const token = crypto.randomUUID();
  const expire = Math.floor(agora / 1000) + VALIDADE_SEGUNDOS;
  const signature = crypto.createHmac("sha1", privateKey).update(token + expire).digest("hex");
  return { token, expire, signature };
}

async function handler(req, res) {
  if (aplicarCors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") throw erroHttp(405, "Método não permitido.");
    await exigirAdmin(tokenDaRequisicao(req));

    const config = configuracao();
    if (!config) {
      return res.status(503).json({
        erro: "ImageKit não configurado nesta API (IMAGEKIT_PUBLIC_KEY / IMAGEKIT_PRIVATE_KEY / IMAGEKIT_URL_ENDPOINT).",
        naoConfigurado: true
      });
    }
    return res.status(200).json({
      ...assinar(config.privateKey),
      publicKey: config.publicKey,
      urlEndpoint: config.urlEndpoint
    });
  } catch (erro) {
    return responderErro(res, erro);
  }
}

module.exports = handler;
module.exports.configuracao = configuracao;
module.exports.assinar = assinar;
