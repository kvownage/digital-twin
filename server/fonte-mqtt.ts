// ============================================================================
//  FONTE REAL — GÊMEO DIGITAL dirigido pelos sinais da linha.
//
//  Assina o broker MQTT e traduz o RealPayload do gateway para o MESMO
//  RobotState que o simulador emite — o cliente não sabe a diferença.
//
//  DECISÃO DE PROJETO: não lemos os ângulos do robô (o YRC1000 não os manda ao
//  CLP). O movimento é GERADO aqui, com a cinemática real do GP12, e quem
//  decide QUANDO cada trecho acontece são os SINAIS DA LINHA:
//
//    vácuo liga  -> pegou: o braço sobe e parte para o palete
//    vácuo cai   -> soltou: a caixa entra na pilha e o braço recua
//    contador    -> qual slot do catavento é o destino
//    balança     -> quando a caixa está pronta para a pega
//
//  O resultado: os EVENTOS são reais, o movimento entre eles é interpolado.
//  Nenhum instante é inventado; o que se preenche é só o caminho.
//
//  A pilha também é derivada dos contadores com as mesmas tabelas do padrão —
//  o CLP não transmite posição de caixa nenhuma.
// ============================================================================
import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import type { PlacedBox, RealPayload, RobotState } from "../shared/types.js";
import { fkTcp, route, slot, PER_PALLET, TOTAL, PICK, PHASES } from "./simulator.js";
import { Ptp } from "./ptp.js";

const FRESCOR_MS = 2000;
const TICK_MS = 40;                 // 25 Hz: o mesmo passo do simulador na rede

export class MqttSource extends EventEmitter {
  private last: RealPayload | null = null;
  private lastRx = 0;
  private timer: NodeJS.Timeout;

  // ---- o gêmeo ----
  private ptp = new Ptp();
  private wp = 0;                   // índice no roteiro de route()
  private pegouPrev = false;
  private tcpPrev: { x: number; y: number; z: number } | null = null;
  private tcpSpeed = 0;

  constructor(
    url = process.env.MQTT_URL ?? "mqtt://localhost:1883",
    topico = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado",
  ) {
    super();
    const client = mqtt.connect(url, { reconnectPeriod: 3000 });
    client.on("connect", () => {
      console.log(`[fonte-real] broker OK: ${url} (tópico ${topico})`);
      client.subscribe(topico);
    });
    client.on("error", (e) => console.error(`[fonte-real] broker: ${e.message}`));
    client.on("message", (_t, raw) => {
      // Mensagem de rede: parse defensivo, campos validados no uso.
      try {
        const p = JSON.parse(String(raw)) as RealPayload;
        if (p && p.robo && p.celula && p.passos) {
          this.last = p;
          this.lastRx = Date.now();
        }
      } catch { /* malformada: ignora */ }
    });

    this.timer = setInterval(() => {
      this.tick(TICK_MS / 1000);
      this.emit("state", this.snapshot());
    }, TICK_MS);
  }

  get ok(): boolean {
    return this.last !== null
      && Date.now() - this.lastRx < FRESCOR_MS
      && this.last.plcOk;
  }

  /** Contagem por lado. UM contador serve aos dois paletes: a célula termina
   *  um e começa o outro, e os bits LADO 1/2 ATIVO dizem de quem ele é. */
  private contagens(p: RealPayload) {
    const qtd = Math.max(0, Math.min(PER_PALLET, p.qtdeLado1));
    const noLado2 = p.robo.lado2 && !p.robo.lado1;
    return {
      noLado2,
      countA: noLado2 ? PER_PALLET : qtd,
      countB: noLado2 ? qtd : 0,
    };
  }

