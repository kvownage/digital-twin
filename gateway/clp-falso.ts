// ============================================================================
//  CLP FALSO — publica um RealPayload sintético e VARIADO no broker.
//
//  Para quê: desenvolver, demonstrar e testar o caminho REAL (broker ->
//  servidor -> navegador) sem a célula ligada. Ele imita os SINAIS da linha,
//  não o movimento — o movimento continua sendo gerado pelo gêmeo no
//  servidor, que é o que vai acontecer em produção.
//
//  A variação é de propósito: tempo fixo esconde defeito de sincronismo, e
//  ciclo que nunca falha esconde o comportamento da tela em falha. Aqui os
//  tempos sorteiam dentro de faixas realistas, uma caixa em cada doze é
//  reprovada na balança, e de vez em quando o robô entra em falha e sai.
//
//  Sobe um broker MQTT embutido (aedes) na porta 1883. Em produção quem serve
//  é o Mosquitto/EMQX de verdade e este arquivo não roda.
//
//    npm run clp-falso                    (variação padrão)
//    npm run clp-falso -- --caos 0        (determinístico, sem falhas)
//    npm run clp-falso -- --caos 3        (bem instável, para testar a tela)
// ============================================================================
import "dotenv/config";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import mqtt from "mqtt";
import type { RealPayload } from "../shared/types.js";

const PORTA = Number(process.env.MQTT_PORTA ?? 1883);
const TOPICO = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado";
const POR_PALETE = 32;

// Intensidade da variação: 0 = nada aleatório, 1 = realista, 3 = instável.
const iCaos = process.argv.indexOf("--caos");
const CAOS = iCaos >= 0 ? Math.max(0, Number(process.argv[iCaos + 1] ?? 1)) : 1;

// ---- broker: externo se MQTT_URL apontar para fora ------------------------
// Com MQTT_URL definido (HiveMQ, EMQX, Mosquitto na rede), publica LÁ — é o
// que permite alimentar o supervisório publicado na internet. Sem ela, sobe
// um broker embutido em localhost para desenvolvimento offline.
const URL_EXT = process.env.MQTT_URL;
const externo = Boolean(URL_EXT && !/localhost|127\.0\.0\.1/.test(URL_EXT));

let cli: mqtt.MqttClient;
if (externo) {
  console.log(`[clp-falso] publicando em broker EXTERNO: ${URL_EXT!.replace(/\/\/[^@]*@/, "//***@")}`);
  // Usuário e senha vêm SEPARADOS de propósito: senha com @ : / # quebraria
  // a URL, e trocar a senha por causa disso seria o rabo abanando o cachorro.
  cli = mqtt.connect(URL_EXT!, {
    reconnectPeriod: 3000,
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
  });
} else {
  // aedes v1: a instância nasce de uma fábrica assíncrona. Com `new Aedes()`
  // o broker aceita o TCP mas nunca responde o CONNACK.
  const aedes = await Aedes.createBroker();
  const servidor = createServer(aedes.handle as never);
  servidor.listen(PORTA, () => console.log(`[clp-falso] broker embutido em mqtt://localhost:${PORTA}`));
  cli = mqtt.connect(`mqtt://localhost:${PORTA}`);
}
cli.on("connect", () => console.log("[clp-falso] broker conectado"));
cli.on("error", (e) => console.error(`[clp-falso] broker: ${e.message}`));

// ---- sorteios --------------------------------------------------------------
/** Valor em torno de `base`, com desvio de ±`pct` escalado pelo caos. */
const varia = (base: number, pct: number) =>
  base * (1 + (Math.random() * 2 - 1) * pct * CAOS);
/** Verdadeiro com probabilidade `p` (por caixa), escalada pelo caos. */
const sorte = (p: number) => Math.random() < p * CAOS;

// ---- o "processo" ----------------------------------------------------------
type Fase = "ESPERA" | "CHEGANDO" | "PESANDO" | "PRONTA" | "REPROVADA"
          | "PEGOU" | "SOLTANDO" | "FALHA" | "TROCA_PALETE";

let fase: Fase = "ESPERA";
let t = 0;                 // s na fase atual
let dur = 0;               // duração sorteada da fase atual
let qtd = 0;               // contagem do lado ativo
let lado2 = false;
let hb = 0;
let descartes = 0;
let pressao = 6.2;
let voltaDe: Fase = "ESPERA";   // para onde voltar depois da falha

// Faixas de duração (s): base e variação de ±25%
const BASE: Record<Fase, number> = {
  ESPERA: 0.4, CHEGANDO: 1.6, PESANDO: 1.0, PRONTA: 0.6, REPROVADA: 0.8,
  PEGOU: 4.2,            // transporte até o palete
  SOLTANDO: 1.4,         // deposita e recua
  FALHA: 6.0,            // robô parado até o reset
  TROCA_PALETE: 8.0,     // empilhadeira levando o palete cheio
};

