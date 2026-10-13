#!/usr/bin/env bash
# Emite (ou renova) um certificado Let's Encrypt e copia para ./certs.
# Precisa da porta 80 liberada no Security Group durante a execução.
#
# Uso: ./scripts/issue-cert.sh <dominio> <email>
# Ex.: ./scripts/issue-cert.sh 3-91-10-20.sslip.io voce@email.com
set -euo pipefail

DOMAIN="${1:?informe o dominio}"
EMAIL="${2:?informe o email}"
RABBIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  echo ">> Certificado já existe, tentando renovar"
  sudo docker run --rm -p 80:80 -v /etc/letsencrypt:/etc/letsencrypt \
    certbot/certbot renew --standalone
else
  echo ">> Emitindo certificado para $DOMAIN"
  sudo docker run --rm -p 80:80 -v /etc/letsencrypt:/etc/letsencrypt \
    certbot/certbot certonly --standalone -n --agree-tos \
    -m "$EMAIL" -d "$DOMAIN"
fi

# Os arquivos do Let's Encrypt só podem ser lidos pelo root; o RabbitMQ
# roda como o usuário 999 dentro do container, então copiamos com o dono certo.
mkdir -p "$RABBIT_DIR/certs"
sudo cp -L "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$RABBIT_DIR/certs/"
sudo cp -L "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$RABBIT_DIR/certs/"
sudo chown 999:999 "$RABBIT_DIR"/certs/*.pem
sudo chmod 600 "$RABBIT_DIR/certs/privkey.pem"

if sudo docker ps --format '{{.Names}}' | grep -q '^rabbitmq$'; then
  echo ">> Reiniciando o RabbitMQ para carregar o certificado"
  sudo docker restart rabbitmq
fi

echo ">> Pronto. Certificado em $RABBIT_DIR/certs"
