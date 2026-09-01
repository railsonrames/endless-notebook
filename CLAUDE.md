# endless-notebook

## Visão geral

Aplicação pessoal de diário/registro de atividades, com visual inspirando caderno de pautas e estética retro de Full Throttle. O fluxo principal hoje é de entrada em linhas do caderno, com hora de início registrada ao focar a linha e com a linha sendo salva ao pressionar Enter. O texto pode conter tags (`#tag`) e valores monetários (`[valor]`), usados para relatórios futuros de tempo e finanças.

Suporta múltiplos usuários. Cada usuário só enxerga as próprias entradas/tags. O cadastro é feito na página `/register` mediante um **código de convite** compartilhado (env `NOTEBOOK_INVITE_CODE`) — não há registro totalmente aberto.

## Status atual do projeto

Status verificado localmente em 2026-09-01:

- App rodando localmente em `http://localhost:8000`
- Multiusuário: cadastro em `/register` com código de convite, login em `/login` (usuário + senha), logout em `/logout`
- Banco SQLite em uso com schema multiusuário (`users`, `sessions`, `entries.user_id`)
- Frontend protegido por sessão; APIs respondem `401` sem sessão e o restante redireciona para `/login`
- Fluxo principal de anotação funcional via linhas do caderno e painel lateral de entradas recentes

## Stack

- **Linguagem**: Go
- **Banco de dados**: SQLite via `modernc.org/sqlite`
- **Frontend**: servidor Go servindo HTML/JS embutido, sem framework externo
- **Autenticação**: bcrypt + cookie assinado (`HttpOnly`, `Secure` false em localhost, `SameSite=Lax`)
- **Hospedagem**: OVHcloud / VPS (planejada)
- **Deploy**: GitHub Actions (planejado)
- **TLS**: Caddy (planejado)

## Estrutura atual

```text
cmd/server/main.go      — ponto de entrada HTTP
internal/auth/          — autenticação e middleware
internal/db/            — conexão do SQLite e migrations
internal/entry/         — parse de entradas, tags e valores
internal/handler/       — rotas HTTP e handlers
internal/report/        — relatórios futuros
web/                    — frontend (HTML + JS)
migrations/             — SQL schema
```

## Schema do banco

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,   -- bcrypt
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL       -- RFC3339; sessão persiste a restart
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  amount REAL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  tag TEXT NOT NULL
);
```

Todas as queries de entries/tags são filtradas por `user_id` (via join no caso das tags).

Observação importante: a modelagem atual continua sendo orientada a `created_at` + `raw_text` + `amount`. O início/fim de atividade no frontend são UX de tela e ainda não estão persistidos em um campo separado no banco.

## Regras de parse

Ao salvar uma entry:

1. Tags são extraídas com o padrão `#(\w+)`.
2. Valores monetários são extraídos com `\[(\d+(?:[.,]\d{1,2})?)\]`.
3. O `raw_text` é preservado exatamente como digitado.
4. O valor é salvo em `amount` quando encontrado.

## Comportamento atual do frontend

A interface foi migrada para um layout de caderno com:

- 70% para a folha principal
- 30% para o painel lateral de entradas recentes
- rolagem interna na folha
- linhas clicáveis/editáveis
- hora de início registrada ao focar a linha
- Enter salva a linha e avança para a próxima
- clique no horário da linha ou no item da lista pode marcar o fim de atividade visualmente
- lista lateral com entradas recentes e tags

O comportamento atual do “fim da atividade” é de UX: ele atualiza status visual da tela e não é persistido em schema ainda. O campo de entrada real continua sendo `raw_text` na base.

## Observações importantes para handover

- A arquitetura backend está sólida e pronta para continuidade.
- O principal trabalho pendente é a evolução da modelagem do tempo de atividade, para persistir início/fim separadamente e não depender somente de um timestamp de criação da linha.
- A estética de caderno pixelizado está implementada e pronta para refinamento visual, mas já está funcional.
- Caso o objetivo seja a contagem de tempo real por atividade, a próxima etapa mais natural é:
  1. adicionar campos de `started_at` e `ended_at` na tabela de entradas ou em uma tabela de `activities`
  2. manter `created_at` como timestamp de registro do item
  3. usar `raw_text` como texto livre e `amount` como valor opcional

## Autenticação

- Multiusuário: tabela `users` (username único + hash bcrypt)
- Registro em `/register` exige o código de convite (`NOTEBOOK_INVITE_CODE` / flag `-invite`); após registrar, faz auto-login
- Login em `/login` (usuário + senha); `/logout` apaga a sessão do banco
- Sessões na tabela `sessions` (token aleatório de 32 bytes, expiração ~30 dias), sobrevivem a restart
- Middleware injeta `user_id` no contexto; APIs sem sessão recebem `401`, demais rotas redirecionam para `/login`
- Rotas públicas: `/login`, `/register`, `/logout`, `/health`, `/static/`

## Ambiente de desenvolvimento

- MacBook M2 / macOS
- Go instalado via Homebrew
- local testing via `./bin/server` com SQLite local

## Próximo passo recomendado

Implementar a separação explícita entre:

- início da atividade
- fim da atividade
- texto da mensagem
- valor monetário

Isso permitirá relatórios mais confiáveis de tempo e finanças, sem depender de lógica visual na tela.
