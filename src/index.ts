import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { Server } from 'socket.io';
import { isLoopbackHost, loadConfig, usesDefaultSecrets } from './config';
import { createLogger, LogLevel } from './logger';
import { RoomRegistry } from './rooms/room.registry';
import { AccountStore } from './services/account.store';
import { AuthService } from './services/auth.service';
import { SessionStore } from './services/session.store';
import { createApiRouter, mountFrontend } from './http';
import { createClientIp } from './http/client-ip';
import { registerSockets } from './sockets';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.saveLog);

  if (!config.multiRoom && usesDefaultSecrets(config) && !isLoopbackHost(config.host)) {
    log(
      `Refusing to bind ${config.host} with shipped default secrets. ` +
        'Set custom adminSecret, mcSecret, and playerSecrets before enabling network access.',
      LogLevel.Error,
    );
    process.exit(1);
  }

  const MS_PER_SECOND = 1000;
  const sessions = new SessionStore(
    config.sessionsPath,
    config.sessionIdleTtlSeconds * MS_PER_SECOND,
    config.sessionMaxTtlSeconds * MS_PER_SECOND,
    log,
  );
  const auth = new AuthService(config, sessions);
  const accounts = new AccountStore(config.accountsPath, log);

  if (config.multiRoom) {
    log('Hosted mode: rooms + host accounts on, default room off.');
    if (config.serverAdmins.length > 0) {
      log(
        'serverAdmins (username allowlist) is deprecated and ignored; configure serverAdminIds or bootstrapAdmin.',
        LogLevel.Warn,
      );
    }
    if (config.bootstrapAdmin) {
      const operator = await accounts.ensureOperator(
        config.bootstrapAdmin.username,
        config.bootstrapAdmin.password,
      );
      if (!config.serverAdminIds.includes(operator.id)) {
        config.serverAdminIds.push(operator.id);
      }
      log(`Provisioned server operator "${operator.username}" (${operator.id}).`);
    }
    if (config.serverAdminIds.length === 0) {
      log('No serverAdminIds configured: server-wide branding cannot be changed.', LogLevel.Warn);
    }
  } else if (usesDefaultSecrets(config)) {
    log(
      `Default secrets in use (admin "BTC"…); bound to loopback (${config.host}). ` +
        'Set custom adminSecret, mcSecret, and playerSecrets before binding a network interface.',
      LogLevel.Warn,
    );
  }

  const app = express();
  app.set('trust proxy', config.trustProxy);
  log(`Trust proxy: ${config.trustProxy}`, config.trustProxy === false ? LogLevel.Info : LogLevel.Warn);
  const clientIp = createClientIp(config.trustProxy);
  app.use(cors({ origin: '*' }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  const rooms = new RoomRegistry(io, config, sessions, log);

  app.use(createApiRouter({ io, rooms, auth, accounts, log, config }));
  mountFrontend(app, config.frontendDir, config.assetsDir, config.assetsOverrideDir);

  registerSockets({
    io,
    rooms,
    auth,
    log,
    multiRoom: config.multiRoom,
    clientIp,
    maxSocketsPerIp: config.maxSocketsPerIp,
    maxSpectatorsPerRoom: config.maxSpectatorsPerRoom,
  });

  const HTTP_DEFAULT_PORT = 80;
  /** Printed addresses must include the port, or browsers try :80. */
  const portSuffix = config.port === HTTP_DEFAULT_PORT ? '' : `:${config.port}`;

  httpServer.listen(config.port, config.host, () => {
    log(`Server Legendary khởi động thành công tại http://${config.host}${portSuffix}, đang chờ kết nối mới…`);
    if (!isLoopbackHost(config.host)) {
      for (const interfaces of Object.values(networkInterfaces())) {
        for (const net of interfaces ?? []) {
          if (net.family === 'IPv4' && !net.internal) {
            log(`Địa chỉ IP của máy chủ: http://${net.address}${portSuffix}`, LogLevel.Warn);
          }
        }
      }
    }
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
