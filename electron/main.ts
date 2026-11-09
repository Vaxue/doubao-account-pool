import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, powerMonitor, session } from "electron";
import { DailyQuotaTimer } from "./quota-clock.js";
import { doubaoDailyQuotaError } from "./doubao-quota-state.js";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoAspectRatio,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { resolveCleanVideoUrl, WatermarkError } from "./watermark.js";
import type { WatermarkProviderObserver } from "./watermark-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let executor: DoubaoExecutor;
let apiServer: LocalApiServer;
let quotaTimer: DailyQuotaTimer | null = null;

const observeWatermarkResponse: WatermarkProviderObserver = (settings, event) => {
  db.recordWatermarkResponse(settings, event);
  notifyDataChanged();
};

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DoubaoExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      version: app.getVersion(),
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "doubao-account-pool",
          api: this.getStatus()
        });
        return;
      }

      if (!isAuthorized(request, settings.apiKey)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        refreshQuotas();
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/watermark/status") {
        sendJson(response, 200, this.database.getWatermarkStatus());
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `doubao-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const body = await readGenerateRequest(request, requestId);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const aspectRatio = normalizeAspectRatio(body.aspectRatio) || "16:9";
        const rawAspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio.trim() : body.aspectRatio;
        if (rawAspectRatio !== undefined && rawAspectRatio !== null && rawAspectRatio !== "" && !normalizeAspectRatio(body.aspectRatio)) {
          sendJson(response, 400, { error: "aspectRatio must be 9:16 or 16:9" });
          return;
        }
        const duration = body.duration === undefined || body.duration === "" ? 15 : Number(body.duration);
        if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
          sendJson(response, 400, { error: "duration must be an integer from 4 to 15" });
          return;
        }
        const resolution = body.resolution === undefined || body.resolution === "" ? "720p" : body.resolution;
        if (resolution !== "720p" && resolution !== "1080p") {
          sendJson(response, 400, { error: "resolution must be 720p or 1080p" });
          return;
        }

        const accountId = body.accountId === undefined ? undefined : Number(body.accountId);
        if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId < 1)) {
          sendJson(response, 400, { error: "accountId must be a positive integer" });
          return;
        }
        const referenceImagePaths = await prepareReferenceImages(body, requestId);
        const referenceImagePath = referenceImagePaths[0] || null;
        const referenceVideoPaths = await prepareReferenceVideos(body, requestId);
        refreshQuotas();
        const created = this.database.acceptApiRequest({ requestId, source: body.source, model, aspectRatio, duration, resolution,
          prompt, referenceImagePath, referenceImagePaths, referenceVideoPaths, removeWatermark: true, callbackUrl: body.callbackUrl }, accountId);

        if (!created) {
          const pinnedExhausted = accountId ? this.database.getAccount(accountId)?.dailyQuotaExhausted : false;
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            aspectRatio,
            duration,
            resolution,
            status: "failed",
            message: pinnedExhausted ? "豆包今日免费次数已用完；本任务指定了账号，不自动换号" : accountId ? "指定账号未登录、不存在或该模型剩余额度不足" : "没有可用账号，或该模型剩余额度不足",
            accountId: pinnedExhausted ? accountId : undefined,
            requestedAccountId: accountId,
            prompt,
            referenceImagePath,
            referenceImagePaths,
            referenceVideoPaths,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          if (pinnedExhausted) this.database.updateApiRequest({ requestId, error: doubaoDailyQuotaError(this.database.getAccount(accountId!)?.quotaExhaustedReason || failed.message) });
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: failed.message
          });
          notifyDataChanged();
          const finalFailure = this.database.getApiRequest(requestId)!;
          void postCallback(finalFailure);
          sendJson(response, 409, toPublicApiRequest(finalFailure));
          return;
        }

        this.requestExecutor.enqueue(created.requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: created.accountId,
          action: "接收接口请求",
          status: "success",
          message: created.message
        });
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
          return;
        }
        if (apiRequest.status === "running" || apiRequest.status === "accepted" && apiRequest.executionPhase !== "paused") {
          sendJson(response, 409, { error: "request is already active; stop or wait before retrying its result" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: apiRequest.accountId,
          action: "恢复视频结果",
          status: "info",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      const stopMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const requestId = decodeURIComponent(stopMatch[1]);
        const result = this.requestExecutor.stop(requestId);
        if (!result.stopped) {
          sendJson(response, 409, {
            ...toPublicApiRequest(result.request),
            error: "only accepted or running requests can be stopped"
          });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(result.request));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl, undefined, { onProviderResponse: observeWatermarkResponse, getSettings: () => this.database.getSettings() });
          recordOperation(null, null, "独立去水印解析", "success", "已验证真实 MP4 地址", sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          recordOperation(
            null,
            null,
            "独立去水印解析",
            "failed",
            error instanceof Error ? error.message : "去水印解析失败",
            sourceUrl
          );
          sendJson(response, 422, {
            status: "failed",
            error: error instanceof WatermarkError ? error.info : null,
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "豆包账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function createDoubaoWindow(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `豆包 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void win.loadURL("https://www.doubao.com/chat");
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.doubao.com" });
  const activeRequest = account.runningTaskCount + account.queuedTaskCount > 0;
  return db.updateAccount({
    id: accountId,
    loginStatus: cookies.length > 0 ? "logged_in" : "logged_out",
    currentStatus: cookies.length > 0
      ? activeRequest
        ? "busy"
        : "idle"
      : "login_required"
  });
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

function accountPartitionDir(partition: string) {
  return path.join(app.getPath("userData"), "Partitions", partition.replace(/^persist:/, ""));
}

async function closePartitionWindows(partition: string) {
  const target = session.fromPartition(partition);
  const windows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.webContents.session === target
  );
  for (const win of windows) {
    await new Promise<void>((resolve) => {
      win.once("closed", () => resolve());
      win.destroy();
    });
  }
}

