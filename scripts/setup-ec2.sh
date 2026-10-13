#!/usr/bin/env bash
# Instala Docker, Docker Compose e Git numa EC2 com Amazon Linux 2023.
# Uso: ./scripts/setup-ec2.sh   (rode como ec2-user; depois saia e entre de novo)
set -euo pipefail

sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$(whoami)"

COMPOSE_VERSION=v2.29.7
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

echo
echo ">> Docker instalado. Rode 'exit' e depois 'sudo su - ec2-user' de novo para usar 'docker' sem sudo."
