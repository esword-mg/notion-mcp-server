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

if (!NOTION_API_KEY) {
  console.error("NOTION_API_KEY is not set.");
}

function getPropertyValue(property) {
  if (!property) return null;

  switch (property.type) {
    case "title":
      return property.title?.map((x) => x.plain_text).join("") ?? "";

    case "rich_text":
      return property.rich_text?.map((x) => x.plain_text).join("") ?? "";

    case "select":
      return property.select?.name ?? null;

    case "multi_select":
      return property.multi_select?.map((x) => x.name) ?? [];

    case "date":
      return property.date?.start ?? null;

    case "checkbox":
      return property.checkbox ?? false;

    case "number":
      return property.number ?? null;

    case "url":
      return property.url ?? null;

    case "email":
      return property.email ?? null;

    case "phone_number":
      return property.phone_number ?? null;

    case "status":
      return property.status?.name ?? null;

    case "formula": {
      const type = property.formula?.type;
      return type ? property.formula[type] ?? null : null;
    }

    default:
      return null;
  }
}


/*
 * Notion DB의 모든 페이지를 가져옵니다.
 * 100개씩 pagination 처리하여 366개 전체를 가져옵니다.
 */
async function queryAllPages(databaseId) {
  const results = [];
  let startCursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });

    results.push(...(response.results || []));

    startCursor = response.has_more
      ? response.next_cursor
      : undefined;

  } while (startCursor);

  return results;
}


/*
 * Notion 페이지를 간단한 JSON 형태로 변환합니다.
 */
function pageToJson(page) {
  const result = {
    id: page.id,
    url: page.url ?? null,
  };

  for (const [name, property] of Object.entries(page.properties || {})) {
    result[name] = getPropertyValue(property);
  }

  return result;
}


/*
 * MCP Server
 */
const mcpServer = new Server(
  {
    name: "notion-mcp-server",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);


/*
 * MCP Tool 목록
 */
mcpServer.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [

      {
        name: "count_database_rows",

        description:
          "노션 데이터베이스의 총 행(페이지) 개수를 세어줍니다.",

        inputSchema: {
          type: "object",

          properties: {
            database_id: {
              type: "string",
              description: "노션 데이터베이스 ID",
            },
          },

          required: ["database_id"],
        },
      },


      {
        name: "get_database_rows",

        description:
          "노션 데이터베이스의 모든 행을 가져옵니다.",

        inputSchema: {
          type: "object",

          properties: {
            database_id: {
              type: "string",
              description: "노션 데이터베이스 ID",
            },
          },

          required: ["database_id"],
        },
      },

    ],
  })
);


/*
 * MCP Tool 실행
 */
mcpServer.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {

    const {
      name,
      arguments: args
    } = request.params;

    try {

      /*
       * Tool 1:
       * DB 행 개수
       */
      if (name === "count_database_rows") {

        const pages =
          await queryAllPages(args.database_id);

        return {
          content: [
            {
              type: "text",

              text:
                `해당 데이터베이스의 총 행 개수는 ${pages.length}개입니다.`,
            },
          ],
        };
      }


      /*
       * Tool 2:
       * DB 전체 데이터
       */
      if (name === "get_database_rows") {

        const pages =
          await queryAllPages(args.database_id);

        const rows =
          pages.map(pageToJson);

        return {
          content: [
            {
              type: "text",

              text: JSON.stringify(
                {
                  success: true,
                  count: rows.length,
                  results: rows,
                },

                null,
                2
              ),
            },
          ],
        };
      }


      throw new Error(
        `알 수 없는 도구: ${name}`
      );

    } catch (error) {

      return {
        content: [
          {
            type: "text",
            text:
              `오류 발생: ${error.message}`,
          },
        ],

        isError: true,
      };
    }
  }
);


/*
 * MCP SSE 연결
 */
let transport;


app.get(
  "/sse",
  async (req, res) => {

    try {

      transport =
        new SSEServerTransport(
          "/messages",
          res
        );

      await mcpServer.connect(
        transport
      );

    } catch (error) {

      console.error(
        "SSE error:",
        error
      );

      if (!res.headersSent) {

        res.status(500).json({
          success: false,
          error: error.message,
        });

      }
    }
  }
);


/*
 * MCP 메시지
 */
app.post(
  "/messages",
  async (req, res) => {

    if (!transport) {

      return res.status(503).json({
        success: false,
        error:
          "MCP SSE transport is not connected.",
      });

    }

    try {

      await transport.handlePostMessage(
        req,
        res
      );

    } catch (error) {

      console.error(
        "MCP message error:",
        error
      );

      if (!res.headersSent) {

        res.status(500).json({
          success: false,
          error: error.message,
        });

      }
    }
  }
);


/*
 * REST API
 * DB 행 개수
 */
app.post(
  "/api/count-rows",
  async (req, res) => {

    const {
      database_id
    } = req.body;

    if (!database_id) {

      return res.status(400).json({
        success: false,
        error:
          "database_id is required.",
      });

    }

    try {

      const pages =
        await queryAllPages(
          database_id
        );

      res.json({
        success: true,
        count: pages.length,
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message,
      });

    }
  }
);


/*
 * REST API
 *
 * GET /api/questions
 *
 * Questions DB 전체 데이터를 가져옵니다.
 *
 * database_id를 URL에 넣거나
 * Render 환경변수에
 *
 * QUESTIONS_DATABASE_ID
 *
 * 를 설정할 수 있습니다.
 */
app.get(
  "/api/questions",
  async (req, res) => {

    const databaseId =
      req.query.database_id ||
      process.env.QUESTIONS_DATABASE_ID;


    if (!databaseId) {

      return res.status(400).json({

        success: false,

        error:
          "database_id is required. " +
          "Use ?database_id=... " +
          "or set QUESTIONS_DATABASE_ID in Render.",

      });

    }


    try {

      const pages =
        await queryAllPages(
          databaseId
        );

      const rows =
        pages.map(pageToJson);


      res.json({

        success: true,

        count: rows.length,

        results: rows,

      });


    } catch (error) {

      console.error(
        "questions API error:",
        error
      );


      res.status(500).json({

        success: false,

        error: error.message,

      });

    }
  }
);


/*
 * REST API
 *
 * 특정 Notion 페이지 조회
 */
app.get(
  "/api/page/:pageId",
  async (req, res) => {

    try {

      const page =
        await notion.pages.retrieve({

          page_id:
            req.params.pageId,

        });


      res.json({

        success: true,

        result:
          pageToJson(page),

      });


    } catch (error) {

      res.status(500).json({

        success: false,

        error: error.message,

      });

    }
  }
);


/*
 * 서버 상태 확인
 */
app.get(
  "/",
  (req, res) => {

    res.json({

      success: true,

      service:
        "notion-mcp-server",

      version:
        "1.1.0",

      endpoints: {

        questions:
          "/api/questions",

        page:
          "/api/page/:pageId",

        countRows:
          "/api/count-rows",

        mcpSse:
          "/sse",

        mcpMessages:
          "/messages",

      },

    });

  }
);


/*
 * 서버 시작
 */
app.listen(
  PORT,
  () => {

    console.log(
      `Render MCP server is running on port ${PORT}.`
    );

  }
);
