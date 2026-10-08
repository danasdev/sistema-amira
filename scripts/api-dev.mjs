// ── API local da maquininha (só pra testar no SEU computador) ──────────
// Sobe as mesmas funções de api/ (as que a Vercel roda) num servidor HTTP
// local, lendo as variáveis do .env da raiz do projeto. Serve pra fazer o
// primeiro teste com a maquininha de verdade sem publicar nada.
//
//   npm run api:dev            → http://127.0.0.1:3001
//   API_DEV_PORT=4000 npm run api:dev   (outra porta)
//
// ⚠️ Escuta SÓ em 127.0.0.1 (este computador) e usa o Access Token REAL do
// Mercado Pago do .env. Nunca exponha essa porta (túnel, ngrok, rede local):
// quem alcançasse a API ainda precisaria de um login da equipe, mas não há
// motivo pra correr esse risco num teste.

import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { carregarEnv } from "./lib/env.mjs";
import { liberarFrontLocal, ORIGENS_FRONT_LOCAL } from "./lib/cors-local.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITE_CORPO = 1024 * 1024; // as requisições daqui têm poucos bytes

/** rota → arquivo (o mesmo que a Vercel expõe em /api/...). */
export const ROTAS_REAIS = {
  "/api/point/cobrar": "api/point/cobrar.js",
  "/api/point/status": "api/point/status.js",
  "/api/point/cancelar": "api/point/cancelar.js",
  "/api/point/estornar": "api/point/estornar.js",
  "/api/point/terminais": "api/point/terminais.js",
  "/api/point/diagnostico": "api/point/diagnostico.js",
  "/api/webhook-point": "api/webhook-point.js",
  "/api/imagekit-auth": "api/imagekit-auth.js"
};

