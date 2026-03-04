# copilotsdk2api

OpenAI-compatible API service backed by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) (`@github/copilot-sdk`).

Expose Copilot models through a drop-in OpenAI API, so any OpenAI-compatible client can talk to GitHub Copilot.

---

## Requirements

- **Node.js** ≥ 20
- **GitHub Copilot CLI** installed and available in `PATH` (`copilot`)  
  See [installation guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)
- A **GitHub Copilot subscription** (or BYOK configuration)

## Installation

```bash
npm install
npm run build
```

## Configuration

Set one of the following environment variables to authenticate with GitHub:

| Variable | Description |
|---|---|
| `COPILOT_GITHUB_TOKEN` | GitHub token for Copilot (highest priority) |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GH_TOKEN` | Alternate token variable |
| `PORT` | HTTP port (default: `3000`) |

If none of these are set the SDK falls back to the stored credentials from `gh auth login` or `copilot auth login`.

### Image Compression

When images are included in chat messages, they are downloaded to a temporary local file before being sent to the Copilot session. The following options control whether those images are compressed first:

| Variable | Description |
|---|---|
| `IMAGE_COMPRESS_ENABLED` | Enable image compression before upload (default: `true`). Set to `false` or `0` to disable. |
| `IMAGE_COMPRESS_MAX_SIZE` | Maximum width or height in pixels after resizing (default: `1920`). The image is resized proportionally so neither dimension exceeds this value. |

Image compression uses [sharp](https://sharp.pixelplumbing.com/), which works on Windows, Linux, and macOS.

## Running the Server

```bash
# Development (tsx, no build step)
npm run dev

# Production (after `npm run build`)
npm start
```

## API Endpoints

### `GET /v1/models`

Returns the list of available Copilot models in OpenAI format.

```bash
curl http://localhost:3000/v1/models
```

### `POST /v1/chat/completions`

Sends a chat completion request. Supports both streaming and non-streaming responses.

**Non-streaming:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

**Streaming:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ],
    "stream": true
  }'
```

**JSON 模式 (格式化输出):**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant. Respond in valid JSON."},
      {"role": "user", "content": "Return a JSON object with the keys \"name\" and \"age\" for a fictional character."}
    ],
    "response_format": { "type": "json_object" }
  }'
```

**图片分析与格式化输出:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "请分析这张图片的内容，并以 JSON 格式返回。要求包含两个字段: \"image_url\" (图片的 URL) 和 \"description\" (图片的详细描述)。"
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://raw.githubusercontent.com/github/copilot-sdk/main/docs/assets/copilot-sdk-logo.png"
            }
          }
        ]
      }
    ],
    "response_format": { "type": "json_object" }
  }'
```

**多模态 (图片分析):**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-o",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "这幅图中有什么？" },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://wallpapers.com/images/hd/cute-cats-pictures-ofp9qyt72qck6jqg.jpg"
            }
          }
        ]
      }
    ]
  }'
```

## Using with OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "not-needed", // any non-empty string works
});

const response = await client.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

## Architecture

```
OpenAI-compatible client
         ↓ HTTP (OpenAI API format)
   copilotsdk2api (Express)
         ↓ @github/copilot-sdk (JSON-RPC)
   Copilot CLI (server mode)
         ↓
   GitHub Copilot backend
```

Each `POST /v1/chat/completions` request creates a fresh Copilot session.
The full conversation history from the `messages` array is injected via the
session's system message so the model always has the proper context.

## License

MIT