  // --------------------------------------------------------------------------
  //  O gêmeo: avança o braço conforme os sinais reais
  // --------------------------------------------------------------------------
  private tick(dt: number) {
    const p = this.last;
    if (!p || !this.ok) {
      // Sem dado fresco o braço PARA onde está — não continua sozinho
      // fingindo que a célula segue produzindo.
      this.tcpSpeed = 0;
      return;
    }

    const { countA, countB } = this.contagens(p);
    const boxIndex = Math.max(0, Math.min(TOTAL - 1, countA + countB));
    const wps = route(boxIndex);

    // O evento que manda em tudo: a ventosa.
    const pegou = p.robo.vacuoLigado && p.robo.vacuoOk;
    if (pegou && !this.pegouPrev) this.wp = 2;   // subiu: acabou de pegar
    if (!pegou && this.pegouPrev) this.wp = 6;   // caiu: acabou de soltar
    this.pegouPrev = pegou;

    if (pegou) {
      // Carregando: percorre SOBE -> GIRO -> APROX -> DEPOSITA e espera lá
      // até o vácuo cair. Quem diz "chegou" é a própria cinemática.
      if (this.wp < 2) this.wp = 2;
      if (this.wp < 5 && this.ptp.chegou) this.wp++;
    } else if (this.wp === 6) {
      if (this.ptp.chegou) this.wp = 0;          // terminou de recuar
    } else {
      // Livre: espera sobre a balança; desce quando a peça está liberada.
      const pronta = p.balanca.pecaEmPosicao && p.balanca.peso === 1;
      this.wp = pronta ? 1 : 0;
    }

    this.ptp.goTo(wps[this.wp].j);
    this.ptp.step(dt, 100);

    const t = fkTcp(this.ptp.j);
    if (this.tcpPrev) {
      this.tcpSpeed = Math.hypot(
        t.x - this.tcpPrev.x, t.y - this.tcpPrev.y, t.z - this.tcpPrev.z) / dt;
    }
    this.tcpPrev = t;
  }

  /** A pilha reconstituída dos contadores, pelas mesmas tabelas do padrão. */
  private pilha(a: number, b: number): PlacedBox[] {
    const out: PlacedBox[] = [];
    for (let i = 0; i < Math.min(a, PER_PALLET); i++) {
      const s = slot(1, i);
      out.push({ ...s.center, rot: s.rot });
    }
    for (let i = 0; i < Math.min(b, PER_PALLET); i++) {
      const s = slot(-1, i);
      out.push({ ...s.center, rot: s.rot });
    }
    return out;
  }

  snapshot(): RobotState {
    const p = this.last;
    const ok = this.ok;

    if (!p) {
      // Nunca chegou nada: estado vazio e explícito.
      return {
        j: [0, -5, -50], phase: 0, phaseName: "SEM DADOS", carrying: false,
        feed: null, peso: 0, running: false, ritmo: 0, turbo: 1,
        fonte: "real", realOk: false, tcp: fkTcp([0, -5, -50]), speed: 0,
        placed: [], boxIndex: 0, boxTotal: TOTAL, descartadas: 0, carryRot: 0,
        countA: 0, countB: 0,
      };
    }

    const { noLado2, countA, countB } = this.contagens(p);
    const boxIndex = Math.max(0, Math.min(TOTAL - 1, countA + countB));
    const sl = slot(noLado2 ? -1 : 1, boxIndex % PER_PALLET);
    const j = this.ptp.j;

    return {
      j: [...j] as [number, number, number],
      phase: route(boxIndex)[this.wp]?.phase ?? 0,
      phaseName: p.robo.falha ? "ROBÔ EM FALHA"
        : !p.celula.automatico ? "MANUAL"
        : PHASES[route(boxIndex)[this.wp]?.phase ?? 0],
      carrying: this.pegouPrev,
      feed: p.balanca.pecaEmPosicao
        ? {
            x: PICK.r,
            // O veredito da Toledo: 0 aguardando · 1 OK · 2 NOK.
            status: p.balanca.peso === 2 ? "REPROVADA"
                  : p.balanca.peso === 1 ? "PRONTA"
                  : "PESANDO",
          }
        : p.celula.caixaNaEsteira
          ? { x: PICK.r + 700, status: "CHEGANDO" }   // posição estimada
          : null,
      // A balança publica veredito (OK/NOK), não o valor em kg — o peso em
      // número exigiria mais uma holding do lado dela.
      peso: p.balanca.peso === 1 ? 1 : 0,
      running: p.robo.run && !p.robo.falha,
      ritmo: 100,
      turbo: 1,
      fonte: "real",
      realOk: ok,
      tcp: fkTcp(j),
      speed: ok ? this.tcpSpeed : 0,
      placed: this.pilha(countA, countB),
      boxIndex,
      boxTotal: TOTAL,
      descartadas: 0,
      carryRot: sl.rot,
      countA,
      countB,
    };
  }

  stop() { clearInterval(this.timer); }
}
