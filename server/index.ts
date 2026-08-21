// ============================================================================
//  Servidor do supervisório: HTTP (build do cliente) + WebSocket (estado).
//
//  DUAS FONTES, uma interface: o simulador e a célula real (via broker MQTT)
//  emitem o mesmo RobotState. O seletor REAL/SIMULADOR escolhe qual chega aos
//  navegadores; o simulador segue vivo em segundo plano como reserva.
//
//  LOGIN GOOGLE restrito ao domínio (AUTH_DOMINIO): ativa sozinho quando as
//  variáveis GOOGLE_CLIENT_ID/SECRET existem — sem elas, roda aberto (dev) e
//  avisa no console. O WebSocket também é gateado pela sessão.
// ============================================================================
import "dotenv/config";
import express from "express";
import cookieSession from "cookie-session";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Gp12Simulator, PHASES, PICK, PALLET, BOX, PED } from "./simulator.js";
import { MqttSource } from "./fonte-mqtt.js";
import type { ClientCmd, HelloMsg, RobotState, StateMsg } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 3001);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "client", "dist");

// ---------------------------------------------------------------- login ----
const G_ID = process.env.GOOGLE_CLIENT_ID;
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DOMINIO = process.env.AUTH_DOMINIO ?? "grupomultilaser.com.br";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const authAtivo = Boolean(G_ID && G_SECRET);

const app = express();

// Atrás do HTTPS do host (Render/Railway/nginx), o Express precisa confiar no
// X-Forwarded-Proto para o cookie de sessão valer como seguro.
app.set("trust proxy", 1);

const sessao = cookieSession({
  name: "supervisorio",
  secret: process.env.SESSION_SECRET ?? "dev-sem-segredo",
  maxAge: 12 * 60 * 60 * 1000,        // um turno de trabalho
  sameSite: "lax",
});
app.use(sessao);

if (authAtivo) {
  app.get("/auth/login", (_req, res) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", G_ID!);
    url.searchParams.set("redirect_uri", `${BASE_URL}/auth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("hd", DOMINIO);          // dica de domínio na tela
    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: G_ID!,
          client_secret: G_SECRET!,
          redirect_uri: `${BASE_URL}/auth/callback`,
          grant_type: "authorization_code",
        }),
      });
      const tok = (await r.json()) as { id_token?: string };
      if (!tok.id_token) throw new Error("sem id_token");

      // A Google valida a assinatura por nós neste endpoint.
      const vr = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${tok.id_token}`);
      const info = (await vr.json()) as {
        aud?: string; email?: string; email_verified?: string; hd?: string;
      };

      const doDominio = info.hd === DOMINIO
        || (info.email ?? "").endsWith(`@${DOMINIO}`);
      if (info.aud !== G_ID || info.email_verified !== "true" || !doDominio) {
        res.status(403).send(
          `Acesso restrito a contas @${DOMINIO}. <a href="/auth/login">Tentar de novo</a>`);
        return;
      }

      req.session!.email = info.email;
      res.redirect("/");
    } catch {
      res.status(500).send('Falha no login. <a href="/auth/login">Tentar de novo</a>');
    }
  });

  app.get("/auth/logout", (req, res) => {
    req.session = null;
    res.redirect("/auth/login");
  });

  // Tudo o mais exige sessão.
  app.use((req, res, next) => {
    if (req.session?.email) return next();
    res.redirect("/auth/login");
  });

  console.log(`[auth] login Google ATIVO — domínio @${DOMINIO}`);
} else if (process.env.NODE_ENV === "production") {
  // Em produção a trava é OBRIGATÓRIA: sem credenciais, ninguém entra —
  // melhor uma página de aviso do que o supervisório aberto na internet.
  app.use((_req, res) => {
    res.status(503).send(
      "<h1>Supervisório indisponível</h1>" +
      "<p>Login Google não configurado. Defina GOOGLE_CLIENT_ID, " +
      "GOOGLE_CLIENT_SECRET, BASE_URL e SESSION_SECRET no ambiente.</p>");
  });
  console.log("[auth] PRODUÇÃO SEM CREDENCIAIS — aplicação bloqueada até configurar");
} else {
  console.log("[auth] GOOGLE_CLIENT_ID ausente — servidor ABERTO (modo dev)");
}

// Em produção o Node serve o build do Vite. Em dev quem serve é o próprio
// Vite (porta 5173) com proxy do /ws para cá.
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const http = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// O upgrade do WebSocket passa pela MESMA sessão do cookie.
http.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws")) { socket.destroy(); return; }
  const fakeRes = { writeHead() {}, end() {} } as never;
  sessao(req as never, fakeRes, () => {
    const temSessao = (req as { session?: { email?: string } }).session?.email;
    if (authAtivo && !temSessao) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
});

// ---------------------------------------------------------- as duas fontes --
const sim = new Gp12Simulator();
// Nenhuma falha da fonte real pode impedir o servidor de subir.
let real: MqttSource;
try {
  real = new MqttSource();
} catch (e) {
  console.error(`[fonte-real] nao inicializou (${(e as Error).message}) — só SIMULADOR`);
  real = new MqttSource("mqtt://desligado.invalido:1883");
}
let fonte: "sim" | "real" = "sim";

function broadcast(state: RobotState) {
  const msg: StateMsg = { type: "state", ...state, fonte, realOk: real.ok };
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

// 50 Hz de simulação -> 25 Hz de rede; a fonte real já emite a 5 Hz.
let skip = false;
sim.on("state", (s: RobotState) => {
  if (fonte !== "sim") return;
  skip = !skip;
  if (skip) return;
  broadcast(s);
});
real.on("state", (s: RobotState) => {
  if (fonte !== "real") return;
  broadcast(s);
});

wss.on("connection", (ws) => {
  const hello: HelloMsg = {
    type: "hello",
    phases: [...PHASES],
    layout: {
      pick: { r: PICK.r, top: PICK.top },
      pallet: { size: PALLET.size, top: PALLET.top, r: PALLET.r },
      box: { w: BOX.w, d: BOX.d, h: BOX.h },
      pedestal: PED,
    },
  };
  ws.send(JSON.stringify(hello));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as ClientCmd;
      if (!msg || typeof msg.cmd !== "string") return;
      if (msg.cmd === "fonte") {
        if (msg.value === "sim" || msg.value === "real") fonte = msg.value;
        return;
      }
      // Comandos de simulação valem SÓ para o simulador — a célula real não
      // se comanda por aqui (segurança: supervisório real observa, não move).
      sim.command(msg.cmd, "value" in msg ? msg.value : undefined);
    } catch { /* mensagem malformada: ignora */ }
  });
});

http.listen(PORT, () => {
  console.log(`[supervisorio] WS/HTTP em http://localhost:${PORT}`);
  if (!fs.existsSync(dist)) {
    console.log("[supervisorio] dev: abra o Vite em http://localhost:5173");
  }
});