/**
 * 彻底清空某个账号的浏览器数据：关闭窗口 -> 清 storage/cache/认证缓存 -> 断开连接 -> 删目录。
 * 只调用 clearStorageData 会留下 Partitions/<partition> 目录和残留文件，
 * 旧实现删号后再加号会复用同一编号，新账号直接继承这些脏数据。
 */
async function purgeAccountPartition(partition: string, reason: string) {
  await closePartitionWindows(partition);
  const accountSession = session.fromPartition(partition);
  await accountSession.clearStorageData().catch(() => undefined);
  await accountSession.clearCache().catch(() => undefined);
  await accountSession.clearAuthCache().catch(() => undefined);
  try {
    accountSession.closeAllConnections();
  } catch {
    // 旧版本 Electron 没有该 API 时忽略
  }

  const dir = accountPartitionDir(partition);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      log.info(`[account] 已清理浏览器数据目录 ${dir}（${reason}）`);
      return true;
    } catch (error) {
      if (attempt === 4) {
        log.error(`[account] 清理浏览器数据目录失败 ${dir}`, error);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

/** 启动时清理没有对应账号的遗留 partition 目录（历史版本删号只删了数据库行）。 */
async function purgeOrphanAccountPartitions() {
  const partitionsDir = path.join(app.getPath("userData"), "Partitions");
  let names: string[];
  try {
    names = await fs.readdir(partitionsDir);
  } catch {
    return;
  }
  const used = new Set(db.listAccounts().map((account) => account.partition.replace(/^persist:/, "")));
  for (const name of names) {
    if (!/^doubao_account_\d+$/.test(name) || used.has(name)) continue;
    const dir = path.join(partitionsDir, name);
    try {
      const stat = await fs.stat(dir);
      // 跳过刚创建、可能还没落库的目录
      if (Date.now() - stat.mtimeMs < 60_000) continue;
      await fs.rm(dir, { recursive: true, force: true });
      log.info(`[account] 已清理无对应账号的浏览器数据目录 ${dir}`);
    } catch (error) {
      log.warn(`[account] 清理无主浏览器数据目录失败 ${dir}`, error);
    }
  }
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  await closePartitionWindows(account.partition);
  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  await accountSession.clearAuthCache().catch(() => undefined);
  try {
    accountSession.closeAllConnections();
  } catch {
    // 旧版本 Electron 没有该 API 时忽略
  }
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => { refreshQuotas(); return db.listAccounts(); });
  ipcMain.handle("accounts:create", (_event, remark?: string) => {
    const account = db.createAccount({ remark });
    recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
    return account;
  });
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => {
    const account = db.updateAccount(input);
    recordOperation(null, account.id, "修改账号设置", "success", "已保存账号备注和额度设置");
    return account;
  });
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    const account = db.getAccount(id);
    if (!account) throw new Error("Account not found");
    if (account.runningTaskCount + account.queuedTaskCount > 0) {
      throw new Error("账号还有执行或排队任务，请先终止任务再删除");
    }
    const purged = await purgeAccountPartition(account.partition, "删除账号");
    db.deleteAccount(id);
    recordOperation(null, id, "删除账号", "success", purged
      ? `已删除 ${account.partition}，浏览器数据目录已清空`
      : `已删除 ${account.partition}，但浏览器数据目录未清理干净，请手动处理`);
    return true;
  });
  ipcMain.handle("accounts:open", (_event, id: number) => {
    const result = createDoubaoWindow(id);
    recordOperation(null, id, "打开豆包窗口", "success", "已打开独立账号窗口");
    return result;
  });
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    createDoubaoWindow(id);
    recordOperation(null, id, "重新登录账号", "success", "已清空登录状态并打开登录窗口");
    return true;
  });
  ipcMain.handle("accounts:detect-login", async (_event, id: number) => {
    const account = await detectLoginStatus(id);
    recordOperation(null, id, "检测登录状态", "success", `当前状态：${account.loginStatus}`);
    return account;
  });
  ipcMain.handle("accounts:detect-all", async () => {
    const accounts = await detectAllLoginStatuses();
    recordOperation(null, null, "检测全部账号", "success", `已检测 ${accounts.length} 个账号`);
    return accounts;
  });
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => {
    const accounts = db.resetAccountQuota(id);
    recordOperation(null, id, "重置账号额度", "success", "已重置今日额度");
    return accounts;
  });
  ipcMain.handle("accounts:reset-all-quotas", () => {
    const accounts = db.resetAllQuotas();
    recordOperation(null, null, "重置全部额度", "success", `已重置 ${accounts.length} 个账号`);
    return accounts;
  });

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const previous = db.getSettings();
    const settings = db.updateSettings(input);
    executor.wake();
    if (previous.apiPort !== settings.apiPort || previous.apiServiceEnabled !== settings.apiServiceEnabled || previous.apiKey !== settings.apiKey) {
      await apiServer.applySettings(settings);
    }
    const watermarkChanged = previous.watermarkApiUrl !== settings.watermarkApiUrl || previous.watermarkApiToken !== settings.watermarkApiToken;
    recordOperation(null, null, "保存配置", "success", watermarkChanged ? "去水印配置已保存，后续解析尝试使用新配置；已发出的请求不撤回，已失败任务可恢复结果" : "配置已保存并应用");
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => apiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("watermark:status", () => db.getWatermarkStatus());
  ipcMain.handle("api-requests:stats", (_event, startIso: string, endIso: string) => db.getRequestStats(startIso, endIso));
  ipcMain.handle("api-requests:recover", (_event, requestId: string) => {
    const request = db.getApiRequest(requestId);
    if (!request?.accountId || request.status === "running" || request.status === "accepted" && request.executionPhase !== "paused") throw new Error("任务当前无法恢复结果");
    executor.enqueueRecovery(requestId);
    return true;
  });
  ipcMain.handle("api-requests:stop", (_event, requestId: string) => executor.stop(requestId));
  ipcMain.handle("api-requests:today-success-count", (_event, startIso: string, endIso: string) =>
    db.countSuccessfulVideosBetween(startIso, endIso)
  );
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
  ipcMain.handle("operation-logs:list", (_event, limit?: number) => db.listOperationLogs(limit || 500));
  ipcMain.handle("operation-logs:clear", () => {
    db.clearOperationLogs();
    return true;
  });
}

