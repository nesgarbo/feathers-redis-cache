import { Redis, RedisOptions } from 'ioredis';
import { logger } from './logger.js';

const { DISABLE_REDIS_CACHE } = process.env;
const defaultPrefix = 'frc_';

type AppLike = {
  get: (k: string) => any;
  set: (k: string, v: any) => void;
};

type Options = {
  errorLogger?: (...args: any[]) => void;
  retryInterval?: number; // ms (fallback mínimo)
  lazyConnect?: boolean;  // no conectar hasta el primer comando
  maxRetryDelay?: number; // ms (tope del backoff)
  baseRetryDelay?: number;// ms (base del backoff)
};

export default (options: Options = {}) => {
  const errorLogger = options.errorLogger || logger.error.bind(logger);
  const fallbackMin = options.retryInterval ?? 5_000;
  const baseDelay   = options.baseRetryDelay ?? 500;
  const maxDelay    = options.maxRetryDelay ?? 30_000;

  if (DISABLE_REDIS_CACHE === 'true') {
    return () => {};
  }

  return function client(this: AppLike) {
    const app = this as AppLike;

    // No recrear cliente si ya existe y no está cerrado
    const existing: Redis | undefined = app.get('redisClient');
    if (existing && !['end', 'close'].includes((existing as any).status)) {
      return this;
    }

    const rawConfig = app.get('redis') || {};

    try {
      // ---- Compat con config antigua de node-redis ----
      const {
        prefix,               // antiguo => ioredis: keyPrefix
        retry_strategy,       // antiguo => ioredis: retryStrategy
        url,                  // moderno
        ...rest
      } = rawConfig;

      const keyPrefix: string =
        (typeof rawConfig.keyPrefix === 'string' && rawConfig.keyPrefix.length > 0)
          ? rawConfig.keyPrefix
          : (typeof prefix === 'string' && prefix.length > 0 ? prefix : defaultPrefix);

      // retryStrategy con backoff exponencial + jitter; si no hay nada definido, aplicamos este.
      const compatRetryStrategy =
        typeof rawConfig.retryStrategy === 'function'
          ? rawConfig.retryStrategy
          : (typeof retry_strategy === 'function'
              ? retry_strategy
              : (attempts: number) => {
                  // backoff exponencial con jitter, acotado
                  const exp = Math.min(maxDelay, Math.round(baseDelay * Math.pow(2, attempts)));
                  const jitter = Math.floor(Math.random() * (exp * 0.25));
                  const delay = Math.max(fallbackMin, exp + jitter);
                  logger.warn(`[redis] reconnecting in ${delay}ms (attempt ${attempts})`);
                  return delay;
                });

      // ---- Opciones finales ioredis ----
      const redisOptions: RedisOptions = {
        keyPrefix,
        lazyConnect: options.lazyConnect ?? false,
        // Suele ser buena idea permitir cola offline para cache no crítica
        enableOfflineQueue: true,
        // Para evitar timeouts internos agresivos en escenarios intermitentes:
        maxRetriesPerRequest: null,
        // Copiamos el resto (host, port, password, db, tls, sentinel*, etc.)
        ...rest,
        retryStrategy: compatRetryStrategy
      };

      // Crear cliente una sola vez
      const client: Redis =
        typeof url === 'string' && url.length > 0
          ? new Redis(url as string, redisOptions)
          : new Redis(redisOptions);

      // Guardar inmediatamente para que otros inicializadores no creen más instancias
      app.set('redisClient', client);

      client.on('ready', () => {
        logger.info('[redis] connected');
      });

      client.on('reconnecting', () => {
        logger.warn('[redis] reconnecting...');
      });

      client.on('end', () => {
        logger.warn('[redis] connection ended');
      });

      client.on('error', (err) => {
        errorLogger(err);
        // No eliminamos la referencia; ioredis se recupera solo.
        // Si prefieres fail-fast, puedes: app.set('redisClient', undefined);
      });

      // Con lazyConnect, lanza la conexión cuando realmente lo necesites:
      if (redisOptions.lazyConnect === true) {
        // Puedes omitir esto y dejar que el primer comando conecte; si quieres “calentar”:
        client.connect().catch((err) => {
          errorLogger(err);
        });
      }
    } catch (err) {
      errorLogger(err);
      app.set('redisClient', undefined);
    }

    return this;
  };
}
