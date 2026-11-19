import { createDecipheriv, createHash } from "node:crypto";

/**
 * 豆包无水印视频解析。
 *
 * 思路来自开源实现 ihmily/doubao-nomark 与 idonweb/doubao-web-uwd：
 * 分享页 HTML 里带有 fallback_api（/video/fplay/...），把它改写成
 * codec_type=8 & logo_type=unwatermarked 后请求，响应里的 main_url 是一段
 * qAAB 加密 token，配合同响应里的 key_seed 解出真正的无水印 MP4 地址。
 *
 * 这里不依赖任何第三方服务，也不依赖账号登录态：传入对话/分享链接即可。
 */

const QAAB_SALT = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a6733ba4" +
    "1cb2462b829ab58a196b39db57177524" +
    "f49baf7f08e8d68d26a72e37c1a95a2f" +
    "1f05a51892aef2949732b62a38aadd58",
  "hex",
);

const FALLBACK_HOST_SUFFIXES = [".snssdk.com", ".douyinvod.com", ".dola.com", ".byteintlapi.com"];
const FALLBACK_DROP_PARAMS = ["codec_type", "logo_type"];
const UNWATERMARKED_PARAMS: [string, string][] = [
  ["codec_type", "8"],
  ["logo_type", "unwatermarked"],
];

const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

export type CleanVideoResult = {
  url: string;
  /** 解析走通的环节，便于排查：fallback_api 解密成功 / 仅改写 lr 参数 */
  via: "fallback_api" | "rewrite";
  width?: number;
  height?: number;
  definition?: string;
};

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
}

function decodeBase64Loose(value: string): Buffer | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const variants = [
    text,
    text.replace(/\$/g, "_").replace(/@/g, "/").replace(/#/g, "."),
    text.replace(/\$/g, "+").replace(/@/g, "/").replace(/#/g, "="),
  ];
  const seen = new Set<string>();
  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
    normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) continue;
    try {
      return Buffer.from(normalized, "base64");
    } catch {
      continue;
    }
  }
  return null;
}

function urlFromBytes(value: Buffer | null): string {
  if (!value || value.length === 0) return "";
  for (const byte of value) {
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!printable) return "";
  }
  const text = value.toString("ascii").trim();
  return isHttpUrl(text) ? text : "";
}

/** 解密结果尾部带 PKCS7 填充，不能要求整段都可打印，只截取 http 开头到第一个不可打印字节。 */
function urlFromPlaintext(value: Buffer): string {
  if (!value || value.length === 0) return "";
  const text = value.toString("latin1");
  const start = text.indexOf("http");
  if (start < 0) return "";
  let end = start;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code < 33 || code > 126) break;
    end += 1;
  }
  const candidate = text.slice(start, end).trim();
  return isHttpUrl(candidate) ? candidate : "";
}

function stripPkcs7(value: Buffer): Buffer {
  if (value.length === 0) return value;
  const padding = value[value.length - 1];
  if (padding < 1 || padding > 16 || padding > value.length) return value;
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) return value;
  }
  return value.subarray(0, value.length - padding);
}

function decryptAesCbcUrl(payload: Buffer, key: Buffer, iv: Buffer): string {
  if (!payload || payload.length % 16 !== 0) return "";
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return urlFromPlaintext(plaintext) || urlFromBytes(stripPkcs7(plaintext));
  } catch {
    return "";
  }
}

function decodeQaabToken(token: string, keySeed: string): string {
  const data = decodeBase64Loose(token);
  const seed = decodeBase64Loose(keySeed);
  if (!data || !seed) return "";

  const firstDigest = createHash("sha512").update(seed.subarray(0, 32)).digest();
  const material = createHash("sha512")
    .update(Buffer.concat([firstDigest, QAAB_SALT]))
    .digest();
  const key = material.subarray(0, 16);
  const iv = material.subarray(16, 32);

  const hasPrefix = data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00;
  const attempts: [Buffer, Buffer, Buffer][] = [];
  if (hasPrefix) {
    attempts.push([data.subarray(4), key, iv]);
    attempts.push([data.subarray(4), iv, key]);
    if (data.length > 36) {
      attempts.push([data.subarray(36), key, data.subarray(20, 36)]);
      attempts.push([data.subarray(36), key, iv]);
    }
  } else {
    attempts.push([data, key, iv]);
  }
  for (const [payload, attemptKey, attemptIv] of attempts) {
    const url = decryptAesCbcUrl(payload, attemptKey, attemptIv);
    if (url) return url;
  }
  return "";
}

export function decodeMediaUrl(token: string, keySeed = ""): string {
  const text = String(token || "").trim();
  if (!text) return "";
  if (isHttpUrl(text)) return text;

  const decoded = decodeBase64Loose(text);
  const plain = urlFromBytes(decoded);
  if (plain) return plain;

  if (text.startsWith("qAAB") && keySeed) return decodeQaabToken(text, keySeed);
  return "";
}

/** 只改写 lr 参数：轻量兜底，站点加密档位下通常拿不到干净原片。 */
export function rewriteUnwatermarkedUrl(videoUrl: string): string {
  try {
    const parsed = new URL(videoUrl);
    parsed.searchParams.delete("logo_type");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^downsize_watermark/.test(key)) parsed.searchParams.delete(key);
    }
    const lr = parsed.searchParams.get("lr");
    if (lr && /watermark/i.test(lr)) parsed.searchParams.set("lr", "video_gen_no_watermark");
    return parsed.toString();
  } catch {
    return videoUrl;
  }
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/");
}

