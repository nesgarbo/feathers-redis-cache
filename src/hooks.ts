import { logger } from './logger.js';

const { DISABLE_REDIS_CACHE, ENABLE_REDIS_CACHE_LOGGER } = process.env;
const HTTP_SERVER_ERROR = 500;

type PassedOptions = {
  env?: string;
  expiration?: number;
  defaultExpiration?: number;
  // Funciones opcionales para agrupar o personalizar clave
  cacheGroupKey?: (hook: any) => string | number;
  cacheKey?: (hook: any) => string;
};

const defaults = {
  defaultExpiration: 3600 * 24, // seconds
} as const;

/* -------------------- Utils -------------------- */

function stableStringify(obj: unknown): string {
  const seen = new WeakSet();

  const normalize = (value: any): any => {
    if (value === null) return null;

    const t = typeof value;
    if (t === 'bigint') return value.toString();
    if (t === 'number' || t === 'string' || t === 'boolean') return value;
    if (t === 'undefined' || t === 'function') return undefined;

    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
      let changed = false;
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const v = normalize(value[i]);
        if (v !== value[i]) changed = true;
        out[i] = v;
      }
      // Filtramos undefined para estabilidad
      return changed ? out.filter(v => v !== undefined) : out;
    }

    if (t === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const keys = Object.keys(value).sort();
      const out: Record<string, any> = {};
      for (const k of keys) {
        const v = normalize(value[k]);
        if (v !== undefined) out[k] = v;
      }
      seen.delete(value);
      return out;
    }

    return String(value);
  };

  return JSON.stringify(normalize(obj));
}

export function hashCode(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function humanizeSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  return remM ? `${hrs}h ${remM}m` : `${hrs}h`;
}

/** Construye { group, key } de forma determinista y compacta */
function makeKeys(hook: any, opts: PassedOptions) {
  const paginateTag = hook.params?.paginate === false ? 'disabled' : 'enabled';
  const basePath = `pagination-hook:${paginateTag}::${hook.path}${hook.id != null ? `/${hook.id}` : ''}`;

  const q = hook.params?.query;
  const qStr = q && Object.keys(q).length ? stableStringify(q) : '';
  const raw = qStr ? `${basePath}?${qStr}` : basePath;

  // Grupo
  const groupSeed =
    typeof opts.cacheGroupKey === 'function'
      ? `group-${opts.cacheGroupKey(hook)}`
      : `group-${hook.path || 'general'}`;
  const group = hashCode(groupSeed);

  // Clave final (compacta): group + hash del “raw”
  const key = typeof opts.cacheKey === 'function'
    ? `${group}${opts.cacheKey(hook)}`
    : `${group}${hashCode(raw)}`;

  return { group, key };
}

/* -------------------- Purge -------------------- */

/**
 * Purga todas las claves que empiecen por {keyPrefix}{group}
 * Usa SCAN + UNLINK por lotes para no bloquear.
 */
export async function purgeGroup(client: any, group: string, keyPrefix = 'frc_') {
  let cursor = '0';
  const match = `${keyPrefix}${group}*`;
  const batchSize = 1000;

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', batchSize);
    cursor = nextCursor;

    if (Array.isArray(keys) && keys.length) {
      const pipe = client.pipeline();
      for (const k of keys) pipe.unlink(k);
      await pipe.exec();
    }
  } while (cursor !== '0');
}

/* -------------------- Hook -------------------- */

export default {
  before(passedOptions: PassedOptions = {}) {
    if (DISABLE_REDIS_CACHE === 'true') return (hook: any) => hook;

    return async function beforeHook(hook: any) {
      // fast exits
      if (hook?.params?.$skipCacheHook) return hook;

      const client = hook.app.get('redisClient');
      if (!client) return hook;

      const options = { ...defaults, ...passedOptions };
      const { group, key } = makeKeys(hook, options);

      hook.params ||= {};
      hook.params.cacheKey = key;
      hook.params.cacheGroup = group;

      const reply = await client.get(key);
      if (!reply) return hook;

      let data: any;
      try {
        data = JSON.parse(reply);
      } catch {
        // valor corrupto → ignoramos caché
        return hook;
      }

      if (!data || !data.expiresOn || data.cache == null) return hook;

      hook.result = data.cache;
      hook.params.$skipCacheHook = true;

      if (options.env !== 'test' && ENABLE_REDIS_CACHE_LOGGER === 'true') {
        logger.info(`[redis] returning cached value for ${key}.`);
        logger.info(`> Expires on ${new Date(data.expiresOn).toISOString()}.`);
      }

      return hook;
    };
  },

  after(passedOptions: PassedOptions = {}) {
    if (DISABLE_REDIS_CACHE === 'true') return (hook: any) => hook;

    return async function afterHook(hook: any) {
      // fast exits
      if (hook?.params?.$skipCacheHook) return hook;
      if (hook?.result == null) return hook;

      const client = hook.app.get('redisClient');
      if (!client) return hook;

      const options = { ...defaults, ...passedOptions };
      const duration = options.expiration ?? options.defaultExpiration;
      const cacheKey = hook.params?.cacheKey as string | undefined;
      if (!cacheKey) return hook;

      // calculamos expiresOn una sola vez
      const expiresOn = new Date(Date.now() + duration * 1000).toISOString();

      // set con expiración
      await client.set(
        cacheKey,
        JSON.stringify({ cache: hook.result, expiresOn }),
        'EX',
        duration
      );

      if (options.env !== 'test' && ENABLE_REDIS_CACHE_LOGGER === 'true') {
        logger.info(`[redis] added ${cacheKey} to the cache.`);
        logger.info(`> Expires in ${humanizeSeconds(duration)}.`);
      }

      return hook;
    };
  },

  purge(passedOptions: PassedOptions = {}) {
    if (DISABLE_REDIS_CACHE === 'true') return (hook: any) => hook;

    return async function purgeHook(hook: any) {
      const client = hook.app.get('redisClient');
      if (!client) {
        return { message: 'Redis unavailable', status: HTTP_SERVER_ERROR };
      }

      const options = { ...defaults, ...passedOptions };
      const appRedisCfg = hook.app.get('redis') || {};
      const keyPrefix: string = appRedisCfg.keyPrefix ?? 'frc_';

      // Reusamos la misma función de grupo para asegurar coincidencia
      const { group } = makeKeys(hook, options);

      // fire-and-forget con captura de error
      purgeGroup(client, group, keyPrefix).catch((err) =>
        logger.error({ message: err?.message ?? String(err), status: HTTP_SERVER_ERROR })
      );

      return hook;
    };
  },
};
