// ============================================================================
//  Motor de movimento PTP sincronizado — o mesmo do simulador, isolado para
//  poder ser dirigido de fora.
//
//  Serve ao GÊMEO DIGITAL: em modo REAL não lemos os ângulos do robô (o
//  YRC1000 não os manda ao CLP), então GERAMOS o movimento aqui e deixamos os
//  SINAIS DA LINHA decidirem quando cada trecho começa. O que se vê na tela é
//  cinemática de verdade do GP12, disparada pelos eventos de verdade da célula.
// ============================================================================
import { VMAX, JACC } from "./simulator.js";

type J3 = [number, number, number];

export class Ptp {
  j: J3;
  chegou = true;
  private de: J3;
  private alvo: J3;
  private prog = 0;
  private jv = 0;

  constructor(inicial: J3 = [0, -5, -50]) {
    this.j = [...inicial] as J3;
    this.de = [...inicial] as J3;
    this.alvo = [...inicial] as J3;
  }

  /** Novo destino. Repetir o mesmo destino não reinicia o trajeto. */
  goTo(alvo: J3) {
    if (alvo[0] === this.alvo[0] && alvo[1] === this.alvo[1] && alvo[2] === this.alvo[2]) return;
    this.de = [...this.j] as J3;
    this.alvo = [...alvo] as J3;
    this.prog = 0;
    this.chegou = false;
  }

  /**
   * Um passo de dt segundos, a `ritmo` % da velocidade de junta do datasheet.
   * Cada delta é pesado pela velocidade da própria junta e a mais lenta para
   * o seu trajeto governa o tempo de todas — PTP sincronizado, como no
   * YRC1000.
   */
  step(dt: number, ritmo = 100) {
    const d = [0, 1, 2].map((i) => this.alvo[i] - this.de[i]);
    const peso = [VMAX.L / VMAX.S, 1, VMAX.L / VMAX.U];
    const D = Math.max(...d.map((v, i) => Math.abs(v) * peso[i]));

    if (this.prog >= D) {
      this.jv = 0;
      this.chegou = true;
      this.j = [...this.alvo] as J3;
      return;
    }

    const vTop = VMAX.L * (ritmo / 100);
    const freio = Math.sqrt(2 * JACC * (D - this.prog));
    const vAlvo = Math.min(vTop, freio);
    this.jv = this.jv < vAlvo
      ? Math.min(vAlvo, this.jv + JACC * dt)
      : Math.max(vAlvo, this.jv - JACC * dt);
    this.prog = Math.min(D, this.prog + this.jv * dt);

    const f = D === 0 ? 1 : this.prog / D;
    this.j = [0, 1, 2].map((i) => this.de[i] + d[i] * f) as J3;
    if (this.prog >= D) this.chegou = true;
  }
}
