#!/usr/bin/env bash
# Agenda a renovação automática do certificado: um timer do systemd roda o
# issue-cert.sh todo dia às 03:00 (horário de Brasília). Rode uma vez por máquina,
# depois de emitir o certificado.
#
# Uso: ./scripts/install-cert-renewal.sh <dominio> <email>
# Ex.: ./scripts/install-cert-renewal.sh mq-stg.invenzi.com voce@email.com
#
# Conferir:  systemctl list-timers rabbitmq-cert-renew.timer
# Logs:      journalctl -u rabbitmq-cert-renew.service
# Rodar já:  sudo systemctl start rabbitmq-cert-renew.service
set -euo pipefail

DOMAIN="${1:?informe o dominio}"
EMAIL="${2:?informe o email}"
ISSUE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/issue-cert.sh"

sudo tee /etc/systemd/system/rabbitmq-cert-renew.service >/dev/null <<EOF
[Unit]
Description=Renova o certificado TLS do RabbitMQ ($DOMAIN)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ISSUE_SCRIPT $DOMAIN $EMAIL
EOF

# Persistent: se a máquina estava desligada às 03:00, roda quando ligar.
# RandomizedDelaySec: o Let's Encrypt pede para não renovar todo mundo no mesmo minuto.
sudo tee /etc/systemd/system/rabbitmq-cert-renew.timer >/dev/null <<EOF
[Unit]
Description=Renovação diária do certificado TLS do RabbitMQ

[Timer]
OnCalendar=*-*-* 03:00:00 America/Sao_Paulo
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now rabbitmq-cert-renew.timer

echo ">> Renovação agendada para $DOMAIN"
systemctl list-timers rabbitmq-cert-renew.timer --no-pager
