# Chrome DevTools MCP Server (Cloudflare Workers)

Um servidor MCP remoto que dá ao Claude o controle de um Chrome headless — o
**Browser Rendering** da Cloudflare — como ferramentas: navegar, inspecionar a
árvore de acessibilidade, clicar, preencher formulários, ler console e rede,
executar JavaScript na página.

É o equivalente remoto do
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
oficial. O oficial roda localmente por stdio e controla o Chrome instalado na
sua máquina; este roda como Worker, controla um Chromium gerenciado pela
Cloudflare e o Claude se conecta por HTTP com OAuth.

---

## Custo — leia antes de ativar

O Browser Rendering **cobra por tempo de navegador aberto**, não por comando
executado. Um Chromium parado esperando o próximo `click` custa igual a um
trabalhando.

| Plano | Duração inclusa | Concorrência inclusa | Excedente |
| --- | --- | --- | --- |
| Workers Free | **10 minutos por dia** | 3 navegadores | não cobra — recusa |
| Workers Paid | **10 horas por mês** | 10 navegadores (média mensal) | **US$ 0,09/hora-navegador** + **US$ 2,00/navegador concorrente** |

Os defaults deste repositório são os do **Workers Free**. Três travas seguram o
gasto, e todas são configuráveis (ver [Configuração](#configuração)):

1. **Orçamento diário** (`BROWSER_DAILY_BUDGET_SECONDS`, 480s). Contado em KV,
   compartilhado por todas as conexões. Estourou, o servidor recusa abrir
   navegador e diz quando o teto zera.
2. **Alarme de ociosidade** (`BROWSER_IDLE_CLOSE_SECONDS`, 45s). Cada chamada de
   ferramenta reprograma um alarme do Durable Object que **fecha** a sessão —
   parar o relógio ativamente, em vez de esperar o `keep_alive` expirar.
3. **Teto de abas** (`BROWSER_MAX_PAGES`, 2). Abas dividem a memória do mesmo
   Chromium; abas demais derrubam a sessão inteira.

A ferramenta `browser_status` mostra o consumo do dia sem abrir navegador
nenhum, e `close_browser_session` encerra na hora. O número oficial está sempre
no painel: **Compute > Browser Run**.

> A contagem daqui é uma estimativa: KV não é transacional, então duas sessões
> abrindo no mesmo instante podem contar uma escrita a menos. Ela existe para
> evitar susto, não para substituir a fatura.

---

## Arquitetura

```
Claude  ──OAuth──▶  Worker (OAuthProvider)  ──▶  Durable Object (McpAgent)
                          │                            │
                          │ /authorize, /callback      │ sessão MCP + estado
                          ▼                            ▼
                    GitHub (identidade)      Browser Rendering (Chromium)
```

**Duas camadas de OAuth**, e confundi-las é o erro clássico:

- **Claude ↔ Worker.** O Claude é um cliente OAuth; ele se registra sozinho
  (DCR em `/register`) e no fim recebe um token **emitido por nós**. Quem cuida
  disso é o `@cloudflare/workers-oauth-provider`.
- **Worker ↔ GitHub.** Diferente do servidor da Twitch que serviu de modelo,
  aqui não há API de terceiro para chamar depois — o navegador é da própria
  Cloudflare. O GitHub entra só como **carteira de identidade**: responde "quem
  é você", o Worker confere contra `ALLOWED_GITHUB_LOGINS`, e o token do GitHub
  é descartado. Nada dele é guardado.

Essa lista é a trava de acesso. O Worker fica numa URL pública e o Claude
registra clientes sozinho: sem ela, qualquer pessoa que descobrisse o endereço
conectaria o próprio Claude e gastaria o seu orçamento — navegando pela sua
conta Cloudflare.

### Três decisões que moldam o código

**Conectar e desconectar a cada chamada.** Uma sessão do Browser Rendering
aceita **uma** conexão de Worker por vez, e o Durable Object pode ser descartado
entre chamadas. O que atravessa é o `sessionId` (no storage do DO), não a
conexão.

**Nada de `ElementHandle` guardado.** Como a conexão morre, o `uid` do snapshot
é **posicional** (`<seq>_<índice na travessia>`) e o snapshot é **refeito** na
hora do clique. Se o nó daquele índice ainda tiver o mesmo papel e nome, é o
mesmo elemento; se não, a ferramenta recusa e pede um snapshot novo — em vez de
clicar no lugar errado. A alternativa seria carimbar `data-mcp-uid` no DOM, ou
seja, escrever na página que se está depurando.

**Console e rede são coletados de dentro da página.** Um `page.on('console')`
morreria junto com a conexão. Em vez disso, um script injetado
(`src/browser/collector.ts`) instrumenta `console.*`, `fetch`, `XHR`,
`PerformanceObserver` e os diálogos, e enche um buffer que drenamos no começo de
cada chamada e guardamos no storage do DO. É por isso que o histórico
**sobrevive às navegações**: o buffer da página some quando o documento troca, o
do Durable Object não.

Um efeito colateral necessário: `alert`/`confirm`/`prompt` são respondidos pelo
próprio coletor (`BROWSER_DIALOG_DEFAULT`, por padrão `dismiss`) e registrados.
Diálogo nativo trava a página até alguém responder, e entre duas chamadas de
ferramenta não há ninguém escutando.

---

## Ferramentas

### Navegação
| Ferramenta | O que faz |
| --- | --- |
| `list_pages` | Lista as abas, com id, URL, título e qual está selecionada |
| `new_page` | Abre uma aba e navega |
| `select_page` | Escolhe a aba usada quando `pageId` é omitido |
| `close_page` | Fecha uma aba (não encerra a sessão) |
| `navigate_page` | URL, voltar, avançar ou recarregar |
| `resize_page` | Muda a viewport |

### Inspeção
| Ferramenta | O que faz |
| --- | --- |
| `take_snapshot` | Árvore de acessibilidade com os `uid` usados pelas interações |
| `take_screenshot` | Imagem da viewport ou da página inteira (JPEG por padrão) |

### Interação
| Ferramenta | O que faz |
| --- | --- |
| `click` | Clique simples ou duplo num `uid` |
| `hover` | Passa o cursor (abre menus e tooltips) |
| `fill` | Preenche pelo papel: texto digita, combobox seleciona, checkbox alterna |
| `fill_form` | Vários campos numa chamada só |
| `type_text` | Digita no elemento em foco |
| `press_key` | `Enter`, `Escape`, `Control+A`… |
| `wait_for` | Espera um texto aparecer |

### Depuração
| Ferramenta | O que faz |
| --- | --- |
| `list_console_messages` | Console, erros de JS, promises rejeitadas e diálogos |
| `list_network_requests` | Requisições com método, status, duração e bytes |
| `evaluate_script` | Executa JavaScript na página e devolve o resultado |

### Sessão (custo)
| Ferramenta | O que faz |
| --- | --- |
| `browser_status` | Consumo do dia, limites e política — sem abrir navegador |
| `close_browser_session` | Encerra a sessão agora e para o relógio |

### O que ficou de fora do projeto oficial, e por quê

O `chrome-devtools-mcp` oficial tem mais de 50 ferramentas porque roda num
Chrome local, com disco e sem conta de custo. Aqui o Chromium é gerenciado,
efêmero e cobrado por minuto:

| Do oficial | Situação | Motivo |
| --- | --- | --- |
| `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight` | **fora** | Um trace é dezenas de MB de eventos e o processamento é caro em CPU — o Worker tem limite de CPU por request e não tem disco para o `filePath` que essas ferramentas assumem. |
| `lighthouse_audit` | **fora** | Mesma razão, multiplicada: uma auditoria roda vários carregamentos completos. Num free tier de 10 min/dia, uma auditoria consumiria boa parte do dia. |
| As 13 de heap snapshot | **fora** | Um heap snapshot chega a centenas de MB e a API inteira gira em torno de arquivos abertos entre chamadas. Não há sistema de arquivos. |
| `screencast_start` / `screencast_stop` | **fora** | Vídeo precisa de escrita em disco e de conexão contínua com o navegador — e a nossa conexão fecha a cada chamada. |
| `install_extension` e as demais de extensão | **fora** | Extensão exige carregar diretório não empacotado num Chrome que você controla. O Chromium da Cloudflare é gerenciado. |
| `install_pwa`, `launch_pwa`, `get_os_app_state` | **fora** | Pressupõem um sistema operacional com apps instalados. |
| `upload_file` | **fora** | Recebe caminhos de arquivos locais. O Worker não tem nenhum. |
| `list_3p_developer_tools`, `execute_3p_developer_tool`, `list_webmcp_tools`, `execute_webmcp_tool` | **fora** | Nichos que dependem de a página expor APIs próprias; fora do núcleo da v1. |
| `emulate` | **parcial** | Só `resize_page` (viewport). Emular rede, CPU, geolocalização e user agent é viável por CDP e cabe numa v2. |
| `get_network_request` (corpos) | **parcial** | `list_network_requests` traz método, status, duração e bytes. Corpo de requisição/resposta exigiria interceptação por CDP mantida entre chamadas, o que o modelo de reconexão não sustenta. |
| `handle_dialog` | **substituído** | Os diálogos são respondidos automaticamente pelo coletor e aparecem em `list_console_messages`. Não dá para "segurar" um diálogo esperando outra chamada: ele travaria a página inteira. |
| `drag`, `click_at` | **fora** | Coordenadas cruas são frágeis sem um humano olhando a tela; o caminho por `uid` cobre os casos reais. |

---

## Configuração

Variáveis públicas ficam em `vars` no `wrangler.jsonc`. Secrets, **nunca** —
`wrangler secret put`.

| Variável | Tipo | Default | Para que serve |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | var | — | Client ID do OAuth App do GitHub |
| `GITHUB_CLIENT_SECRET` | **secret** | — | Client Secret do mesmo app |
| `ALLOWED_GITHUB_LOGINS` | var | — | Logins autorizados, separados por vírgula. **Vazio = ninguém entra** |
| `COOKIE_ENCRYPTION_KEY` | **secret** | — | Assina o cookie de "já aprovei este cliente" |
| `BROWSER_DAILY_BUDGET_SECONDS` | var | `480` | Teto de navegador por dia UTC |
| `BROWSER_KEEP_ALIVE_SECONDS` | var | `60` | Quanto a Cloudflare segura o navegador ocioso (60–600) |
| `BROWSER_IDLE_CLOSE_SECONDS` | var | `45` | Ociosidade que dispara o fechamento. Nunca passa do keep_alive |
| `BROWSER_MAX_PAGES` | var | `2` | Abas simultâneas |
| `BROWSER_ALLOWED_DOMAINS` | var | `""` | Domínios permitidos (`example.com,*.github.com`). Vazio = sem restrição |
| `BROWSER_DIALOG_DEFAULT` | var | `dismiss` | Resposta a `alert`/`confirm`/`prompt` |
| `BROWSER_TIMEOUT_MS` | var | `30000` | Timeout de navegação e de `wait_for` |

`BROWSER_ALLOWED_DOMAINS` vira o **`guardrails`** da sessão: a trava é aplicada
pela Cloudflare quando a sessão nasce e **não pode ser afrouxada** por uma
conexão posterior. Vale a pena ligar se o servidor for usado só num punhado de
sites.

### Migrando para o Workers Paid

```jsonc
"BROWSER_DAILY_BUDGET_SECONDS": "1200",  // 20 min/dia ≈ as 10 h/mês inclusas
"BROWSER_KEEP_ALIVE_SECONDS": "180",     // sequências longas ficam mais fluidas
"BROWSER_IDLE_CLOSE_SECONDS": "120",
"BROWSER_MAX_PAGES": "3"
```

Subir o `keep_alive` deixa a automação mais fluida **e** gasta orçamento com o
navegador parado. Os dois efeitos vêm juntos.

---

## Deploy

O guia completo, com telas e ordem dos passos, está no artifact que acompanha o
PR. Resumo:

```bash
# 1. KV (já criados neste repositório — os ids estão no wrangler.jsonc)
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create BROWSER_KV

# 2. OAuth App no GitHub: https://github.com/settings/developers
#    Homepage URL:              https://<worker>.<sub>.workers.dev
#    Authorization callback URL: https://<worker>.<sub>.workers.dev/callback
#    Depois: GITHUB_CLIENT_ID em vars, e o secret:
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32

# 3. Deploy
npx wrangler deploy
```

O **Browser Rendering não precisa ser ativado à mão**: o binding `browser` no
`wrangler.jsonc` habilita o serviço no primeiro deploy. A cobrança começa no
primeiro navegador aberto.

Para deploy automático a cada push, ligue **Workers Builds** no painel
(Workers & Pages → o Worker → Settings → Builds) apontando para o branch — é
configuração de painel, não de API.

No Claude, adicione `https://<worker>.<sub>.workers.dev/mcp` como conector.

### Desenvolvimento local

```bash
cp .dev.vars.example .dev.vars   # preencha os secrets; o arquivo é gitignorado
npm run dev
```

`wrangler dev` sobe o servidor em modo local; as rotas de OAuth e o registro de
ferramentas funcionam inteiros assim. O binding do navegador aparece como
`local`, mas o comportamento dele não foi verificado neste modo — para exercitar
as ferramentas contra o Browser Rendering de verdade **e gastar orçamento de
verdade**, use `npx wrangler dev --remote`.

---

## Verificação

```bash
npm run check      # typecheck + testes + deploy --dry-run
```

- `npm run typecheck` — `tsc --noEmit` em `src/` e `tests/`
- `npm test` — 56 testes, todos com mocks: orçamento contra um KV em memória, o
  script do coletor executado num contexto isolado do Node com um `window` de
  mentira, e o servidor MCP subindo em memória com um cliente MCP real para
  conferir nome, descrição, schema e `annotations` de cada ferramenta.
- `npm run dry-run` — `wrangler deploy --dry-run`, que valida bindings e bundle

O fluxo OAuth foi verificado ponta a ponta contra `wrangler dev` local:
registro dinâmico de cliente, tela de consentimento, cookie de aprovação
(inclusive pulando a tela na reconexão), redirect para o GitHub com o `scope`
certo, e `/mcp` devolvendo 401 sem token.

Nenhum teste abre navegador de verdade — isso custa dinheiro e é decisão de
quem hospeda.

---

## Estrutura

```
src/
  index.ts              Worker: OAuthProvider + Durable Object, alarme de ociosidade
  config.ts             Travas de custo, com default, faixa e grampo
  types.ts              Env, props do grant, tipos persistidos
  auth/
    handler.ts          /, /up, /authorize, /callback
    github.ts           Troca de code por token e leitura de /user
    approval.ts         Cookie assinado de cliente aprovado
    pages.ts            HTML da home, consentimento e erro
  browser/
    session.ts          Ciclo de vida da sessão, registro de abas, resolução de uid
    budget.ts           Contabilidade do orçamento diário em KV
    collector.ts        Script injetado na página (console, rede, diálogos)
    snapshot.ts         Travessia da árvore e esquema de uid
    network.ts          Fusão das duas fontes de rede
    errors.ts           BrowserToolError
  tools/                Uma ferramenta por seção, registradas em tools/index.ts
tests/                  56 testes, sem rede e sem navegador
```
