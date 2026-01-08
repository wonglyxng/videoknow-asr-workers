/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Buffer } from "node:buffer";

export interface Env {
  AI: any; // Workers AI binding
  VIDEO_KNOW_DEV: R2Bucket; // R2 binding
  AUTH_KEY: string; // Wrangler secret
}

function openaiError(
  message: string,
  status = 400,
  type: string = "invalid_request_error",
  param: string | null = null,
  code: string | null = null
) {
  return new Response(
    JSON.stringify({ error: { message, type, param, code } }),
    { status, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}

function requireBearerAuth(req: Request, env: Env) {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!(m?.[1] && m[1] === env.AUTH_KEY);
}

/** VTT -> SRT（够用版） */
function vttToSrt(vtt: string) {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let cueIndex = 1;

  // 跳过 WEBVTT 头（直到空行）
  while (i < lines.length && lines[i].trim() !== "") i++;
  while (i < lines.length && lines[i].trim() === "") i++;

  const toSrtTime = (t: string) => t.replace(".", ",");

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    if (line.includes("-->")) {
      out.push(String(cueIndex++));
      const timing = line
        .split("-->")
        .map((x) => x.trim().split(/\s+/)[0])
        .map(toSrtTime)
        .join(" --> ");
      out.push(timing);

      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        out.push(lines[i]);
        i++;
      }
      out.push("");
    } else {
      i++;
    }
  }

  return out.join("\n");
}

/** 从 multipart/form-data 里读取音频：优先 file，其次 r2_key（扩展） */
async function loadAudioBytes(form: FormData, env: Env): Promise<Uint8Array> {
  const file = form.get("file");
  if (file instanceof File) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  const r2Key = form.get("r2_key")?.toString();
  if (r2Key) {
    const obj = await env.VIDEO_KNOW_DEV.get(r2Key);
    if (!obj) throw new Error(`R2 object not found: ${r2Key}`);
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  throw new Error('Missing "file" (multipart file) or "r2_key" (string)');
}

/** 把 turbo 输出对齐到 OpenAI verbose_json 的常用形状 */
function toOpenAIVerboseJson(cfResp: any, opts: { wantSegments: boolean; wantWords: boolean; fallbackLanguage?: string }) {
  const text: string = cfResp?.text ?? "";
  const info = cfResp?.transcription_info ?? {};
  const duration = Number(info?.duration ?? 0);
  const language = String(info?.language ?? opts.fallbackLanguage ?? "unknown");

  const cfSegments: any[] = Array.isArray(cfResp?.segments) ? cfResp.segments : [];

  const segments = opts.wantSegments
    ? cfSegments.map((s, idx) => ({
        id: idx,
        seek: 0,
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text ?? ""),
        // 这些字段 turbo 可能会给；没有就会是 undefined（JSON.stringify 会保留键但值为 null? 这里不强加）
        temperature: s.temperature,
        avg_logprob: s.avg_logprob,
        compression_ratio: s.compression_ratio,
        no_speech_prob: s.no_speech_prob
      }))
    : [];

  let words: Array<{ word: string; start: number; end: number }> | undefined;
  if (opts.wantWords) {
    const out: Array<{ word: string; start: number; end: number }> = [];
    for (const seg of cfSegments) {
      const ws = Array.isArray(seg?.words) ? seg.words : [];
      for (const w of ws) {
        const word = String(w.word ?? "");
        const start = Number(w.start);
        const end = Number(w.end);
        if (word && Number.isFinite(start) && Number.isFinite(end)) out.push({ word, start, end });
      }
    }
    if (out.length) words = out;
  }

  const payload: any = {
    task: "transcribe",
    language,
    duration,
    text,
    segments,
    usage: {
      type: "duration",
      seconds: Math.max(1, Math.ceil(duration || 0))
    }
  };
  if (words) payload.words = words;
  return payload;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // health
    if (url.pathname === "/health") return new Response("ok");

    // 可选：让一些 SDK 探测模型时不报错（简化版）
    if (url.pathname === "/v1/models") {
      if (!requireBearerAuth(request, env)) return openaiError("Invalid API key", 401, "invalid_api_key");
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "whisper-1", object: "model" }]
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // OpenAI 兼容：/v1/audio/transcriptions
    if (url.pathname === "/v1/audio/transcriptions") {
      if (request.method !== "POST") return openaiError("Method not allowed", 405);

      if (!requireBearerAuth(request, env)) {
        return openaiError("Invalid API key", 401, "invalid_api_key");
      }

      const ct = request.headers.get("content-type") || "";
      if (!ct.toLowerCase().includes("multipart/form-data")) {
        return openaiError("Content-Type must be multipart/form-data", 400, "invalid_request_error", "Content-Type");
      }

      const form = await request.formData();

      // OpenAI：model 必填（即使你内部不使用它，也要收下） 
      const model = form.get("model")?.toString();
      if (!model) return openaiError('Missing required field "model"', 400, "invalid_request_error", "model");

      const responseFormat = (form.get("response_format")?.toString() || "json").toLowerCase();
      const timestampGranularities = form.getAll("timestamp_granularities[]").map((x) => x.toString());

      // OpenAI：timestamp_granularities 只有 verbose_json 才允许
      if (timestampGranularities.length > 0 && responseFormat !== "verbose_json") {
        return openaiError(
          'timestamp_granularities requires response_format="verbose_json"',
          400,
          "invalid_request_error",
          "timestamp_granularities[]"
        );
      }

      // 读取音频
      let audioBytes: Uint8Array;
      try {
        audioBytes = await loadAudioBytes(form, env);
      } catch (e: any) {
        return openaiError(e?.message || "Failed to load audio", 400, "invalid_request_error", "file");
      }

      // OpenAI 兼容字段：language / prompt
      const language = form.get("language")?.toString();
      const prompt = form.get("prompt")?.toString();

      // turbo 输入：base64
      const audioBase64 = Buffer.from(audioBytes).toString("base64");

      const cfResp = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        audio: audioBase64,
        task: "transcribe",
        language, // 可选
        initial_prompt: prompt // 语义最接近 OpenAI 的 prompt
        // 你还可以按需加：vad_filter / prefix 等
      });

      const text: string = cfResp?.text ?? "";
      const vtt: string | undefined = cfResp?.vtt;

      // 按 response_format 返回
      if (responseFormat === "text") {
        return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      if (responseFormat === "vtt") {
        if (!vtt) return openaiError("VTT not available from model output", 400, "invalid_request_error", "response_format");
        return new Response(vtt, { headers: { "Content-Type": "text/vtt; charset=utf-8" } });
      }

      if (responseFormat === "srt") {
        if (!vtt) return openaiError("SRT requires VTT output from model", 400, "invalid_request_error", "response_format");
        return new Response(vttToSrt(vtt), { headers: { "Content-Type": "application/x-subrip; charset=utf-8" } });
      }

      if (responseFormat === "verbose_json") {
        const wantWords = timestampGranularities.includes("word");
        const wantSegments = timestampGranularities.length === 0 || timestampGranularities.includes("segment");

        const payload = toOpenAIVerboseJson(cfResp, {
          wantSegments,
          wantWords,
          fallbackLanguage: language
        });

        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      // 默认 json（OpenAI 通常是 { text }）
      return new Response(JSON.stringify({ text }), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
