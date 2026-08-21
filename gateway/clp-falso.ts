// ============================================================================
//  CLP FALSO — publica um RealPayload sintético no broker.
//
//  Para quê: desenvolver e demonstrar o caminho REAL (broker -> servidor ->
//  navegador) sem a célula ligada. Ele imita os SINAIS da linha, não o
//  movimento — o movimento continua sendo gerado pelo gêmeo no servidor, que
//  é exatamente o que vai acontecer em produção.
//
//  Sobe um broker MQTT embutido (aedes) na porta 1883 se não houver um. Em
//  produção, quem serve é o Mosquitto/EMQX de verdade e este arquivo não roda.
//
//    npm run clp-falso
// ============================================================================
import "dotenv/config";
import { Aedes } from "aedes";
import { createServer } from "node:net";
import mqtt from "mqtt";
import type { RealPayload } from "../shared/types.js";

const PORTA = Number(process.env.MQTT_PORTA ?? 1883);
const TOPICO = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado";
const POR_PALETE = 32;

// ---- broker embutido -------------------------------------------------------
// aedes v1: a instância nasce de uma fábrica assíncrona. Com `new Aedes()` o
// broker aceita o TCP mas nunca responde o CONNACK.
const aedes = await Aedes.createBroker();
const servidor = createServer(aedes.handle as never);
servidor.listen(PORTA, () => console.log(`[clp-falso] broker em mqtt://localhost:${PORTA}`));

const cli = mqtt.connect(`mqtt://localhost:${PORTA}`);

// ---- o "processo" ----------------------------------------------------------
type Fase = "ESPERA" | "CHEGANDO" | "PESANDO" | "PRONTA" | "PEGOU" | "SOLTANDO";
let fase: Fase = "ESPERA";
let t = 0;                 // s na fase atual
let qtd = 0;               // contagem do lado ativo
let lado2 = false;
let hb = 0;

// Tempos que imitam o ritmo da célula real (s)
const DUR: Record<Fase, number> = {
  ESPERA: 0.4, CHEGANDO: 1.6, PESANDO: 1.0, PRONTA: 0.6,
  PEGOU: 4.2,            // transporte até o palete
  SOLTANDO: 1.4,         // deposita e recua
};

function avanca(dt: number) {
  t += dt;
  if (t < DUR[fase]) return;
  t = 0;
  switch (fase) {
    case "ESPERA":   fase = "CHEGANDO"; break;
    case "CHEGANDO": fase = "PESANDO";  break;
    case "PESANDO":  fase = "PRONTA";   break;
    case "PRONTA":   fase = "PEGOU";    break;
    case "PEGOU":    fase = "SOLTANDO"; break;
    case "SOLTANDO":
      qtd++;
      if (qtd >= POR_PALETE) {
        qtd = 0;
        lado2 = !lado2;    // termina um palete e começa o outro
        console.log(`[clp-falso] palete cheio -> lado ${lado2 ? 2 : 1}`);
      }
      fase = "ESPERA";
      break;
  }
}

function payload(): RealPayload {
  const naGarra = fase === "PEGOU" || fase === "SOLTANDO";
  return {
    ts: Date.now(),
    plcOk: true,
    robo: {
      run: true, servoOn: true, masterJob: true, falha: false,
      remoto: true, home: false, foraHome: true, pegaOk: naGarra,
      lado1: !lado2, lado2,
      caixaIndexador: fase === "PRONTA",
      vacuoLigado: naGarra, vacuoOk: naGarra,
      descargaCheia: false, fimEncaix1: false, fimEncaix2: false,
    },
    celula: {
      caixaNaEsteira: fase === "CHEGANDO",
      indexadorAvancado: fase === "PRONTA",
      pecaNoRobo: naGarra,
      palete1: true, palete2: true, palete1b: true, palete2b: true,
      esteiraEntrada: true, esteiraSaida: true,
      seladoraDesabilitada: false, automatico: true,
      porta1: true, porta2: true, barreira1: true, barreira2: true,
      torreVermelha: false,
    },
    passos: { inicializacao: 10, lado1: lado2 ? 0 : 20, lado2: lado2 ? 20 : 0 },
    qtdeLado1: qtd,
    place: qtd,
    camadaRetorno: Math.floor(qtd / 16) + 1,
    alturaCaixa: 570, alturaPallet: 150,
    shiftY: 0, shiftZ: 0,
    camadaComando: Math.floor(qtd / 16) + 1,
    almRobo: 0, almBalanca: 0,
    pressaoBar: 6.2,
    balanca: {
      pecaEmPosicao: fase === "PESANDO" || fase === "PRONTA",
      peso: fase === "PRONTA" ? 1 : 0,
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

console.log(`[clp-falso] publicando sinais sintéticos em ${TOPICO}`);
