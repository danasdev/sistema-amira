import { login, currentPerfil, sairSilencioso, ehEquipe } from "../auth.js";

const r = await currentPerfil();
if (r && r.user && ehEquipe(r.perfil)) location.replace("/dashboard");
else if (r && r.user) await sairSilencioso();

document.getElementById("root").innerHTML = `
  <div class="login-wrap">
    <div class="login-arte">
      <img src="/assets/img/amira-logo.png" alt="Amira">
      <p>Sistema interno da perfumaria</p>
    </div>
    <div class="login-lado">
      <form class="login-card" id="f" novalidate>
        <h1>Entrar</h1>
        <p>Acesso restrito à equipe da loja.</p>
        <label for="email">E-mail</label>
        <input type="email" id="email" required autocomplete="username" placeholder="voce@exemplo.com">
        <label for="senha">Senha</label>
        <input type="password" id="senha" required autocomplete="current-password">
        <div id="erro" class="faixa erro" style="margin-top:14px;display:none" role="alert"></div>
        <button class="btn lg bloco" style="margin-top:20px" id="b">Entrar</button>
      </form>
    </div>
  </div>`;

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = document.getElementById("b");
  const erro = document.getElementById("erro");
  if (!document.getElementById("email").value.trim() || !document.getElementById("senha").value) {
    erro.textContent = "Preencha o e-mail e a senha.";
    erro.style.display = "flex";
    return;
  }
  b.disabled = true;
  b.classList.add("carregando");
  erro.style.display = "none";
  try {
    await login(
      document.getElementById("email").value.trim(),
      document.getElementById("senha").value
    );
    const r = await currentPerfil();
    if (!ehEquipe(r?.perfil)) {
      await sairSilencioso();
      erro.textContent = "Esta conta não tem acesso ao sistema interno.";
      erro.style.display = "flex";
      b.disabled = false;
      b.classList.remove("carregando");
      return;
    }
    location.replace("/dashboard");
  } catch (_) {
    erro.textContent = "E-mail ou senha incorretos. Confira e tente de novo.";
    erro.style.display = "flex";
    b.disabled = false;
    b.classList.remove("carregando");
  }
});