function recordOperation(
  requestId: string | null,
  accountId: number | null,
  action: string,
  status: "info" | "success" | "failed",
  message: string,
  targetUrl?: string | null
) {
  db.appendOperationLog({ requestId, accountId, action, status, message, targetUrl });
  notifyDataChanged();
}

function refreshQuotas() {
  if (db.refreshDailyQuotas() > 0) {
    executor.wake();
    notifyDataChanged();
  }
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DoubaoModel | null {
  if (model === "seedance_2_0_mini" || model === "seedance_2_0_fast") return model;
  return null;
}

function normalizeAspectRatio(value: unknown): DoubaoAspectRatio | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/\s+/g, "").trim();
  if (normalized === "9:16" || normalized === "16:9") return normalized;
  return null;
}

function isAuthorized(request: IncomingMessage, apiKey: string) {
  if (!apiKey.trim()) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

async function readGenerateRequest(request: IncomingMessage, requestId: string): Promise<GenerateRequestBody> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartGenerateRequest(await readBufferBody(request), contentType, requestId);
  }
  return readJsonBody<GenerateRequestBody>(request);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readBufferBody(request)).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readBufferBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseMultipartGenerateRequest(buffer: Buffer, contentType: string, requestId: string): Promise<GenerateRequestBody> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("multipart boundary is required");

  const fields: Record<string, string> = {};
  const uploadedReferenceImagePaths: string[] = [];
  const uploadedReferenceVideoPaths: string[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename) {
      if (["referenceImages", "referenceImage"].includes(disposition.name) && body.length > 0) {
        if (uploadedReferenceImagePaths.length >= 9) throw new Error("a maximum of 9 reference images is supported");
        uploadedReferenceImagePaths.push(await saveUploadedFile({
          requestId,
          fieldName: `reference-${uploadedReferenceImagePaths.length + 1}`,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body
        }));
      }
      if (["referenceVideos", "referenceVideo"].includes(disposition.name) && body.length > 0) {
        if (uploadedReferenceVideoPaths.length >= 3) throw new Error("a maximum of 3 reference videos is supported");
        uploadedReferenceVideoPaths.push(await saveUploadedFile({
          requestId,
          fieldName: `reference-video-${uploadedReferenceVideoPaths.length + 1}`,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body
        }));
      }
      continue;
    }

    fields[disposition.name] = body.toString("utf8");
  }

  return {
    accountId: fields.accountId,
    model: fields.model as DoubaoModel | undefined,
    aspectRatio: fields.aspectRatio || null,
    duration: fields.duration || undefined,
    resolution: fields.resolution || undefined,
    prompt: fields.prompt || "",
    referenceImagePath: uploadedReferenceImagePaths[0] || fields.referenceImagePath || null,
    referenceImagePaths: uploadedReferenceImagePaths,
    referenceVideoPaths: uploadedReferenceVideoPaths,
    referenceImageUrl: fields.referenceImageUrl || null,
    removeWatermark: parseOptionalBoolean(fields.removeWatermark),
    callbackUrl: fields.callbackUrl || null,
    source: fields.source || "multipart-api"
  };
}

