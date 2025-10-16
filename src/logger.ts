import pino from 'pino'

// Configuración de `pino` para FeathersJS
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty', // Para logs formateados en desarrollo
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname' // Oculta pid y hostname en los logs
      }
    }
  }
)
