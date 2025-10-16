import client from './client.js';
import services from './services.js';
import hooks from './hooks.js';

// 🔹 exportaciones individuales
export { client, services, hooks };

// 🔹 exportación por defecto (objeto completo)
export default {
  client,
  services,
  hooks
};
