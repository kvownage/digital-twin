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
  private carregando = false;       // a caixa está na ventosa?
  private naBalancaPrev = false;    // para detectar a borda de saída
  private qtdPrev = -1;             // para detectar o depósito
  private vacuoPrev = false;        // o vácuo é NÍVEL: precisa de borda
  private tCarregando = 0;          // s carregando — rede de segurança
  private tcpPrev: { x: number; y: number; z: number } | null = null;
  private tcpSpeed = 0;

  constructor(
    url = process.env.MQTT_URL ?? "mqtt://localhost:1883",
    topico = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado",
  ) {
    super();

    // Broker mal configurado NÃO derruba a aplicação: o simulador tem de
    // continuar servindo. A fonte real simplesmente nasce morta, e a tela
    // mostra SEM DADOS REAIS — que é a verdade.
    if (!/^(mqtt|mqtts|ws|wss|tcp|ssl):\/\//.test(url)) {
      console.error(
        `[fonte-real] MQTT_URL invalida ("${url}"): falta o protocolo. ` +
        `Use algo como mqtts://seu-cluster.hivemq.cloud:8883. ` +
        `A fonte REAL fica indisponivel; o SIMULADOR segue funcionando.`);
      this.timer = setInterval(() => this.emit("state", this.snapshot()), TICK_MS);
      return;
    }

    // Credencial separada da URL: senha com caractere especial (@ : / #) não
    // sobrevive dentro de uma URL, e não é a senha que deve ceder.
    const client = mqtt.connect(url, {
      reconnectPeriod: 3000,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
    });
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

    // EMERGÊNCIA: o robô para ONDE ESTAVA. Nada de terminar o movimento em
    // curso, nada de recolher — é o que a célula real faz quando a categoria
    // de segurança corta a potência.
    if (p.celula.emergencia) {
      this.tcpSpeed = 0;
      return;
    }

    const { countA, countB } = this.contagens(p);
    const boxIndex = Math.max(0, Math.min(TOTAL - 1, countA + countB));
    const wps = route(boxIndex);

    // =======================================================================
    //  QUAIS SINAIS DIRIGEM O BRAÇO
    //
    //  MEDIDO NA CÉLULA REAL, com o gateway publicando:
    //
    //    peso 0 -> 1            a balança aprovou
    //    vacuoLigado -> true    o robô pegou          <- alterna certo
    //    pecaEmPosicao -> false a caixa saiu          <- alterna certo
    //    vacuoLigado -> false   comando de vácuo cai
    //    qtdeLado1 6 -> 7       depositou             <- alterna certo
    //
    //  E o `vacuoOk` (VC1) NUNCA muda: fica em false o tempo todo. A versão
    //  anterior exigia `vacuoLigado && vacuoOk`, então a condição jamais era
    //  verdadeira — a pilha crescia pelo contador e o braço ficava parado.
    //  Era esse o defeito.
    //
    //  Duas bordas dirigem o braço, e nenhuma depende de VC1:
    //    vácuo LIGA (ou a peça sai da balança)  -> pegou: sobe e parte
    //    o contador INCREMENTA                  -> depositou: recua
    // =======================================================================
    const naBalanca = p.balanca.pecaEmPosicao;
    // Só `vacuoLigado`: é o comando de vácuo, e é o que alterna de verdade.
    // O VC1 não entra — está morto no dado real (ver acima).
    const vacuo = p.robo.vacuoLigado;
    const qtd = p.qtdeLado1;

    // primeira mensagem: só sincroniza, sem inventar evento
    if (this.qtdPrev < 0) {
      this.qtdPrev = qtd;
      this.naBalancaPrev = naBalanca;
      this.vacuoPrev = vacuo;
    }

    const saiuDaBalanca = this.naBalancaPrev && !naBalanca;
    // BORDA, não nível: `vacuoLigado` fica alto durante todo o transporte, e
    // usá-lo como nível reiniciava o trecho a cada quadro — o braço oscilava
    // entre SOBE e GIRO sem sair do lugar.
    const ligouVacuo = vacuo && !this.vacuoPrev;
    const pegouAgora = saiuDaBalanca || ligouVacuo;

    // QUALQUER mudança do contador encerra o transporte — sem exigir que o
    // valor novo seja maior. A versão anterior pedia `qtd > 0`, e isso perdia
    // exatamente o evento da TROCA DE LADO: ao completar o palete 1 o
    // contador vai de 32 para 0, o depósito não era reconhecido, e o braço
    // ficava parado no slot do lado 2 sem nunca voltar. Era esse o defeito.
    // De quebra, cobre o rollback de falha (18 -> 16), que também é evento.
    const mudouContador = qtd !== this.qtdPrev;

    if (pegouAgora && !this.carregando) {
      this.carregando = true;
      this.tCarregando = 0;
      this.wp = 2;                    // SOBE, com a caixa
    } else if (pegouAgora && this.carregando) {
      // Nova pega com o gêmeo AINDA carregando: a animação ficou atrás da
      // célula. Fecha o ciclo anterior na hora e começa o novo — melhor um
      // corte seco do que mostrar duas caixas em trânsito ao mesmo tempo.
      this.tCarregando = 0;
      this.wp = 2;
    }

    if (this.carregando) {
      this.tCarregando += dt;
      // Rede de segurança: se o contador não confirmar em 25 s, algo se
      // perdeu (sinal, reconexão, caso não previsto). Solta o braço em vez
      // de deixá-lo plantado no slot para sempre.
      if (mudouContador || this.tCarregando > 25) {
        this.carregando = false;
        this.wp = 6;                  // RECUA
      }
    }
    this.naBalancaPrev = naBalanca;
    this.qtdPrev = qtd;
    this.vacuoPrev = vacuo;

    if (this.carregando) {
      // Percorre SOBE -> GIRO -> APROX -> DEPOSITA e espera no destino até
      // o contador confirmar. Quem diz "chegou" é a própria cinemática.
      if (this.wp < 2) this.wp = 2;
      if (this.wp < 5 && this.ptp.chegou) this.wp++;
    } else if (this.wp === 6) {
      if (this.ptp.chegou) this.wp = 0;          // terminou de recuar
    } else {
      // Livre: espera sobre a balança; desce quando a peça está liberada.
      const pronta = naBalanca && p.balanca.peso === 1;
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
        paleteA: false, paleteB: false, emergencia: false, paletesProduzidos: 0,
        status: {
          remoto: false, servoOn: false, emCiclo: false, emHome: false,
          falha: false, almRobo: 0, automatico: false, portas: false,
          barreiras: false, descargaCheia: false, vacuoLigado: false,
          vacuoOk: false, pressaoBar: 0, ladoAtivo: 0, almBalanca: 0,
          seladoraDesabilitada: false,
        },
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
      phaseName: p.celula.emergencia ? "EMERGÊNCIA"
        : p.robo.falha ? "ROBÔ EM FALHA"
        : !p.celula.automatico ? "MANUAL"
        : PHASES[route(boxIndex)[this.wp]?.phase ?? 0],
      carrying: this.carregando,
      // Enquanto o gêmeo carrega, a caixa da balança NÃO é desenhada.
      //
      // Na célula real a próxima caixa chega à balança enquanto o robô ainda
      // transporta a anterior — é verdade, mas a animação do gêmeo fica um
      // pouco atrás, e o resultado na tela era ver a MESMA caixa em dois
      // lugares: na garra e na balança. Confunde mais do que informa.
      // A caixa reaparece na balança quando o braço solta a que está levando.
      feed: this.carregando
        ? null
        : p.balanca.pecaEmPosicao
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
      paleteA: p.celula.palete1,
      paleteB: p.celula.palete2,
      emergencia: p.celula.emergencia,
      paletesProduzidos: p.paletesProduzidos ?? 0,
      status: {
        remoto: p.robo.remoto,
        servoOn: p.robo.servoOn,
        emCiclo: p.robo.masterJob,
        emHome: p.robo.home,
        falha: p.robo.falha,
        almRobo: p.almRobo,
        automatico: p.celula.automatico,
        portas: p.celula.porta1 && p.celula.porta2,
        barreiras: p.celula.barreira1 && p.celula.barreira2,
        descargaCheia: p.robo.descargaCheia,
        vacuoLigado: p.robo.vacuoLigado,
        vacuoOk: p.robo.vacuoOk,
        pressaoBar: p.pressaoBar,
        ladoAtivo: p.robo.lado1 ? 1 : p.robo.lado2 ? 2 : 0,
        almBalanca: p.almBalanca,
        seladoraDesabilitada: p.celula.seladoraDesabilitada,
      },
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