// res.status(n).json(obj), como na Vercel.
function adaptarResposta(res) {
  res.status = (codigo) => {
    res.statusCode = codigo;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

// Lê o corpo inteiro. Passou do limite: continua drenando (pra a conexão
// seguir saudável e o cliente receber o 413) mas descarta o excesso.
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let estourou = false;
    req.on("data", (pedaco) => {
      total += pedaco.length;
      if (total > LIMITE_CORPO) estourou = true;
      else partes.push(pedaco);
    });
    req.on("end", () => {
      if (estourou) reject(Object.assign(new Error("Corpo da requisição grande demais."), { status: 413 }));
      else resolve(Buffer.concat(partes).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// req.query e req.body no formato da Vercel: JSON vira objeto, o resto fica texto.
function montarReq(req, url, corpoTexto) {
  req.query = Object.fromEntries(url.searchParams);
  req.body = undefined;
  if (corpoTexto) {
    if (String(req.headers["content-type"] || "").includes("application/json")) {
      try {
        req.body = JSON.parse(corpoTexto);
      } catch {
        throw Object.assign(new Error("O corpo da requisição não é um JSON válido."), { status: 400 });
      }
    } else {
      req.body = corpoTexto;
    }
  }
  return req;
}

/**
 * @param {Record<string, (req, res) => any>} rotas caminho → handler (req, res)
 * @param {{log?: (linha: string) => void}} [opcoes]
 */
export function criarServidor(rotas, { log = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    adaptarResposta(res);
    const inicio = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const rota = url.pathname.replace(/\/+$/, "") || "/";
    // Só método, rota e status: nunca corpo nem headers (têm token de login).
    res.on("finish", () => log(`${req.method} ${rota} -> ${res.statusCode} (${Date.now() - inicio}ms)`));

    try {
      if (rota === "/api/health") return res.status(200).json({ ok: true, servidor: "api-dev" });
      const handler = Object.prototype.hasOwnProperty.call(rotas, rota) ? rotas[rota] : null;
      if (!handler) return res.status(404).json({ erro: "Rota não encontrada." });

      montarReq(req, url, await lerCorpo(req));
      await handler(req, res);
      if (!res.writableEnded) res.end();
    } catch (erro) {
      if (erro && erro.status && erro.status < 500) {
        if (!res.headersSent) res.status(erro.status).json({ erro: erro.message });
        else res.end();
        return;
      }
      console.error("[api-dev] erro inesperado:", erro && erro.message);
      if (!res.headersSent) res.status(500).json({ erro: "Erro interno do servidor local." });
      else res.end();
    }
  });
}

/**
 * Texto de abertura: o que está configurado (só se está ou não — nunca o
 * valor de segredo) e o que fazer a seguir.
 * @param {{url:string, env:object, firebase:{ok:boolean, projectId?:string, mensagem?:string}, envCarregado:boolean, corsAdicionadas?:string[]}} p
 *   corsAdicionadas: origens do sistema local que o .env não tinha e foram liberadas (ver lib/cors-local.mjs)
 */
export function linhasDoBanner({ url, env, firebase, envCarregado, corsAdicionadas = [] }) {
  const token = String(env.MP_ACCESS_TOKEN || "").trim();
  const terminal = String(env.MP_POINT_TERMINAL_ID || "").trim();
  const item = (nome, texto) => `  ${nome.padEnd(22, ".")} ${texto}`;
  const sistemaLocal = ORIGENS_FRONT_LOCAL[0];
  const cors = !String(env.CORS_ORIGINS || "").trim()
    ? `padrão (já libera ${sistemaLocal})`
    : corsAdicionadas.length
      ? `o .env limitava a outras origens; liberei também ${sistemaLocal}`
      : `ok (${sistemaLocal} liberado)`;

  return [
    `API local da maquininha em ${url}  (só este computador acessa)`,
    "",
    envCarregado
      ? "Configuração (do arquivo .env e do ambiente):"
      : "Não achei o arquivo .env na raiz do projeto — copie o .env.example para .env e preencha.",
    item("MP_ACCESS_TOKEN", !token ? "FALTANDO" : token.startsWith("TEST-") ? "credencial de TESTE (não serve pra maquininha real)" : "ok"),
    item("MP_POINT_TERMINAL_ID", terminal || "FALTANDO  (npm run point:check -- --gravar preenche)"),
    item("MP_WEBHOOK_SECRET", String(env.MP_WEBHOOK_SECRET || "").trim() ? "configurada" : "não configurada (ok pros primeiros testes)"),
    item("Firebase", firebase.ok ? `projeto ${firebase.projectId}` : `ERRO: ${firebase.mensagem}`),
    item("CORS_ORIGINS", cors),
    "",
    "Conferir tudo de uma vez:  npm run point:check",
    "Ctrl+C para parar."
  ];
}

async function main() {
  const porta = Number(process.env.API_DEV_PORT) || 3001;
  const { carregado } = carregarEnv({ arquivo: path.join(RAIZ, ".env") });
  // Um CORS_ORIGINS do .env substitui a lista padrão e deixaria o sistema local
  // (http://localhost:5173) bloqueado pelo navegador: garante que ele está lá.
  const { adicionadas: corsAdicionadas } = liberarFrontLocal(process.env);

  // Só agora (e não no topo do arquivo) carrega o firebase-admin & cia:
  // importar este módulo nos testes não puxa nada disso.
  const exigir = createRequire(import.meta.url);
  const rotas = Object.fromEntries(Object.entries(ROTAS_REAIS).map(([rota, arquivo]) => [rota, exigir(path.join(RAIZ, arquivo))]));
  const { credenciais } = exigir(path.join(RAIZ, "api/_lib/firebase-admin.js"));

  let firebase;
  try {
    firebase = { ok: true, projectId: credenciais().project_id };
  } catch (erro) {
    firebase = { ok: false, mensagem: erro.message };
  }

  const servidor = criarServidor(rotas, { log: (linha) => console.log(`[api-dev] ${linha}`) });
  servidor.on("error", (erro) => {
    if (erro.code === "EADDRINUSE") {
      console.error(`A porta ${porta} já está em uso. Feche o outro api:dev ou use outra: API_DEV_PORT=3002 npm run api:dev`);
      process.exit(1);
    }
    throw erro;
  });
  servidor.listen(porta, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${porta}`;
    console.log(linhasDoBanner({ url, env: process.env, firebase, envCarregado: carregado, corsAdicionadas }).join("\n"));
  });
}

const executadoDireto = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  main().catch((erro) => {
    console.error("Não consegui subir a API local:", erro.message);
    process.exit(1);
  });
}
