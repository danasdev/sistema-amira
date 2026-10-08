const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

// A autenticação de verdade (Firebase Admin) é trocada por uma falsa antes de
// carregar o handler: o teste não toca em credencial nem em rede.
const caminhoAdmin = require.resolve(path.join(__dirname, "../api/_lib/firebase-admin"));
let papel = "admin";
require.cache[caminhoAdmin] = {
  id: caminhoAdmin,
  filename: caminhoAdmin,
  loaded: true,
  exports: {
    tokenDaRequisicao: () => "token-falso",
    exigirAdmin: async () => {
      if (papel !== "admin") {
        const e = new Error("Só administradores podem fazer isso.");
        e.status = 403;
        e.publico = e.message;
        throw e;
      }
      return { uid: "u1", role: "admin" };
    }
  }
};

const handler = require("../api/imagekit-auth");

function chamar(method = "POST") {
  const r = { status: 0, corpo: null, headers: {} };
  const res = {
    setHeader: (k, v) => { r.headers[k] = v; },
    status(s) { r.status = s; return this; },
    json(b) { r.corpo = b; return this; },
    end() { return this; }
  };
  return Promise.resolve(handler({ method, headers: {}, body: {} }, res)).then(() => r);
}

const ENV = ["IMAGEKIT_PUBLIC_KEY", "IMAGEKIT_PRIVATE_KEY", "IMAGEKIT_URL_ENDPOINT"];
function limparEnv() { ENV.forEach((k) => delete process.env[k]); }

test("sem as env vars responde 503 com naoConfigurado (a tela cai no base64)", async () => {
  limparEnv();
  papel = "admin";
  const r = await chamar();
  assert.equal(r.status, 503);
  assert.equal(r.corpo.naoConfigurado, true);
});

test("assina com HMAC-SHA1(token + expire) e nunca devolve a chave privada", async () => {
  process.env.IMAGEKIT_PUBLIC_KEY = "public_teste";
  process.env.IMAGEKIT_PRIVATE_KEY = "private_teste";
  process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/amira/";
  papel = "admin";
  const r = await chamar();
  assert.equal(r.status, 200);
  const esperada = crypto.createHmac("sha1", "private_teste").update(r.corpo.token + r.corpo.expire).digest("hex");
  assert.equal(r.corpo.signature, esperada);
  assert.equal(r.corpo.publicKey, "public_teste");
  assert.equal(r.corpo.urlEndpoint, "https://ik.imagekit.io/amira");
  const validade = r.corpo.expire - Math.floor(Date.now() / 1000);
  assert.ok(validade > 0 && validade <= 3600, "expire precisa estar no futuro e a no máximo 1h");
  assert.ok(!JSON.stringify(r.corpo).includes("private_teste"));
  assert.equal(r.headers["Cache-Control"], "no-store");
  limparEnv();
});

test("quem não é admin recebe 403", async () => {
  process.env.IMAGEKIT_PUBLIC_KEY = "public_teste";
  process.env.IMAGEKIT_PRIVATE_KEY = "private_teste";
  process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/amira";
  papel = "vendedor";
  const r = await chamar();
  assert.equal(r.status, 403);
  limparEnv();
});

test("só aceita POST", async () => {
  papel = "admin";
  const r = await chamar("GET");
  assert.equal(r.status, 405);
});
