// services/cache-maintenance.ts
import type { Application, ServiceMethods, Params, Query } from '@feathersjs/feathers';
import { purgeGroup, hashCode } from './hooks.js';

const { DISABLE_REDIS_CACHE } = process.env;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_REQUEST = 400;
const DEFAULT_PREFIX = 'frc_';

type Json = Record<string, any>;

function getKeyPrefix(app: Application): string {
  const cfg: any = app.get('redis') || {};
  const p = cfg.keyPrefix ?? cfg.prefix ?? DEFAULT_PREFIX;
  return typeof p === 'string' ? p : DEFAULT_PREFIX;
}

function stripPrefix(key: string, prefix: string): string {
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function ensureClient(app: Application) {
  const client = app.get('redisClient');
  if (!client) {
    return { error: { message: 'Redis unavailable', status: HTTP_SERVER_ERROR } as Json };
  }
  return { client };
}

function ok(message: string, status = HTTP_OK) {
  return { message, status };
}
function fail(message: string, status = HTTP_SERVER_ERROR) {
  return { message, status };
}

/* ---------------- Single key clear ---------------- */

class ServiceClearSingle implements Partial<ServiceMethods<any, any, Params<Query>, any>> {
  app!: Application;

  async setup(app: Application) { this.app = app; }

  async find(params?: Params<Query>) {
    const { client, error } = ensureClient(this.app);
    if (error) return error;

    const keyPrefix = getKeyPrefix(this.app);
    const target = String(params?.query?.target ?? '');

    if (!target) return fail('You must provide key', HTTP_BAD_REQUEST);

    // Soportar target con o sin keyPrefix
    const logicalKey = stripPrefix(target, keyPrefix);

    try {
      const exists = await client.get(logicalKey);
      if (!exists) return ok(`cache already cleared for key ${target}`, HTTP_NO_CONTENT);

      const del = typeof client.unlink === 'function' ? client.unlink.bind(client) : client.del.bind(client);
      const deleted = await del(logicalKey);
      if (!deleted) return ok(`cache already cleared for key ${target}`, HTTP_NO_CONTENT);

      return ok(`cache cleared for key ${target}`);
    } catch (err: any) {
      return fail('something went wrong: ' + (err?.message ?? String(err)));
    }
  }
}

/* ---------------- Group clear (by service token) ---------------- */

class ServiceClearGroup implements Partial<ServiceMethods<any, any, Params<Query>, any>> {
  app!: Application;

  async setup(app: Application) { this.app = app; }

  async find(params?: Params<Query>) {
    const { client, error } = ensureClient(this.app);
    if (error) return error;

    const keyPrefix = getKeyPrefix(this.app);
    const target = String(params?.query?.target ?? '').trim();

    if (!target) return fail('Target is required', HTTP_BAD_REQUEST);

    // Permitimos tanto nombre lógico (ej: "users") como hash ya calculado
    const group = /^[\-]?\d+$/.test(target) ? target : hashCode(`group-${target}`);

    try {
      await purgeGroup(client, group, keyPrefix);
      return ok(`cache cleared for group ${target}`);
    } catch (err: any) {
      return fail(err?.message ?? 'Unknown error');
    }
  }
}

/* ---------------- Clear all (by prefix) ---------------- */

class ServiceClearAll implements Partial<ServiceMethods<any, any, Params<Query>, any>> {
  app!: Application;

  async setup(app: Application) { this.app = app; }

  async find() {
    const { client, error } = ensureClient(this.app);
    if (error) return error;

    const keyPrefix = getKeyPrefix(this.app);

    try {
      // group vacío → hace SCAN por `${prefix}*`
      await purgeGroup(client, '', keyPrefix);
      return ok('cache cleared');
    } catch (err: any) {
      return fail(err?.message ?? 'Unknown error');
    }
  }
}

/* ---------------- FLUSHDB (db actual) ---------------- */

class ServiceFlushDb implements Partial<ServiceMethods<any, any, Params<Query>, any>> {
  app!: Application;

  async setup(app: Application) { this.app = app; }

  async find() {
    const { client, error } = ensureClient(this.app);
    if (error) return error;

    try {
      await client.flushdb();
      return ok('Cache cleared');
    } catch (err: any) {
      return fail(err?.message ?? 'Unknown error');
    }
  }
}

/* ---------------- Registrar servicios ---------------- */

export default function registerCacheMaintenance(options: any = {}) {
  const pathPrefix = options.pathPrefix || '/cache';

  return function register(this: Application, app?: Application) {
    const a = app ?? this;
    if (DISABLE_REDIS_CACHE === 'true') return;

    a.use(`${pathPrefix}/clear/single`, new ServiceClearSingle());
    a.use(`${pathPrefix}/clear/group`, new ServiceClearGroup());
    a.use(`${pathPrefix}/clear/all`, new ServiceClearAll());
    a.use(`${pathPrefix}/flushdb`, new ServiceFlushDb());
  };
}
