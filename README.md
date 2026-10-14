# RabbitMQ Lab

Laboratório para entender, na prática e na AWS, o fluxo de eventos por RabbitMQ:

- uma **API** publica eventos de visitas (`company.<id>.visit.created`);
- cada **empresa** pode ter uma **fila própria** com um **usuário que só consome** essa fila;
- uma **empresa mãe** recebe na fila dela também os eventos das **empresas filhas**;
- a **integração do cliente** conecta no Rabbit pela internet e consome a fila, **sem abrir porta nenhuma do lado dela**;
- um **gerador de carga** publica milhares de eventos por segundo para você ver os limites na prática.

```
                    VPC (rede privada da AWS)
   ┌─────────────────────────────────────────────────────────┐
   │                                                         │
   │   EC2 "app"                         EC2 "rabbit"        │
   │  ┌──────────────┐   5672 (privado) ┌────────────────┐   │
   │  │ API + React  │ ───────────────▶ │   RabbitMQ     │   │
   │  │  porta 80    │   15672 (admin)  │                │   │
   │  └──────────────┘ ───────────────▶ └────────────────┘   │
   │         ▲                                  ▲            │
   └─────────┼──────────────────────────────────┼────────────┘
             │ HTTP (navegador)                 │ 5672 (etapa 1) ou
             │                                  │ 5671 TLS (etapa 2)
        você no navegador              consumer/ (simula o cliente,
                                       roda no seu notebook)
```

| Pasta | O que é | Onde roda |
|---|---|---|
| `rabbit/` | RabbitMQ em Docker | EC2 "rabbit" |
| `app/` | API Node (Express) + front React | EC2 "app" |
| `consumer/` | Script que simula a integração do cliente | Seu notebook |

### O que é igual e o que muda em relação à infra da empresa

| No lab | Na empresa | Muda algo no Rabbit? |
|---|---|---|
| 1 EC2 com a API | Beanstalk (N instâncias que sobem e caem) + ALB | **Não.** Cada instância abre a própria conexão AMQP com o Rabbit. O ALB só cuida do HTTP e não participa do AMQP. |
| SG do Rabbit libera 5672 para o SG "app" | SG do Rabbit libera 5672 para o SG do Beanstalk | Mesma ideia: liberar por **Security Group** e não por IP, porque as instâncias do Beanstalk mudam de IP. |
| JSON em arquivo | Postgres | Não. |

---

## Custos (leia antes)

