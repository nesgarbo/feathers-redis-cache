import { Redis } from 'ioredis';
import { logger } from './logger.js';
const { DISABLE_REDIS_CACHE } = process.env;
const defaultPrefix = 'frc_';
export default (options = {}) => {
    const errorLogger = options.errorLogger || logger.error.bind(logger);
    const fallbackMin = options.retryInterval ?? 5000;
    const baseDelay = options.baseRetryDelay ?? 500;
    const maxDelay = options.maxRetryDelay ?? 30000;
    if (DISABLE_REDIS_CACHE === 'true') {
        return () => { };
    }
    return function client() {
        const app = this;
        const existing = app.get('redisClient');
        if (existing && !['end', 'close'].includes(existing.status)) {
            return this;
        }
        const rawConfig = app.get('redis') || {};
        try {
            const { prefix, retry_strategy, url, ...rest } = rawConfig;
            const keyPrefix = (typeof rawConfig.keyPrefix === 'string' && rawConfig.keyPrefix.length > 0)
                ? rawConfig.keyPrefix
                : (typeof prefix === 'string' && prefix.length > 0 ? prefix : defaultPrefix);
            const compatRetryStrategy = typeof rawConfig.retryStrategy === 'function'
                ? rawConfig.retryStrategy
                : (typeof retry_strategy === 'function'
                    ? retry_strategy
                    : (attempts) => {
                        const exp = Math.min(maxDelay, Math.round(baseDelay * Math.pow(2, attempts)));
                        const jitter = Math.floor(Math.random() * (exp * 0.25));
                        const delay = Math.max(fallbackMin, exp + jitter);
                        logger.warn(`[redis] reconnecting in ${delay}ms (attempt ${attempts})`);
                        return delay;
                    });
            const redisOptions = {
                keyPrefix,
                lazyConnect: options.lazyConnect ?? false,
                enableOfflineQueue: true,
                maxRetriesPerRequest: null,
                ...rest,
                retryStrategy: compatRetryStrategy
            };
            const client = typeof url === 'string' && url.length > 0
                ? new Redis(url, redisOptions)
                : new Redis(redisOptions);
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
            });
            if (redisOptions.lazyConnect === true) {
                client.connect().catch((err) => {
                    errorLogger(err);
                });
            }
        }
        catch (err) {
            errorLogger(err);
            app.set('redisClient', undefined);
        }
        return this;
    };
};
//# sourceMappingURL=client.js.map