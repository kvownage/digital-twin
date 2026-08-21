// ============================================================================
//  Painel lateral: estado, juntas, TCP, fases da paletização e controles.
//  Texto vem do estado React (25 Hz já é mais do que o olho pede).
// ============================================================================
import type { RobotLink } from "../lib/useRobot";

const fmt = (n: number, d: number) =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

function Ro({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="ro">
      <label>{label}</label>
      <output>
        {value}
        <small>{unit}</small>
      </output>
    </div>
  );
}

export function Panel({ robot }: { robot: RobotLink }) {
  const st = robot.state;
  const moving = Boolean(st && st.running && st.speed > 2);
  const trocando = st?.phase === -1;

  return (
    <aside>
      <section className="card">
        <div className={"state" + (moving ? " on" : "") + (st?.emergencia ? " emerg" : "")}>
          <span className="lamp" />
          <b>
            {!robot.connected
              ? "SEM COMUNICAÇÃO"
              : st?.emergencia
                ? "CÉLULA EM EMERGÊNCIA"
                : trocando
                  ? "TROCA DE PALETES"
                  : moving
                    ? "EM MOVIMENTO"
                    : "PARADO"}
          </b>
        </div>
        {/* Sem mostradores de junta, TCP e velocidade: em modo REAL esses
            números são GERADOS pelo gêmeo, não medidos no robô. Número que
            ninguém mediu não vai para a tela de quem opera. */}
      </section>

      <section className="card">
        <div className="card-title">PALETIZAÇÃO</div>
        <div className="readouts">
          <Ro label="CAIXA" value={st ? `${st.boxIndex + 1}/${st.boxTotal}` : "—"} unit="" />
          <Ro label="PALETE A" value={st ? `${st.countA}/${st.boxTotal / 2}` : "—"} unit="" />
          <Ro label="PALETE B" value={st ? `${st.countB}/${st.boxTotal / 2}` : "—"} unit="" />
          <div className="ro full">
            <label style={st?.feed?.status === "REPROVADA" ? { color: "#E5484D" } : undefined}>
              BALANÇA TOLEDO{st?.feed ? ` · ${st.feed.status}` : ""}
            </label>
            <output>
              {st && st.peso > 0 ? fmt(st.peso, 2) : "—"}
              <small>kg</small>
            </output>
          </div>
        </div>
        <ol className="steps">
          {robot.phases.map((name, i) => (
            <li
              key={i}
              className={st && !trocando && i === st.phase ? "now" : ""}
            >
              {name}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <div className="card-title">
          FONTE DE DADOS
          {st?.fonte === "real" && !st.realOk ? " · SEM DADOS" : ""}
        </div>
        <div className="controls">
          <div className="dev-row">
            <button
              className={st?.fonte === "real" ? "ativo" : ""}
              disabled={!robot.connected}
              onClick={() => robot.send({ cmd: "fonte", value: "real" })}
            >
              REAL {st?.realOk ? "●" : "○"}
            </button>
            <button
              className={st?.fonte !== "real" ? "ativo" : ""}
              disabled={!robot.connected}
              onClick={() => robot.send({ cmd: "fonte", value: "sim" })}
            >
              SIMULADOR
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-title">SIMULAÇÃO</div>
        <div className="controls">
          <button
            disabled={!robot.connected}
            onClick={() => robot.send({ cmd: "run", value: !(st?.running ?? true) })}
          >
            {st?.running ?? true ? "PAUSAR" : "INICIAR"}
          </button>
          <div className="vel">
            <label>RITMO</label>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={st?.ritmo ?? 45}
              onChange={(e) => robot.send({ cmd: "ritmo", value: Number(e.target.value) })}
            />
            <output>{st?.ritmo ?? 45} %</output>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-title">DESENVOLVIMENTO</div>
        <div className="controls">
          <div className="dev-row">
            <button disabled={!robot.connected} onClick={() => robot.send({ cmd: "preview" })}>
              PRÉVIA DO PADRÃO
            </button>
            <button disabled={!robot.connected} onClick={() => robot.send({ cmd: "reset" })}>
              REINICIAR
            </button>
          </div>
          <div className="vel">
            <label>TURBO</label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={st?.turbo ?? 1}
              onChange={(e) => robot.send({ cmd: "turbo", value: Number(e.target.value) })}
            />
            <output>{st?.turbo ?? 1}×</output>
          </div>
        </div>
      </section>
    </aside>
  );
}