- 2× `t3.micro`. Verifique se a sua conta ainda tem free tier, porque as regras mudaram para contas novas.
- **IPv4 público é cobrado** por hora (~US$ 0,005/h por IP), mesmo no free tier.
- **Pare ou termine as instâncias quando terminar.** Veja [Limpeza](#limpeza).

---

## Passo 1: IAM role (SSM) e Security Groups

No console da AWS, escolha **uma região** (ex.: `us-east-1`) e use sempre ela.

Para acessar as máquinas usamos o **SSM Session Manager**, não SSH: sem porta 22 aberta, sem arquivo `.pem` e com acesso controlado pelo IAM.

1. **IAM → Roles → Create role**
   - Trusted entity: **AWS service → EC2**
   - Permissão: **`AmazonSSMManagedInstanceCore`**
   - Nome: `lab-ec2-ssm`

   > O Amazon Linux 2023 já vem com o SSM Agent instalado. A instância só precisa da role e de saída para a internet (IP público na VPC default resolve).

2. **EC2 → Security Groups → Create**, na VPC default.

   **`sg-lab-app`** (API):

   | Tipo | Porta | Origem | Por quê |
   |---|---|---|---|
   | HTTP | 80 | My IP | você abrir a tela no navegador |

   **`sg-lab-rabbit`** (RabbitMQ):

   | Tipo | Porta | Origem | Por quê |
   |---|---|---|---|
   | Custom TCP | 5672 | **`sg-lab-app`** (selecione o SG, não um IP) | API publica pela rede privada |
   | Custom TCP | 15672 | **`sg-lab-app`** | API cria usuários e filas |
   | Custom TCP | 5672 | My IP | **etapa 1**: o consumer no seu notebook (sem TLS, só para o lab) |

   Repare que **não tem porta 22** e que o painel (15672) **não fica aberto para a internet**. Você vai acessar o painel por um túnel do SSM (Passo 2), igual faria em produção.

   > "My IP" é o IP da sua internet agora. Se ele mudar (outra rede, roteador reiniciou), atualize as regras.

3. **No seu notebook** (para o túnel do painel): instale a [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) e o [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html), e rode `aws configure` com um usuário da sua conta.

---

## Passo 2: EC2 do RabbitMQ

1. **EC2 → Launch instance**
   - Nome: `lab-rabbit`
   - AMI: **Amazon Linux 2023**
   - Tipo: `t3.micro`
   - Key pair: **Proceed without a key pair**
   - Network: VPC default, **Auto-assign public IP: Enable**
   - Security group: **`sg-lab-rabbit`**
   - Advanced details → **IAM instance profile: `lab-ec2-ssm`**
   - Storage: 8 GB está bom

2. Anote o **IP público** e o **IP privado** (aba *Details* da instância).

3. Conecte: selecione a instância → **Connect → Session Manager → Connect**. Leva 1–2 minutos depois de criar até o botão liberar.

   A sessão abre como `ssm-user` num `sh`. Troque para o `ec2-user`, para todos os comandos ficarem iguais:

   ```bash
   sudo su - ec2-user
   ```

4. Instale o Docker:

   ```bash
   sudo dnf install -y git
   git clone https://github.com/SEU_USUARIO/rabbitmq-lab.git
   cd rabbitmq-lab
   ./scripts/setup-ec2.sh
   exit                   # volta para o ssm-user
   sudo su - ec2-user     # entra de novo para o grupo docker valer
   ```

5. Suba o RabbitMQ:

   ```bash
   cd rabbitmq-lab/rabbit
   cp .env.example .env
   nano .env          # troque a senha do admin
   docker compose up -d
   docker compose logs -f    # espere "Server startup complete", depois Ctrl+C
   ```

6. **Painel do Rabbit pelo túnel do SSM.** No seu notebook:

   ```bash
   aws ssm start-session --target ID_DA_INSTANCIA_RABBIT \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["15672"],"localPortNumber":["15672"]}'
   ```

   Deixe esse terminal aberto, acesse `http://localhost:15672` e entre com o admin do `.env`. Esse é o painel do Rabbit, e você vai usar bastante.

   > O ID da instância aparece no console, no formato `i-0abc123...`. O túnel passa pelo SSM: a 15672 não está aberta para a internet.

---

## Passo 3: EC2 da API

1. **Launch instance** igual à anterior (sem key pair, com a role `lab-ec2-ssm`), mas com nome `lab-app` e Security group **`sg-lab-app`**.

2. Conecte pelo Session Manager e instale:

   ```bash
   sudo su - ec2-user
   sudo dnf install -y git
   git clone https://github.com/SEU_USUARIO/rabbitmq-lab.git
   cd rabbitmq-lab
   ./scripts/setup-ec2.sh
   exit
   sudo su - ec2-user
   ```

3. Configure e suba:

   ```bash
   cd rabbitmq-lab/app
   cp .env.example .env
   nano .env
   ```

   - `RABBITMQ_URL` e `RABBITMQ_MANAGEMENT_URL`: use o **IP privado** do Rabbit.
   - `RABBITMQ_PUBLIC_URL`: use o **IP público** do Rabbit (`amqp://IP_PUBLICO:5672`).

   ```bash
   docker compose up -d --build
   docker compose logs -f    # deve aparecer "[rabbitmq] conectado"
   ```

4. Abra `http://IP_PUBLICO_DO_APP`. O topo da tela deve ficar verde: **"API conectada ao RabbitMQ"**.

> Se o build travar por falta de memória na `t3.micro`, crie 1 GB de swap:
> `sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

---

## Passo 4: Consumer (o "cliente") no seu notebook

1. Na tela, crie uma empresa e clique em **"Ligar fila"**.
2. Aparecem as credenciais. **Copie agora, porque a senha não aparece de novo.**
3. No seu notebook (Node 20+):

   ```bash
   cd rabbitmq-lab/consumer
   npm install
   cp .env.example .env
   # cole RABBITMQ_URL e QUEUE que apareceram na tela
   npm start
   ```

4. Crie uma visita na tela. Ela aparece no terminal do consumer.

O consumer **abriu uma conexão de saída** até o Rabbit. Seu notebook não abriu porta nenhuma. É assim que a integração do cliente vai funcionar.

---

## Experimentos

Esse é o objetivo do lab. Faça com o painel do Rabbit (túnel do SSM em `localhost:15672`, aba *Queues*) aberto ao lado. Os comandos `docker ...` são rodados numa sessão do Session Manager na instância indicada.

### 1. Cliente offline não perde eventos
1. Pare o consumer (Ctrl+C).
2. Clique em **"Criar 10"**. Na tela, "esperando na fila" vai para 10.
3. Rode `npm start` de novo: as 10 chegam.

### 2. A API cai, o Rabbit continua (o caso do Beanstalk)
1. Na EC2 app: `docker restart rabbitmq-lab-app`.
2. Mensagens que já estavam na fila continuam lá. A API reconecta sozinha.

### 3. O Rabbit cai
1. Na EC2 rabbit: `docker stop rabbitmq`. O topo da tela fica vermelho e o consumer mostra "desconectado".
2. Crie 3 visitas. A tela mostra **"3 publicações presas na memória da API"**.
3. `docker start rabbitmq`. As 3 são enviadas, o consumer reconecta e recebe.

### 4. O Rabbit cai **e** a API reinicia (perda de eventos)
1. `docker stop rabbitmq` e crie 3 visitas (ficam presas na memória).
2. Na EC2 app: `docker restart rabbitmq-lab-app`.
3. `docker start rabbitmq`. **As 3 se perderam**, porque estavam só na memória do processo.

> Isso pode acontecer em produção se uma instância do Beanstalk cair enquanto o Rabbit está fora. A solução clássica é o *outbox pattern*: gravar o evento no banco na mesma transação e publicar depois. Vale entender o risco antes de decidir se precisa.

### 5. Ack: mensagem não processada volta para a fila
1. No `consumer/.env`, coloque `PROCESSING_MS=3000` e rode de novo.
2. Clique em **"Criar 10"** e dê Ctrl+C no meio.
3. Rode de novo: as que não tinham recebido ack chegam marcadas como **(reentregue)**.

### 6. Persistência: reiniciar o Rabbit não apaga a fila
1. Pare o consumer e crie 5 visitas.
2. `docker restart rabbitmq`. As 5 continuam lá (fila `durable` + mensagem `persistent`).

### 7. Isolamento entre empresas
1. Crie uma segunda empresa e ligue a fila dela.
2. No `consumer/.env`, mantenha o `RABBITMQ_URL` da empresa A e troque o `QUEUE` para a fila da empresa B.
3. O Rabbit recusa com **ACCESS_REFUSED**: uma empresa não lê a fila da outra.

### 8. Desligar a fila corta o cliente
1. Com o consumer rodando, clique em **"Desligar fila"**.
2. O consumer cai e não consegue mais conectar, porque o usuário foi apagado.

### 9. Empresa sem fila
Crie visitas numa empresa com a fila desligada. A API publica normalmente, mas o Rabbit descarta (ninguém está ligado àquele routing key). No painel, aba *Exchanges* → `lab.events`, dá para ver as mensagens entrando sem destino.

---

## Experimentos: empresa mãe e filhas

Igual ao projeto real: uma empresa é **filha** quando tem `parentCompanyId`, e só existe um nível (filha não tem filhas).

**Como funciona:** a fila da mãe fica ligada (*binding*) a `company.<idMae>.#` **e** a `company.<idFilha>.#` de cada filha. O próprio Rabbit copia os eventos das filhas para a fila da mãe, e a API continua publicando uma vez só. No consumer, o nome ao lado de cada evento mostra de qual empresa ele veio.

### 10. A mãe recebe os eventos da filha
1. Crie a empresa **Mãe** e clique em **Ligar fila**. Rode o consumer com as credenciais dela.
2. Crie a empresa **Filha 1**, escolhendo "Filha de Mãe" no seletor.
3. Crie uma visita na **Filha 1**. Ela chega no consumer da Mãe, marcada como `Filha 1`.
4. No card da Mãe aparece "Esta fila também recebe os eventos de: Filha 1". No painel do Rabbit: *Queues* → `company.<idMae>` → *Bindings*.

### 11. Filha criada depois que a mãe já tem fila
1. Com a fila da Mãe ligada, crie a **Filha 2**.
2. O binding é adicionado na hora (veja no painel). Crie uma visita na Filha 2: ela chega na Mãe.

> No projeto real, isso é o `syncParentEventStreamBinding`.

### 12. A mãe liga a fila depois que as filhas já existem
1. Desligue a fila da Mãe, crie visitas nas filhas (vão para lugar nenhum) e ligue a fila de novo.
2. A fila nasce ligada a todas as filhas atuais. Repare que as visitas criadas enquanto estava desligada não chegam: a fila não existia.

### 13. A filha também tem fila própria
1. Ligue a fila da **Filha 1** e copie as credenciais para um segundo arquivo, por exemplo `consumer/.env.filha`.
2. Rode um segundo consumer em outro terminal: `node --env-file=.env.filha index.js`.
3. Crie uma visita na Filha 1: **os dois consumers recebem**, cada fila com a sua cópia.
4. Crie uma visita na Mãe: só o consumer da Mãe recebe, porque a filha não vê os eventos da mãe.

### 14. Removendo uma filha
Clique em **Remover** na Filha 2. O binding sai da fila da Mãe. Não dá para remover a Mãe enquanto ela tiver filhas.

---

## Experimentos: volume (teste de carga)

O painel **Teste de carga** publica eventos `visit.created` sintéticos direto no Rabbit, numa taxa fixa (até 5.000/s) e em round-robin entre as empresas escolhidas. Esses eventos não são gravados no "banco" do lab, porque o gargalo seria o arquivo JSON e não o Rabbit.

Para volume alto, rode o consumer em **modo stats**, que mostra um resumo por segundo em vez de uma linha por evento:

```bash
MODE=stats npm start
# 10:31:02 498/s | total 12450 | latência média 162ms, máx 410ms | Mãe=6225 Filha 1=6225
```

Durante os testes, deixe aberto:
- o card do teste (publicadas × **confirmadas pelo Rabbit** × presas na memória da API);
- o card da empresa ("esperando na fila", "chegando/s", "consumidas/s");
- o painel do Rabbit, aba *Overview* (gráfico de *Message rates*);
- na EC2 rabbit: `docker stats rabbitmq` (CPU e memória do container).

### Quanto aguenta?

10 eventos/s não chega nem perto do limite. Ordens de grandeza para este lab (mensagens pequenas, persistentes, com confirmação):

| Peça | Limite aproximado | O que limita |
|---|---|---|
| RabbitMQ numa `t3.micro` | centenas a alguns milhares/s | CPU e disco. Os créditos de CPU da `t3` acabam em carga contínua. |
| Gerador da API | até 5.000/s (trava do lab) | um processo Node |
| **Consumer pela internet** | muitas vezes **o menor de todos** | latência de rede × prefetch (experimento 16) |

Não acredite na tabela: o objetivo dos experimentos abaixo é você **medir** na sua conta.

### 15. Carga básica
1. Ligue a fila da Mãe e deixe a Filha 1 como filha dela. Rode o consumer da Mãe com `MODE=stats`.
2. Teste: Mãe + Filha 1, **100/s por 30s** (3.000 eventos).
3. Confira se "confirmadas" chega a 3.000 e se o consumer recebe tudo, metade de cada empresa.

### 16. Prefetch × latência de rede (o mais importante para o cliente)
O consumer só recebe `PREFETCH` mensagens sem ack por vez. Cada ack demora um "ida e volta" pela internet, então a vazão máxima fica em torno de **prefetch ÷ latência**. Exemplo: com prefetch 10 e 150 ms até a AWS, são ~65 msg/s.

1. Teste: **500/s por 30s**, consumer com `PREFETCH=10`. "Esperando na fila" cresce, porque o consumer não acompanha.
2. Pare, rode com `PREFETCH=200` e repita. A fila esvazia muito mais rápido.

> Para a integração real do cliente, esse é o ajuste que mais importa. A latência ele não controla, o prefetch sim.

### 17. Consumer lento
1. `PROCESSING_MS=50 PREFETCH=10 MODE=stats npm start`, que simula o cliente gravando cada evento no banco dele.
2. Teste: 300/s por 30s. Quando a chegada é maior que o consumo, **a fila absorve a diferença** e o consumer vai drenando depois. Ninguém perde evento, só atrasa.

### 18. Limite da fila (max-length)
A policy do lab limita cada fila a **100.000 mensagens** (`drop-head`: ao estourar, descarta as **mais antigas**).
1. Pare o consumer.
2. Teste: **2.000/s por 60s** (120.000 eventos).
3. "Esperando na fila" para em 100.000. Rode o consumer: o total recebido é 100.000, e as 20.000 primeiras se perderam.

> Essa é a proteção contra fila abandonada. No projeto real, vale definir esse número junto com o cliente (quantos dias offline ele pode ficar).

### 19. Achar o limite do Rabbit
1. Com o consumer em `MODE=stats` e `PREFETCH=200`, aumente a taxa: 500, 1.000, 2.000, 5.000/s, por 30s cada.
2. Quando "confirmação real" ficar abaixo do pedido, ou "presas na memória da API" começar a subir, você achou o teto.
3. Olhe `docker stats rabbitmq` e, no CloudWatch da instância, a métrica **CPUCreditBalance**. Se os créditos zerarem, a `t3` fica limitada a ~10% de CPU e a vazão despenca.

### 20. Rabbit cai no meio da carga
1. Teste: 500/s por 60s. No meio, `docker stop rabbitmq` na EC2 rabbit.
2. "Presas na memória da API" sobe rápido (veja o uso de memória do container da API com `docker stats`).
3. `docker start rabbitmq`: tudo é enviado. Se a API reiniciasse nesse intervalo, tudo se perderia (experimento 4, em escala).

---

## Etapa 2: TLS (cliente pela internet com segurança)

Na etapa 1, a senha do cliente trafega sem criptografia na 5672. Para fazer do jeito certo:

1. **Domínio grátis para teste:** use o [sslip.io](https://sslip.io). Se o IP público do Rabbit é `3.91.10.20`, o domínio `3-91-10-20.sslip.io` já aponta para ele, sem configurar nada.

2. No `sg-lab-rabbit`, adicione:
   - **80** de `0.0.0.0/0` (temporário: o Let's Encrypt precisa validar o domínio);
   - **5671** de My IP.

3. Na EC2 rabbit:

   ```bash
   cd rabbitmq-lab/rabbit
   ./scripts/issue-cert.sh 3-91-10-20.sslip.io seu@email.com
   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
   ```

4. **Remova a regra da porta 80** e **a regra 5672 de My IP**. A partir daqui, o cliente só usa a 5671.

5. Na EC2 app, em `app/.env`: `RABBITMQ_PUBLIC_URL=amqps://3-91-10-20.sslip.io:5671`, depois `docker compose up -d`.

6. Desligue e ligue a fila da empresa para gerar credenciais novas, já com `amqps://`. Atualize o `consumer/.env` e rode. Repare que a API continua usando a 5672 privada, sem TLS, porque esse tráfego nunca sai da VPC.

> **Testar a porta 443:** em `docker-compose.tls.yml`, troque `5671:5671` por `443:5671`, libere a 443 no SG e use `amqps://...:443`. É útil quando o firewall do cliente só libera saída na 443.

> O certificado vale 90 dias. Para renovar, rode o `issue-cert.sh` de novo (com a porta 80 aberta) ou coloque no cron.

> **IP público muda** quando você para e liga a instância. Isso muda o domínio do sslip.io e o `.env`. Para não mudar, use um **Elastic IP** (cobrado enquanto existir).

---

## Rodar tudo local (sem AWS)

```bash
# RabbitMQ
cd rabbit && cp .env.example .env && docker compose up -d

# API (Node 20+)
cd app && cp .env.example .env
# no .env: troque IP_PRIVADO_DO_RABBIT e IP_PUBLICO_DO_RABBIT por localhost
cd api && npm install && npm run dev

# Front (outro terminal)
cd app/web && npm install && npm run dev   # abre em http://localhost:5173

# Consumer (outro terminal)
cd consumer && npm install && cp .env.example .env && npm start
```

---

## Limpeza

- **EC2 → Instances** → selecione as duas → **Terminate**.
- Libere Elastic IPs, se criou.
- Apague os Security Groups e a role `lab-ec2-ssm`, se quiser.

---

## Onde está cada conceito no código

| Conceito | Arquivo |
|---|---|
| Conexão com reconexão automática + publish | `app/api/src/rabbitmq.js` |
| Criar/remover usuário, fila, permissão e policy por empresa | `app/api/src/rabbitmqAdmin.js` |
| Ligar/desligar a fila (Rabbit antes do banco) | `app/api/src/server.js` (`PATCH /event-stream`) |
| Empresa mãe recebendo eventos das filhas (bindings) | `app/api/src/rabbitmqAdmin.js` (`reconcileBindings`, `bindChildToParentQueue`) |
| Gerador de carga com publisher confirms | `app/api/src/loadTest.js` |
| Cliente consumindo com prefetch e ack (+ modo stats) | `consumer/index.js` |
| TLS no Rabbit | `rabbit/rabbitmq-tls.conf`, `rabbit/docker-compose.tls.yml` |
