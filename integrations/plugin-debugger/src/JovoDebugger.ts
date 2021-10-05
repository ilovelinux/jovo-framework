import {
  AnyObject,
  App,
  DeepPartial,
  Extensible,
  ExtensibleInitConfig,
  HandleRequest,
  InvalidParentError,
  Jovo,
  JovoRequest,
  Platform,
  Plugin,
  PluginConfig,
  UnknownObject,
} from '@jovotech/framework';
import { NlpjsNlu, NlpjsNluInitConfig } from '@jovotech/nlu-nlpjs';
import { CorePlatform, CorePlatformConfig } from '@jovotech/platform-core';
import { LangEn } from '@nlpjs/lang-en';
import isEqual from 'fast-deep-equal/es6';
import { promises } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { cwd } from 'process';
import { connect, Socket } from 'socket.io-client';
import { Writable } from 'stream';
import { v4 as uuidV4 } from 'uuid';
import { DebuggerConfig } from './DebuggerConfig';
import { LanguageModelDirectoryNotFoundError } from './errors/LanguageModelDirectoryNotFoundError';
import { SocketConnectionFailedError } from './errors/SocketConnectionFailedError';
import { SocketNotConnectedError } from './errors/SocketNotConnectedError';
import { WebhookIdNotFoundError } from './errors/WebhookIdNotFoundError';
import { MockServer } from './MockServer';

export enum JovoDebuggerEvent {
  DebuggingAvailable = 'debugging.available',
  DebuggingUnavailable = 'debugging.unavailable',

  DebuggerRequest = 'debugger.request',

  AppLanguageModelResponse = 'app.language-model-response',
  AppDebuggerConfigResponse = 'app.debugger-config-response',
  AppConsoleLog = 'app.console-log',
  AppRequest = 'app.request',
  AppResponse = 'app.response',

  AppJovoUpdate = 'app.jovo-update',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface JovoDebuggerPayload<DATA extends any = any> {
  requestId: number | string;
  data: DATA;
}

export interface JovoUpdateData<KEY extends keyof Jovo | string = keyof Jovo | string> {
  key: KEY;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  value: KEY extends keyof Jovo ? Jovo[KEY] : any;
  path: KEY extends keyof Jovo ? KEY : string;
}

export interface JovoDebuggerConfig extends PluginConfig {
  corePlatform: ExtensibleInitConfig<CorePlatformConfig>;
  nlpjsNlu: NlpjsNluInitConfig;
  webhookUrl: string;
  languageModelEnabled: boolean;
  languageModelPath: string;
  debuggerConfigPath: string;
  ignoredProperties: Array<keyof Jovo | string>;
}

export type JovoDebuggerInitConfig = DeepPartial<JovoDebuggerConfig> &
  Partial<Pick<JovoDebuggerConfig, 'nlpjsNlu'>>;

export class JovoDebugger extends Plugin<JovoDebuggerConfig> {
  socket?: typeof Socket;
  hasOverriddenWrite = false;

  constructor(config?: JovoDebuggerInitConfig) {
    super(config);
  }

  getDefaultConfig(): JovoDebuggerConfig {
    return {
      skipTests: true,
      corePlatform: {},
      nlpjsNlu: {
        languageMap: {
          en: LangEn,
        },
      },
      webhookUrl: 'https://webhookv4.jovo.cloud',
      enabled:
        (process.argv.includes('--jovo-webhook') || process.argv.includes('--webhook')) &&
        !process.argv.includes('--disable-jovo-debugger'),
      languageModelEnabled: true,
      languageModelPath: './models',
      debuggerConfigPath: './jovo.debugger.js',
      ignoredProperties: ['$app', '$handleRequest', '$platform'],
    };
  }

  install(parent: Extensible): void {
    if (!(parent instanceof App)) {
      throw new InvalidParentError(this.constructor.name, App);
    }
    this.installDebuggerPlatform(parent);
  }

  private installDebuggerPlatform(app: App) {
    app.use(
      new CorePlatform({
        ...this.config.corePlatform,
        platform: 'jovo-debugger',
        plugins: [new NlpjsNlu(this.config.nlpjsNlu)],
      }),
    );
  }

  async initialize(app: App): Promise<void> {
    if (this.config.enabled === false) return;

    this.socket = await this.connectToWebhook();
    this.socket.on(JovoDebuggerEvent.DebuggingAvailable, () => {
      return this.onDebuggingAvailable();
    });
    this.socket.on(JovoDebuggerEvent.DebuggerRequest, (request: AnyObject) => {
      return this.onDebuggerRequest(app, request);
    });

    this.patchHandleRequestToIncludeUniqueId();
    this.patchPlatformsToCreateJovoAsProxy(app.platforms);
  }

