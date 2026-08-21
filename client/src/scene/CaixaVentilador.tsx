// ============================================================================
//  A caixa do ventilador Multi Turbo 40 cm — UMA definição, usada na esteira,
//  na garra e na pilha.
//
//  A estampa é textura procedural desenhada num canvas: o quadrado azul com o
//  M branco (o ícone da Multi) nas duas faces grandes e no topo — o topo é o
//  que aparece na vista de cima do palete. As texturas são geradas UMA vez e
//  compartilhadas por todas as caixas.
//
//  A separação entre caixas vem de dois lugares: a caixa é desenhada uns mm
//  menor que o passo da pilha (folga física real) e as arestas ganham linha.
// ============================================================================
import { useMemo } from "react";
import * as THREE from "three";
import { Edges } from "@react-three/drei";

const PAPELAO = "#A97C4B";
const PAPELAO_SOMBRA = "#5E4227";
const LOGO = "#161616";          // o quadrado do M — impresso em preto

function fundoPapelao(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = PAPELAO;
  g.fillRect(0, 0, w, h);
  // ondulação sutil do papelão
  g.fillStyle = "rgba(0,0,0,0.045)";
  for (let y = 0; y < h; y += 14) g.fillRect(0, y, w, 5);
}

/** O M da Multi: traço contínuo — haste esquerda sobe, pico redondo, desce
 *  ao VALE em U no centro (quase até a base), sobe, pico redondo, haste
 *  direita desce. Pontas redondas, como no ícone. */
function desenhaM(g: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  const yT = cy - s * 0.36;          // topo dos picos
  const yB = cy + s * 0.36;          // pé das hastes
  const yV = cy + 0.30 * s;          // fundo do vale, um pouco acima dos pés
  const rp = s * 0.115;              // raio dos picos
  const rv = s * 0.09;               // raio do vale
  const xHst = s * 0.32;             // hastes externas em ±xHst

  g.strokeStyle = "#FFFFFF";
  g.lineWidth = s * 0.15;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(cx - xHst, yB);
  g.lineTo(cx - xHst, yT + rp);
  g.arc(cx - xHst + rp, yT + rp, rp, Math.PI, 0);        // pico esquerdo
  g.lineTo(cx - rv, yV - rv);
  g.arc(cx, yV - rv, rv, Math.PI, 0, true);              // o vale em U
  g.lineTo(cx + rv, yT + rp);
  g.arc(cx + xHst - rp, yT + rp, rp, Math.PI, 0);        // pico direito
  g.lineTo(cx + xHst, yB);
  g.stroke();
}

function logoMulti(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.fillStyle = LOGO;
  g.beginPath();
  g.roundRect(x, y, s, s, s * 0.16);
  g.fill();
  desenhaM(g, x + s / 2, y + s / 2, s * 0.78);
}

function texturaFace(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 512;
  const g = cv.getContext("2d")!;
  fundoPapelao(g, 512, 512);

  logoMulti(g, 176, 88, 160);

  g.fillStyle = "#503A22";
  g.textAlign = "center";
  g.font = "700 58px 'IBM Plex Sans', sans-serif";
  g.fillText("Multi", 256, 342);
  g.font = "600 27px 'IBM Plex Sans', sans-serif";
  g.fillText("TURBO 40CM", 256, 386);

  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

function texturaTopo(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 160;
  const g = cv.getContext("2d")!;
  fundoPapelao(g, 512, 160);

  logoMulti(g, 34, 33, 94);

  g.fillStyle = "#503A22";
  g.textAlign = "left";
  g.font = "700 44px 'IBM Plex Sans', sans-serif";
  g.fillText("Multi", 156, 82);
  g.font = "600 22px 'IBM Plex Sans', sans-serif";
  g.fillText("TURBO 40CM", 156, 118);

  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

// Materiais compartilhados por TODAS as caixas — criados uma vez.
// Ordem das faces do boxGeometry: +x, -x, +y (topo), -y, +z, -z.
let cache: THREE.Material[] | null = null;
function materiais(): THREE.Material[] {
  if (cache) return cache;
  const lisa = new THREE.MeshStandardMaterial({ color: PAPELAO, roughness: 0.8 });
  const face = new THREE.MeshStandardMaterial({ map: texturaFace(), roughness: 0.8 });
  const topo = new THREE.MeshStandardMaterial({ map: texturaTopo(), roughness: 0.8 });
  cache = [lisa, lisa, topo, lisa, face, face];
  return cache;
}

export function CaixaVentilador({ w, h, d }: { w: number; h: number; d: number }) {
  const mats = useMemo(materiais, []);
  return (
    <mesh material={mats} castShadow receiveShadow>
      {/* uns mm menor que o passo da pilha: a folga real entre caixas */}
      <boxGeometry args={[w - 10, h - 6, d - 10]} />
      <Edges threshold={15} color={PAPELAO_SOMBRA} />
    </mesh>
  );
}