async function prepareReferenceImages(body: GenerateRequestBody, requestId: string) {
  const inputs = [
    ...(Array.isArray(body.referenceImages) ? body.referenceImages : []),
    ...(Array.isArray(body.referenceImagePaths) ? body.referenceImagePaths : []),
    ...(body.referenceImagePath ? [body.referenceImagePath] : []),
    ...(body.referenceImageUrl ? [body.referenceImageUrl] : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const unique = [...new Set(inputs.map(value => value.trim()))];
  if (unique.length > 9) throw new Error("a maximum of 9 reference images is supported");

  const prepared: string[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const value = unique[index];
    if (!/^https?:\/\//i.test(value)) {
      const resolved = path.resolve(value);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isFile()) throw new Error(`参考图不存在：${resolved}`);
      prepared.push(resolved);
      continue;
    }

    const response = await fetch(value);
    if (!response.ok) throw new Error(`参考图下载失败（${index + 1}）：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const urlExt = path.extname(new URL(value).pathname);
    const ext = urlExt || extensionFromContentType(contentType) || ".png";
    const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
    await fs.mkdir(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, `${requestId}-reference-${index + 1}${ext}`);
    await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
    prepared.push(imagePath);
  }
  return prepared;
}

async function prepareReferenceVideos(body: GenerateRequestBody, requestId: string) {
  const inputs = [
    ...(Array.isArray(body.referenceVideoPaths) ? body.referenceVideoPaths : []),
    ...(body.referenceVideoPath ? [body.referenceVideoPath] : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const unique = [...new Set(inputs.map(value => value.trim()))];
  if (unique.length > 3) throw new Error("a maximum of 3 reference videos is supported");

  const prepared: string[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const value = unique[index];
    if (!/^https?:\/\//i.test(value)) {
      const resolved = path.resolve(value);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isFile()) throw new Error(`参考视频不存在：${resolved}`);
      prepared.push(resolved);
      continue;
    }

    const response = await fetch(value);
    if (!response.ok) throw new Error(`参考视频下载失败（${index + 1}）：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const urlExt = path.extname(new URL(value).pathname);
    const ext = urlExt || (contentType.includes("quicktime") ? ".mov" : ".mp4");
    const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
    await fs.mkdir(uploadDir, { recursive: true });
    const videoPath = path.join(uploadDir, `${requestId}-reference-video-${index + 1}${ext}`);
    await fs.writeFile(videoPath, Buffer.from(await response.arrayBuffer()));
    prepared.push(videoPath);
  }
  return prepared;
}

async function saveUploadedFile(input: {
  requestId: string;
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}) {
  const safeName = sanitizeFilename(input.filename || `${input.fieldName}${extensionFromContentType(input.contentType) || ".png"}`);
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${input.requestId}-${input.fieldName}-${safeName}`);
  await fs.writeFile(filePath, input.bytes);
  return filePath;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string) {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const unquoted = rawValue.join("=").trim().replace(/^"|"$/g, "");
    if (key === "name") result.name = unquoted;
    if (key === "filename") result.filename = unquoted;
  }
  return result;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function extensionFromContentType(contentType?: string) {
  if (!contentType) return null;
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return null;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(payload))
  }).catch(() => undefined);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log.initialize();
    db = new AppDatabase();
    await purgeOrphanAccountPartitions();
    executor = new DoubaoExecutor(db, notifyDataChanged, observeWatermarkResponse);
    apiServer = new LocalApiServer(db, executor);
    const queuedRequests = db.prepareQueueAfterRestart();
    quotaTimer = new DailyQuotaTimer(refreshQuotas);
    quotaTimer.start();
    powerMonitor.on("resume", () => quotaTimer?.refresh());
    registerIpc();
    await apiServer.applySettings(db.getSettings());
    for (const requestId of queuedRequests) executor.enqueue(requestId);
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  }).catch((error) => {
    log.error(error);
  });
}

app.on("before-quit", async () => {
  quotaTimer?.stop();
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