function buildUnwatermarkedApiUrl(fallbackApi: string): string | null {
  try {
    const parsed = new URL(htmlUnescape(fallbackApi).replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
    if (parsed.protocol !== "https:") return null;
    if (!parsed.pathname.startsWith("/video/fplay/")) return null;
    const host = parsed.hostname.toLowerCase();
    const trusted = FALLBACK_HOST_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
    );
    if (!trusted) return null;
    for (const key of FALLBACK_DROP_PARAMS) parsed.searchParams.delete(key);
    for (const [key, value] of UNWATERMARKED_PARAMS) parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 分享页会把数据嵌进多层 JSON 字符串，反斜杠与 &quot; 层层叠加，这里统一还原。 */
function decodeEscapedSegment(segment: string): string {
  return segment
    .replace(/\\*u002[Ff]/g, "/")
    .replace(/\\*u0026/g, "&")
    .replace(/\\*u003[Aa]/g, ":")
    .replace(/\\*u003[Dd]/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\\/g, "");
}

function collectFallbackApisFromRawHtml(html: string): string[] {
  const found = new Map<string, true>();
  const marker = "fallback_api";
  let index = html.indexOf(marker);
  while (index >= 0) {
    const segment = decodeEscapedSegment(html.slice(index, index + 600));
    const match = /https?:\/\/[^"'\s<>]+/.exec(segment);
    if (match && buildUnwatermarkedApiUrl(match[0])) found.set(match[0], true);
    index = html.indexOf(marker, index + marker.length);
  }
  return [...found.keys()];
}

function collectFallbackApis(html: string): string[] {
  const found = new Map<string, true>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    if (!buildUnwatermarkedApiUrl(candidate)) return;
    found.set(candidate, true);
  };
  const walk = (value: unknown, depth = 0) => {
    if (depth > 30 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.fallback_api === "string") add(record.fallback_api);
      for (const child of Object.values(record)) walk(child, depth + 1);
      return;
    }
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        walk(JSON.parse(value), depth + 1);
      } catch {
        // 非 JSON 字符串，忽略
      }
    }
  };

  const scriptPattern = /<script\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const tag = match[0];
    if (!/data-script-src="(?:modern-run-router-data-fn|modern-run-window-fn)"/.test(tag)) continue;
    const args = /data-fn-args="([\s\S]*?)"/.exec(tag);
    if (!args) continue;
    try {
      walk(JSON.parse(htmlUnescape(args[1])));
    } catch {
      continue;
    }
  }
  for (const api of collectFallbackApisFromRawHtml(html)) found.set(api, true);
  return [...found.keys()];
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type FplayEntry = Record<string, unknown>;

function parseFplayPayload(payload: unknown): { url: string; width: number; height: number; definition: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const videoInfo = (root.video_info ?? (root.data as Record<string, unknown> | undefined)?.video_info ?? root) as
    | Record<string, unknown>
    | undefined;
  const data = ((videoInfo?.data as Record<string, unknown> | undefined) ?? videoInfo ?? {}) as Record<string, unknown>;

  const list = data.video_list;
  let candidates: FplayEntry[] = [];
  if (Array.isArray(list)) candidates = list.filter((item): item is FplayEntry => Boolean(item) && typeof item === "object");
  else if (list && typeof list === "object") candidates = Object.values(list).filter((item): item is FplayEntry => Boolean(item) && typeof item === "object");
  else candidates = [data];

  const usable = candidates.filter(
    (entry) => typeof entry.main_url === "string" || typeof entry.play_url === "string",
  );
  if (!usable.length) return null;

  const best = usable.sort((left, right) => {
    const area = (entry: FplayEntry) =>
      numberOrZero(entry.vwidth ?? entry.width) * numberOrZero(entry.vheight ?? entry.height);
    const bitrate = (entry: FplayEntry) => numberOrZero(entry.bitrate ?? entry.real_bitrate);
    return area(right) - area(left) || bitrate(right) - bitrate(left);
  })[0];

  const seedValue = data.key_seed ?? videoInfo?.key_seed ?? root.key_seed ?? "";
  const token = String(best.main_url ?? best.play_url ?? "");
  const url = decodeMediaUrl(token, String(seedValue));
  if (!url) return null;

  return {
    url,
    width: Math.round(numberOrZero(best.vwidth ?? best.width ?? data.vwidth ?? data.width)),
    height: Math.round(numberOrZero(best.vheight ?? best.height ?? data.vheight ?? data.height)),
    definition: String(best.definition ?? data.definition ?? ""),
  };
}

async function fetchText(url: string, timeoutMs: number) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { body: await response.text(), finalUrl: response.url };
}

/**
 * 把豆包对话/分享链接换成无水印原片地址。
 * 失败返回 null，调用方应回退到原始直链，不要因此把任务判失败。
 */
export async function resolveDoubaoCleanVideo(
  threadUrl: string,
  options: {
    timeoutMs?: number;
    /** 便于单测注入；生产环境走真实网络。 */
    fetchPage?: (url: string) => Promise<string>;
    fetchJson?: (url: string) => Promise<unknown>;
  } = {},
): Promise<CleanVideoResult | null> {
  if (!threadUrl || !/^https?:\/\//i.test(threadUrl)) return null;
  const timeoutMs = options.timeoutMs ?? 20_000;

  try {
    const pageHtml = options.fetchPage
      ? await options.fetchPage(threadUrl)
      : (await fetchText(threadUrl, timeoutMs)).body;
    const apis = collectFallbackApis(pageHtml);
    for (const api of apis) {
      const unwatermarked = buildUnwatermarkedApiUrl(api);
      if (!unwatermarked) continue;
      try {
        const payload = options.fetchJson
          ? await options.fetchJson(unwatermarked)
          : JSON.parse((await fetchText(unwatermarked, timeoutMs)).body);
        const parsed = parseFplayPayload(payload);
        if (parsed) return { ...parsed, via: "fallback_api" };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}
