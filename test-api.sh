#!/bin/bash
# Requer o servidor rodando com: NOTEBOOK_INVITE_CODE=demo-invite ./bin/server

BASE=${BASE:-http://localhost:8080}
INVITE=${INVITE:-demo-invite}
USER=${USER_NAME:-demo}
PASS=${PASS:-demo123456}

echo "🆕 0. Registrar usuário (ignora erro se já existir)"
curl -X POST "$BASE/register" \
  -d "username=$USER&password=$PASS&invite=$INVITE" \
  -c /tmp/session.txt \
  -s -o /dev/null -w "status: %{http_code}\n"

echo -e "\n🔐 1. Login"
curl -X POST "$BASE/login" \
  -d "username=$USER&password=$PASS" \
  -c /tmp/session.txt \
  -s -o /dev/null -w "status: %{http_code}\n"

echo -e "\n👤 1b. Quem sou eu"
curl "$BASE/api/me" -b /tmp/session.txt -s | python3 -m json.tool

echo -e "\n📝 2. Criar ENTRY #1"
curl -X POST "$BASE/api/entries" \
  -H "Content-Type: application/json" \
  -b /tmp/session.txt \
  -d '{"text":"Almoço na pizzaria #refeicao [42.50]"}' \
  -s | python3 -m json.tool

echo -e "\n📝 3. Criar ENTRY #2"
curl -X POST "$BASE/api/entries" \
  -H "Content-Type: application/json" \
  -b /tmp/session.txt \
  -d '{"text":"Revisão do notebook #manutencao [250.00]"}' \
  -s | python3 -m json.tool

echo -e "\n📊 4. Listar TODAS as entries"
curl "$BASE/api/entries" \
  -b /tmp/session.txt \
  -s | python3 -m json.tool

echo -e "\n🏷️ 5. Filtrar por TAG #refeicao"
curl "$BASE/api/entries?tag=refeicao" \
  -b /tmp/session.txt \
  -s | python3 -m json.tool

echo -e "\n✅ Testes concluídos!"
