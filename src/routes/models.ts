import { type Request, type Response } from "express";
import { listModels } from "../copilot.js";
import type { ModelsListResponse, ErrorResponse } from "../types/openai.js";
import { log } from "../logger.js";

/**
 * GET /v1/models
 * Returns available models in OpenAI-compatible format.
 */
export async function modelsHandler(
  _req: Request,
  res: Response
): Promise<void> {
  log("GET /v1/models");
  try {
    const models = await listModels();
    log(`Models listed: ${models.map((m) => m.id).join(", ")}`);

    const response: ModelsListResponse = {
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "github-copilot",
      })),
    };

    res.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body: ErrorResponse = {
      error: {
        message,
        type: "server_error",
      },
    };
    res.status(500).json(body);
  }
}