  mount(parent: HandleRequest): Promise<void> | void {
    this.socket = parent.app.plugins.JovoDebugger?.socket;
    parent.middlewareCollection.use('request.start', (jovo) => {
      return this.onRequest(jovo);
    });
    parent.middlewareCollection.use('response.end', (jovo) => {
      return this.onResponse(jovo);
    });
  }

  emitUpdate(requestId: string | number, data: JovoUpdateData): void {
    const payload: JovoDebuggerPayload<JovoUpdateData> = {
      requestId,
      data,
    };
    this.socket?.emit(JovoDebuggerEvent.AppJovoUpdate, payload);
  }

  private patchHandleRequestToIncludeUniqueId() {
    // this cannot be done in a middleware-hook because the debuggerRequestId is required when initializing the jovo instance
    // and that happens before the middlewares are executed
    const mount = HandleRequest.prototype.mount;
    HandleRequest.prototype.mount = function () {
      this.debuggerRequestId = uuidV4();
      return mount.call(this);
    };
  }

  private patchPlatformsToCreateJovoAsProxy(platforms: ReadonlyArray<Platform>) {
    platforms.forEach((platform) => {
      const createJovoFn = platform.createJovoInstance;
      // overwrite createJovoInstance to create a proxy and propagate all initial changes
      platform.createJovoInstance = (app, handleRequest) => {
        const jovo = createJovoFn.call(platform, app, handleRequest);
        // propagate initial values, might not be required, TBD
        for (const key in jovo) {
          const value = jovo[key as keyof Jovo];
          const isEmptyObject =
            typeof value === 'object' && !Array.isArray(value) && !Object.keys(value || {}).length;
          const isEmptyArray = Array.isArray(value) && !((value as unknown[]) || []).length;

          if (
            !jovo.hasOwnProperty(key) ||
            this.config.ignoredProperties.includes(key) ||
            !value ||
            isEmptyObject ||
            isEmptyArray
          ) {
            continue;
          }
          this.emitUpdate(handleRequest.debuggerRequestId, {
            key,
            value,
            path: key,
          });
        }
        return new Proxy(jovo, this.createProxyHandler(handleRequest));
      };
    });
  }

  private createProxyHandler<T extends AnyObject>(
    handleRequest: HandleRequest,
    path = '',
  ): ProxyHandler<T> {
    return {
      get: (target, key: string) => {
        // make __isProxy return true for all proxies with this handler
        if (key === '__isProxy') {
          return true;
        }
        // provide a reference to the original target of the proxy
        if (key === '__target') {
          return target;
        }
        // if the value is an object that is not null, not a Date nor a Jovo instance nor included in the ignored properties and no proxy
        if (
          typeof target[key] === 'object' &&
          target[key] !== null &&
          !(target[key] instanceof Date) &&
          !(target[key] instanceof Jovo) &&
          !this.config.ignoredProperties.includes(key) &&
          !target[key].__isProxy
        ) {
          // create the proxy for the value
          const proxy = new Proxy(
            target[key],
            this.createProxyHandler(handleRequest, path ? [path, key].join('.') : key),
          );

          // check if the property is writable, if it's not, return the proxy
          const propertyDescriptor = Object.getOwnPropertyDescriptor(target, key);
          if (!propertyDescriptor?.writable) {
            return proxy;
          }

          // otherwise overwrite the property and set it to the proxy
          (target as UnknownObject)[key] = proxy;
        }
        return target[key];
      },
      set: (target, key: string, value: unknown): boolean => {
        const previousValue = (target as UnknownObject)[key];
        (target as UnknownObject)[key] = value;
        // only emit changes
        if (!isEqual(previousValue, value)) {
          this.emitUpdate(handleRequest.debuggerRequestId, {
            key,
            value,
            path: path ? [path, key].join('.') : key,
          });
        }

        return true;
      },
    };
  }

  private async onDebuggingAvailable(): Promise<void> {
    if (!this.socket) {
      throw new SocketNotConnectedError(this.config.webhookUrl);
    }

    await this.emitDebuggerConfig();
    await this.emitLanguageModelIfEnabled();

    function propagateStreamAsLog(stream: Writable, socket: typeof Socket) {
      const originalWriteFn = stream.write;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream.write = function (chunk: Buffer, ...args: any[]) {
        socket.emit(JovoDebuggerEvent.AppConsoleLog, chunk.toString(), new Error().stack);
        return originalWriteFn.call(this, chunk, ...args);
      };
    }

    if (!this.hasOverriddenWrite) {
      propagateStreamAsLog(process.stdout, this.socket);
      propagateStreamAsLog(process.stderr, this.socket);
      this.hasOverriddenWrite = true;
    }
  }