function entra(f: Fase) {
  fase = f;
  t = 0;
  dur = Math.max(0.2, varia(BASE[f], 0.25));
}
entra("ESPERA");

function avanca(dt: number) {
  t += dt;

  // A pressão de ar respira sozinha, como no compressor real.
  pressao += (varia(6.2, 0.04) - pressao) * dt * 0.5;

  if (t < dur) return;

  switch (fase) {
    case "ESPERA":
      entra("CHEGANDO");
      break;

    case "CHEGANDO":
      entra("PESANDO");
      break;

    case "PESANDO":
      // Uma em cada doze caixas sai fora de peso — falta item na embalagem.
      entra(sorte(1 / 12) ? "REPROVADA" : "PRONTA");
      break;

    case "REPROVADA":
      // O robô descarta e a linha segue. Não conta no palete.
      descartes++;
      console.log(`[clp-falso] caixa REPROVADA (total ${descartes})`);
      entra("ESPERA");
      break;

    case "PRONTA":
      entra("PEGOU");
      break;

    case "PEGOU":
      entra("SOLTANDO");
      break;

    case "SOLTANDO":
      qtd++;
      if (qtd >= POR_PALETE) {
        qtd = 0;
        lado2 = !lado2;
        console.log(`[clp-falso] palete cheio -> trocando, agora lado ${lado2 ? 2 : 1}`);
        entra("TROCA_PALETE");
      } else if (sorte(1 / 60)) {
        // Falha esporádica do robô: é o que faz a tela mostrar ROBÔ EM FALHA
        // e o gêmeo congelar onde está.
        voltaDe = "ESPERA";
        console.log("[clp-falso] ROBO EM FALHA (temporario)");
        entra("FALHA");
      } else {
        entra("ESPERA");
      }
      break;

    case "FALHA":
      console.log("[clp-falso] falha reconhecida, retomando");
      entra(voltaDe);
      break;

    case "TROCA_PALETE":
      entra("ESPERA");
      break;
  }
}

function payload(): RealPayload {
  const naGarra = fase === "PEGOU" || fase === "SOLTANDO";
  const emFalha = fase === "FALHA";
  const trocando = fase === "TROCA_PALETE";
  const naBalanca = fase === "PESANDO" || fase === "PRONTA" || fase === "REPROVADA";

  return {
    ts: Date.now(),
    plcOk: true,
    robo: {
      run: !emFalha, servoOn: !emFalha, masterJob: !emFalha && !trocando,
      falha: emFalha,
      remoto: true, home: false, foraHome: !emFalha, pegaOk: naGarra,
      lado1: !lado2, lado2,
      caixaIndexador: fase === "PRONTA",
      vacuoLigado: naGarra, vacuoOk: naGarra,
      descargaCheia: trocando,
      fimEncaix1: false, fimEncaix2: false,
    },
    celula: {
      caixaNaEsteira: fase === "CHEGANDO",
      indexadorAvancado: fase === "PRONTA",
      pecaNoRobo: naGarra,
      // Durante a troca, o palete cheio sai: os sensores caem.
      palete1: !(trocando && !lado2), palete2: !(trocando && lado2),
      palete1b: !(trocando && !lado2), palete2b: !(trocando && lado2),
      esteiraEntrada: !emFalha, esteiraSaida: !emFalha,
      seladoraDesabilitada: false, automatico: true,
      porta1: true, porta2: true, barreira1: true, barreira2: true,
      torreVermelha: emFalha,
    },
    passos: {
      inicializacao: 10,
      lado1: lado2 ? 0 : (naGarra ? 30 : 20),
      lado2: lado2 ? (naGarra ? 30 : 20) : 0,
    },
    qtdeLado1: qtd,
    place: qtd,
    camadaRetorno: Math.floor(qtd / 16) + 1,
    alturaCaixa: 570,
    alturaPallet: 150,
    shiftY: 0,
    shiftZ: 0,
    camadaComando: Math.floor(qtd / 16) + 1,
    // Alarme do robô com código, para a tela ter o que mostrar.
    almRobo: emFalha ? 4021 : 0,
    almBalanca: 0,
    pressaoBar: Math.round(pressao * 100) / 100,
    balanca: {
      pecaEmPosicao: naBalanca,
      peso: fase === "PRONTA" ? 1 : fase === "REPROVADA" ? 2 : 0,
      lifeBit: (hb & 1) === 1,
    },
  };
}

const PASSO_MS = 100;
setInterval(() => {
  avanca(PASSO_MS / 1000);
  hb++;
  if (cli.connected) cli.publish(TOPICO, JSON.stringify(payload()), { retain: true });
}, PASSO_MS);

console.log(`[clp-falso] publicando em ${TOPICO} · caos=${CAOS}` +
  (CAOS === 0 ? " (deterministico)" : " (tempos sorteados, ~1/12 reprovada, falha esporadica)"));
