#!/usr/bin/env bash
# Emite (ou renova) um certificado Let's Encrypt e copia para ./certs.
# Precisa da porta 80 liberada no Security Group: o Let's Encrypt valida
# o domínio por ela, na emissão e em toda renovação.
#
# Uso: ./scripts/issue-cert.sh <dominio> <email>
# Ex.: ./scripts/issue-cert.sh mq-stg.invenzi.com voce@email.com
#
# Pode rodar todo dia (é o que o timer do install-cert-renewal.sh faz): o
# certbot só renova quando faltam menos de 30 dias para vencer, e o RabbitMQ
# só recarrega o certificado quando ele realmente mudou.
#
# Para testar a renovação sem esperar: FORCE_RENEWAL=1 ./scripts/issue-cert.sh ...
# (o Let's Encrypt limita a 5 certificados iguais por semana, não abuse)
set -euo pipefail

DOMAIN="${1:?informe o dominio}"
EMAIL="${2:?informe o email}"
RABBIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"
CERTBOT=(sudo docker run --rm -p 80:80 -v /etc/letsencrypt:/etc/letsencrypt certbot/certbot)

if sudo test -d "$LIVE_DIR"; then
  echo ">> Certificado já existe, renovando se estiver perto de vencer"
  RENEW_ARGS=(renew --standalone -n --cert-name "$DOMAIN")
  if [ "${FORCE_RENEWAL:-}" = "1" ]; then
    RENEW_ARGS+=(--force-renewal)
  fi
  "${CERTBOT[@]}" "${RENEW_ARGS[@]}"
else
  echo ">> Emitindo certificado para $DOMAIN"
  "${CERTBOT[@]}" certonly --standalone -n --agree-tos -m "$EMAIL" -d "$DOMAIN"
fi

if sudo cmp -s "$LIVE_DIR/fullchain.pem" "$RABBIT_DIR/certs/fullchain.pem"; then
  echo ">> O certificado não mudou, nada a fazer"
  exit 0
fi

# Os arquivos do Let's Encrypt só podem ser lidos pelo root; o RabbitMQ
# roda como o usuário 999 dentro do container, então copiamos com o dono certo.
sudo mkdir -p "$RABBIT_DIR/certs"
sudo cp -L "$LIVE_DIR/fullchain.pem" "$RABBIT_DIR/certs/"
sudo cp -L "$LIVE_DIR/privkey.pem" "$RABBIT_DIR/certs/"
sudo chown 999:999 "$RABBIT_DIR"/certs/*.pem
sudo chmod 600 "$RABBIT_DIR/certs/privkey.pem"

if sudo docker ps --format '{{.Names}}' | grep -q '^rabbitmq$'; then
  # Limpar o cache faz as próximas conexões usarem o certificado novo,
  # sem derrubar as que já estão abertas. Se falhar, reinicia o container.
  echo ">> Recarregando o certificado no RabbitMQ"
  if ! sudo docker exec rabbitmq rabbitmqctl eval 'ssl:clear_pem_cache().' >/dev/null; then
    echo ">> Não deu para recarregar, reiniciando o RabbitMQ"
    sudo docker restart rabbitmq
  fi
fi

echo ">> Pronto. Certificado em $RABBIT_DIR/certs (vence em $(sudo openssl x509 -enddate -noout -in "$RABBIT_DIR/certs/fullchain.pem" | cut -d= -f2))"
