import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { type Request, type Response } from "express";
import { approveAll, type CopilotSession } from "@github/copilot-sdk";
import { getClient } from "../copilot.js";
import { isImageCompressEnabled, compressImage } from "../imageUtils.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Message,
  ContentPart,
  ErrorResponse,
} from "../types/openai.js";

/**
 * Extracts plain text from a message's content (string or ContentPart array).
 */
function messageContentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Extracts image URLs from a message's content (string or ContentPart array).
 */
function extractImageUrls(content: string | ContentPart[]): string[] {
  if (typeof content === "string") {
    return [];
  }
  return content
    .filter((p): p is Extract<ContentPart, { type: "image_url" }> => p.type === "image_url")
    .map((p) => p.image_url.url);
}

/**
 * Maps common image MIME types to file extensions.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

/**
 * Downloads an image from a URL and writes it to a temporary file.
 * Returns the path to the temp file.
 */
async function downloadImageToTempFile(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = (response.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  const ext = MIME_TO_EXT[contentType] ?? "jpg";
  const tmpPath = join(tmpdir(), `copilot-img-${randomUUID()}.${ext}`);
  const buffer = await response.arrayBuffer();
  await writeFile(tmpPath, Buffer.from(buffer));
  return tmpPath;
}

/**
 * Builds the system message content from the OpenAI messages array.
 * Injects prior conversation history (before the last user message) so the
 * Copilot session has the full context even though we create a fresh session
 * for each request.
 */
function buildSystemAndPrompt(messages: Message[]): {
  systemContent: string | undefined;
  prompt: string;
  imageUrls: string[];
} {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => messageContentToText(m.content));

  const nonSystem = messages.filter((m) => m.role !== "system");

  // The last non-system message must be from the user.
  const lastMsg = nonSystem[nonSystem.length - 1];
  if (!lastMsg || lastMsg.role !== "user") {
    throw new Error("The last message must have role 'user'.");
  }

  const priorNonSystem = nonSystem.slice(0, -1);

  let systemContent: string | undefined;

  if (priorNonSystem.length > 0) {
    const historyLines = priorNonSystem.map(
      (m) => `${m.role === "user" ? "Human" : "Assistant"}: ${messageContentToText(m.content)}`
    );
    const historyBlock = `Prior conversation:\n${historyLines.join("\n")}`;
    systemContent = [...systemParts, historyBlock].join("\n\n") || undefined;
  } else if (systemParts.length > 0) {
    systemContent = systemParts.join("\n\n");
  }

  const imageUrls = extractImageUrls(lastMsg.content);

  return { systemContent, prompt: messageContentToText(lastMsg.content), imageUrls };
}

/**
 * POST /v1/chat/completions
 * Handles both streaming (SSE) and non-streaming responses.
 */
export async function chatCompletionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as ChatCompletionRequest;

  if (!body.messages || !Array.isArray(body.messages)) {
    const err: ErrorResponse = {
      error: { message: "'messages' field is required.", type: "invalid_request_error" },
    };
    res.status(400).json(err);
    return;
  }

  if (!body.model) {
    const err: ErrorResponse = {
      error: { message: "'model' field is required.", type: "invalid_request_error" },
    };
    res.status(400).json(err);
    return;
  }

  let systemContent: string | undefined;
  let prompt: string;
  let imageUrls: string[];

  try {
    ({ systemContent, prompt, imageUrls } = buildSystemAndPrompt(body.messages));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body2: ErrorResponse = { error: { message, type: "invalid_request_error" } };
    res.status(400).json(body2);
    return;
  }

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errBody: ErrorResponse = { error: { message, type: "server_error" } };
    res.status(503).json(errBody);
    return;
  }

  // Download image URLs to temp files so they can be attached to the session.
  const tempFiles: string[] = [];
  let attachments: Array<{ type: "file"; path: string; displayName: string }> = [];
  try {
    const compressEnabled = isImageCompressEnabled();
    for (const url of imageUrls) {
      const tmpPath = await downloadImageToTempFile(url);
      tempFiles.push(tmpPath);
      if (compressEnabled) {
        await compressImage(tmpPath);
      }
      attachments.push({ type: "file", path: tmpPath, displayName: new URL(url).pathname.split("/").pop() ?? "image" });
    }
  } catch (err) {
    // Clean up any partially downloaded files.
    for (const f of tempFiles) {
      await unlink(f).catch(() => undefined);
    }
    const message = err instanceof Error ? err.message : String(err);
    const errBody: ErrorResponse = { error: { message, type: "server_error" } };
    res.status(500).json(errBody);
    return;
  }

  const session = await client.createSession({
    model: body.model,
    onPermissionRequest: approveAll,
    ...(systemContent
      ? { systemMessage: { mode: "replace", content: systemContent } }
      : {}),
  });

  try {
    if (body.stream) {
      await handleStreaming(res, session, prompt, attachments, completionId, created, body.model);
    } else {
      await handleNonStreaming(res, session, prompt, attachments, completionId, created, body.model);
    }
  } finally {
    await session.destroy().catch(() => undefined);
    for (const f of tempFiles) {
      await unlink(f).catch(() => undefined);
    }
  }
}

async function handleStreaming(
  res: Response,
  session: CopilotSession,
  prompt: string,
  attachments: Array<{ type: "file"; path: string; displayName: string }>,
  completionId: string,
  created: number,
  model: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // First chunk: role delta
  const roleChunk: ChatCompletionChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  const done = new Promise<void>((resolve, reject) => {
    session.on((event) => {
      if (event.type === "assistant.message") {
        const content: string = event.data?.content ?? "";
        if (content) {
          const chunk: ChatCompletionChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } else if (event.type === "session.idle") {
        const stopChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      } else if (event.type === "session.error") {
        const message: string = (event.data as { message?: string }).message ?? "Unknown error";
        res.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        reject(new Error(message));
      }
    });
  });

  await session.send({ prompt, ...(attachments.length > 0 ? { attachments } : {}) });
  await done;
}

async function handleNonStreaming(
  res: Response,
  session: CopilotSession,
  prompt: string,
  attachments: Array<{ type: "file"; path: string; displayName: string }>,
  completionId: string,
  created: number,
  model: string
): Promise<void> {
  const reply = await session.sendAndWait({ prompt, ...(attachments.length > 0 ? { attachments } : {}) });
  const content: string = reply?.data?.content ?? "";

  const response: ChatCompletionResponse = {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };

  res.json(response);
}
