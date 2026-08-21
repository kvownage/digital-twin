# Gateway em ARQUIVO ÚNICO — o pacote do PC da fábrica

Esta é a via que **funciona** no PC que fica com o gateway. A outra
(`LEIA-ME.md`, com `npm install`) só serve numa máquina com internet e sem
bloqueio de rede — e o PC da célula não é nenhuma das duas coisas:

- **não alcança o npm**, então `npm install` e `npx tsx` não funcionam;
- a rede **barra executáveis** em pasta compartilhada, então `.exe`, `.cmd`,
  `.dll` e `.node` não atravessam — e `node_modules` está cheio deles
  (o `esbuild` traz binário próprio).

A saída é empacotar tudo em dois arquivos de JavaScript puro. Sem
`node_modules`, sem `tsx`, sem um único executável. O PC precisa apenas ter o
**Node.js** instalado.

## 1. Gerar o pacote (na máquina de desenvolvimento)

```
npm install
npm run pacote-gateway
```

Saem dois arquivos em `dist-gateway/`:

| arquivo | para quê |
|---|---|
| `index.cjs` | o gateway: lê o CLP e publica no broker |
| `testa-modbus.cjs` | o teste dos três degraus, antes de pôr em operação |

`dist-gateway/` é artefato de build e não vai para o Git — se precisar dele
outra vez, rode o comando de novo. É por isso que a receita mora no
`package.json` e não num arquivo de texto solto: assim ela é versionada junto
com o código que ela empacota.

## 2. Levar para o PC do gateway

Copie para uma pasta local **do PC** (não rode de pasta de rede):

```
index.cjs
testa-modbus.cjs
.env          <- copie de gateway/.env.example e preencha
```

No `.env` só duas linhas precisam ser preenchidas:

```
PLC_IP=192.168.___.___      o IP do S7 na rede
MQTT_PASS=                  a senha do broker
```

O resto já vem pronto: porta 503, usuário, tópico, cluster.

## 3. Testar ANTES de pôr em operação

```
node testa-modbus.cjs
```

| degrau | falhou? |
|---|---|
| 1/3 conecta na porta 503 | CLP em STOP, IP errado, ou a 2ª instância `MB_SERVER` ainda não existe no CLP |
| 2/3 lê as holdings | firewall no caminho |
| 3/3 HR26 mudou | CLP em STOP com Modbus vivo, ou a FC 07 não é chamada no `Main [OB1]` |

O terceiro degrau é o que importa: **Modbus responde igual com o CPU em STOP**.
Só um contador andando prova que o programa roda. Passando os três, ele imprime
as words traduzidas — compare com o watch do TIA, tem de bater 1:1.

## 4. Operação

```
node index.cjs
```

Esperado:

```
[gateway] broker OK: mqtts://...hivemq.cloud:8883
[gateway] CLP OK: 192.168.x.x:503
[gateway] lendo HR0..HR34, publicando em multilaser/...
```

Enquanto a janela estiver aberta, o gateway trabalha. Fechar para a publicação,
e o supervisório mostra SEM DADOS REAIS em cinco segundos — comportamento
correto, não defeito.

Para rodar sozinho, **Agendador de Tarefas do Windows**:

| campo | valor |
|---|---|
| Gatilho | Ao iniciar o computador |
| Ação | `cmd.exe` |
| Argumentos | `/c node index.cjs >> gateway.log 2>&1` |
| Iniciar em | a pasta do pacote |

Em *Configurações*, marque "reiniciar a cada 1 min se falhar". Em *Condições*,
**desmarque** "somente na tomada". E use o `>> gateway.log`: sem log em
arquivo, quando algo falhar de madrugada não haverá o que ler.

## Sintoma → causa

| na tela | o que é |
|---|---|
| `ECONNREFUSED` | CLP em STOP, IP errado, ou firewall na porta 503 |
| `ETIMEDOUT` | IP não existe na rede, ou a 2ª instância `MB_SERVER` não foi criada |
| `Not authorized` | `MQTT_PASS` vazia ou errada |
| `Missing protocol` | falta `mqtts://` no `MQTT_URL` |
| conecta, mas a tela diz SEM DADOS REAIS | HR26 congelado: CPU em STOP ou a FC 07 não é chamada no `Main` |
| `DeprecationWarning` sobre `url.parse()` | da biblioteca MQTT, inofensivo |
