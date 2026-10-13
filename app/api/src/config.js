function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida (veja .env.example)`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  exchange: process.env.RABBITMQ_EXCHANGE ?? 'lab.events',

  // API -> Rabbit pela rede privada da VPC (IP privado da EC2 do Rabbit)
  rabbitmqUrl: required('RABBITMQ_URL'),

  // Endereço que o cliente usa para consumir (IP público ou domínio)
  publicUrl: required('RABBITMQ_PUBLIC_URL'),

  management: {
    url: required('RABBITMQ_MANAGEMENT_URL').replace(/\/$/, ''),
    username: required('RABBITMQ_MANAGEMENT_USER'),
    password: required('RABBITMQ_MANAGEMENT_PASSWORD'),
    vhost: '/',
  },

  // Proteção contra fila abandonada
  companyQueues: {
    messageTtlMs: 7 * 24 * 60 * 60 * 1000,
    maxLength: 100000,
  },
};
