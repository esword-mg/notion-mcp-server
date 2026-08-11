import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const notion = new Client({ auth: NOTION_API_KEY });

const mcpServer = new Server(
  { name: "notion-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 1. 웹 AI가 인식할 도구(Tool) 목록 정의
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "count_database_rows",
        description: "노션 데이터베이스의 총 행(페이지) 개수를 세어줍니다.",
        inputSchema: {
          type: "object",
          properties: {
            database_id: { type: "string", description: "노션 데이터베이스 ID" },
          },
          required: ["database_id"],
        },
      },
    ],
  };
});

// 2. 도구 실행 동작
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "count_database_rows") {
      const response = await notion.databases.query({
        database_id: args.database_id,
      });
      return {
        content: [
          {
            type: "text",
            text: `해당 데이터베이스의 총 행 개수는 ${response.results.length}개입니다.`,
          },
        ],
      };
    }
    throw new Error(`알 수 없는 도구: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `오류 발생: ${error.message}` }],
      isError: true,
    };
  }
});

// 3. 웹 연결(SSE & OpenAPI/REST) 엔드포인트
let transport;
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

// 웹 AI의 Action/Custom Tool 전용 간이 REST API 엔드포인트
app.post("/api/count-rows", async (req, res) => {
  const { database_id } = req.body;
  try {
    const response = await notion.databases.query({ database_id });
    res.json({ success: true, count: response.results.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Render MCP 클라우드 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
