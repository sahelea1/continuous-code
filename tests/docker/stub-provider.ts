import { createServer } from "http"

const PORT = parseInt(process.env.STUB_PORT || "18080")

interface ChatMessage {
  role: string
  content: string
}

interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
}

const CANNED_RESPONSES: Record<string, string> = {
  default: "I've completed the task as requested.",
  scout: "Based on my exploration of the codebase, here are the relevant files and patterns I found.",
  oracle: "After researching the documentation, here is what I found.",
  error: "I cannot perform this action directly. Please use the appropriate subagent via the task tool.",
}

function getResponse(messages: ChatMessage[]): string {
  const lastMessage = messages[messages.length - 1]?.content || ""

  if (lastMessage.includes("scout") || lastMessage.includes("explore")) {
    return CANNED_RESPONSES.scout
  }
  if (lastMessage.includes("oracle") || lastMessage.includes("research")) {
    return CANNED_RESPONSES.oracle
  }
  if (lastMessage.includes("read") || lastMessage.includes("grep") || lastMessage.includes("bash")) {
    return CANNED_RESPONSES.error
  }
  return CANNED_RESPONSES.default
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "deepseek-v4-pro:cloud", object: "model" },
        { id: "deepseek-v4-flash:cloud", object: "model" },
      ],
    }))
    return
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      const request: ChatRequest = JSON.parse(body)
      const response = getResponse(request.messages)

      if (request.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        })

        const chunk = {
          id: "stub-1",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: response },
            finish_reason: "stop",
          }],
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          id: "stub-1",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: response },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end("Not found")
})

server.listen(PORT, () => {
  console.log(`Stub provider listening on port ${PORT}`)
})