  private async onDebuggerRequest(app: App, request: AnyObject): Promise<void> {
    await app.handle(new MockServer(request));
  }

  private onRequest(jovo: Jovo): void {
    if (!this.socket) {
      throw new SocketNotConnectedError(this.config.webhookUrl);
    }
    const payload: JovoDebuggerPayload<JovoRequest> = {
      requestId: jovo.$handleRequest.debuggerRequestId,
      data: jovo.$request,
    };
    this.socket.emit(JovoDebuggerEvent.AppRequest, payload);
  }

  private onResponse(jovo: Jovo): void {
    if (!this.socket) {
      throw new SocketNotConnectedError(this.config.webhookUrl);
    }
    const payload: JovoDebuggerPayload = {
      requestId: jovo.$handleRequest.debuggerRequestId,
      data: jovo.$response,
    };
    this.socket.emit(JovoDebuggerEvent.AppResponse, payload);
  }

  private async emitLanguageModelIfEnabled(): Promise<void> {
    if (!this.config.languageModelEnabled || !this.config.languageModelPath) {
      return;
    }
    if (!this.socket) {
      throw new SocketNotConnectedError(this.config.webhookUrl);
    }
    try {
      const languageModel = await this.loadLanguageModel();
      this.socket.emit(JovoDebuggerEvent.AppLanguageModelResponse, languageModel);
    } catch (e) {
      return;
    }
  }

  // Return the language models found at the configured location
  private async loadLanguageModel(): Promise<AnyObject> {
    const languageModel: AnyObject = {};
    const absoluteModelsPath = resolve(cwd(), this.config.languageModelPath);
    let files: string[] = [];
    try {
      files = await promises.readdir(absoluteModelsPath);
    } catch (e) {
      throw new LanguageModelDirectoryNotFoundError(absoluteModelsPath);
    }
    const isValidFileRegex = /^.*([.]js(?:on)?)$/;
    for (let i = 0, len = files.length; i < len; i++) {
      const match = isValidFileRegex.exec(files[i]);
      if (!match) {
        continue;
      }
      const locale = files[i].substring(0, files[i].indexOf(match[1]));
      const absoluteFilePath = join(absoluteModelsPath, files[i]);
      if (match[1] === '.json') {
        try {
          const fileBuffer = await promises.readFile(absoluteFilePath);
          languageModel[locale] = JSON.parse(fileBuffer.toString());
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e);
        }
      } else {
        languageModel[locale] = require(absoluteModelsPath);
      }
    }
    return languageModel;
  }

  private async emitDebuggerConfig(): Promise<void> {
    if (!this.config.debuggerConfigPath) {
      return;
    }
    if (!this.socket) {
      throw new SocketNotConnectedError(this.config.webhookUrl);
    }
    try {
      const debuggerConfig = await this.loadDebuggerConfig();
      this.socket.emit(JovoDebuggerEvent.AppDebuggerConfigResponse, debuggerConfig);
    } catch (e) {
      return;
    }
  }

  // Return the debugger config at the configured location or return a default config.
  private async loadDebuggerConfig(): Promise<DebuggerConfig> {
    try {
      const absoluteDebuggerConfigPath = resolve(cwd(), this.config.debuggerConfigPath);
      return require(absoluteDebuggerConfigPath);
    } catch (e) {
      console.warn('Error occurred while loading debugger-config, using default config.');
      console.warn(e.message);
      return new DebuggerConfig();
    }
  }

  private async connectToWebhook(): Promise<typeof Socket> {
    const webhookId = await this.retrieveLocalWebhookId();
    const socket = connect(this.config.webhookUrl, {
      query: {
        id: webhookId,
        type: 'app',
      },
    });
    socket.on('connect_error', (error: Error) => {
      throw new SocketConnectionFailedError(this.config.webhookUrl, error);
    });
    return socket;
  }

  private async retrieveLocalWebhookId(): Promise<string> {
    const homeConfigPath = resolve(homedir(), '.jovo/configv4');
    try {
      const homeConfigBuffer = await promises.readFile(homeConfigPath);
      const homeConfigData = JSON.parse(homeConfigBuffer.toString());
      if (homeConfigData?.webhook?.uuid) {
        return homeConfigData.webhook.uuid;
      }
      throw new Error();
    } catch (e) {
      throw new WebhookIdNotFoundError(homeConfigPath);
    }
  }
}
