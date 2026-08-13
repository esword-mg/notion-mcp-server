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

const notion = new Client({
  auth: NOTION_API_KEY,
});

if (!NOTION_API_KEY) {
  console.error("NOTION_API_KEY is not set.");
}

/*
 * Notion property value helper
 */
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
 * Get all pages from a Notion database
 * Pagination is handled automatically.
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
    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  return results;
}

/*
 * Convert a Notion page to simple JSON
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
 * Get the title of a Notion database
 */
function getDatabaseTitle(database) {
  if (!database.title) {
    return "";
  }
  return database.title.map((item) => item.plain_text).join("");
}

/*
 * MCP Server
 */
const mcpServer = new Server(
  {
    name: "notion-mcp-server",
    version: "1.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/*
 * Helper: 노션 블록 객체에서 텍스트 및 주요 속성 추출
 */
function parseBlockContent(block) {
  const type = block.type;
  const blockData = block[type];

  // 1. rich_text 구조에서 순수 텍스트 조합
  let text = "";
  if (blockData && blockData.rich_text) {
    text = blockData.rich_text.map((x) => x.plain_text).join("");
  }

  // 2. 블록 타입별 추가 속성 추출
  const result = {
    id: block.id,
    type: type,
    text: text,
  };

  if (type === "to_do") {
    result.checked = blockData.checked ?? false;
  } else if (type === "callout") {
    result.icon = blockData.icon?.emoji ?? null;
  } else if (type === "image") {
    result.url = blockData.file?.url || blockData.external?.url || null;
    result.caption = blockData.caption?.map((x) => x.plain_text).join("") ?? "";
  }

  return result;
}

/*
 * MCP tools
 */
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "count_database_rows",
      description: "노션 데이터베이스의 총 행 개수를 반환합니다.",
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
      description: "노션 데이터베이스의 모든 행을 가져옵니다.",
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
      name: "add_database_row",
      description: "노션 데이터베이스에 새로운 행(페이지)을 추가합니다.",
      inputSchema: {
        type: "object",
        properties: {
          database_id: { type: "string", description: "노션 데이터베이스 ID" },
          title: { type: "string", description: "제목 (Title속성에 들어갈 텍스트)" },
          properties: { type: "object", description: "기타 속성 (선택사항, Notion API 객체 형식)" },
        },
        required: ["database_id", "title"],
      },
    },
    {
      name: "append_page_content",
      description: "노션 페이지 본문 하단에 텍스트 문단을 추가합니다.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "대상 노션 페이지 ID" },
          text: { type: "string", description: "추가할 텍스트 내용" },
        },
        required: ["page_id", "text"],
      },
    },
  ],
}));

/*
 * MCP tool execution
 */
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    /*
     * Count rows
     */
    if (name === "count_database_rows") {
      const pages = await queryAllPages(args.database_id);
      return {
        content: [
          {
            type: "text",
            text: `해당 데이터베이스의 총 행 개수는 ${pages.length}개입니다.`,
          },
        ],
      };
    }

    /*
     * Get all rows
     */
    if (name === "get_database_rows") {
      const pages = await queryAllPages(args.database_id);
      const rows = pages.map(pageToJson);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, count: rows.length, results: rows }, null, 2),
          },
        ],
      };
    }

    /*
     * Add database row
     */
    if (name === "add_database_row") {
      const titleKey = args.title_key || "Name";
      const properties = args.properties || {};
      
      properties[titleKey] = {
        title: [{ text: { content: args.title } }],
      };

      const newPage = await notion.pages.create({
        parent: { database_id: args.database_id },
        properties: properties,
      });

      return {
        content: [
          {
            type: "text",
            text: `새 행이成功적으로 추가되었습니다. (ID: ${newPage.id}, URL: ${newPage.url})`,
          },
        ],
      };
    }

    /*
     * Append page content
     */
    if (name === "append_page_content") {
      const response = await notion.blocks.children.append({
        block_id: args.page_id,
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: args.text } }],
            },
          },
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: `페이지 본문에 내용이 추가되었습니다. (추가된 블록 수: ${response.results.length})`,
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

/*
 * MCP SSE
 */
let transport;

app.get("/sse", async (req, res) => {
  try {
    transport = new SSEServerTransport("/messages", res);
    await mcpServer.connect(transport);
  } catch (error) {
    console.error("SSE error:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/*
 * MCP messages
 */
app.post("/messages", async (req, res) => {
  if (!transport) {
    return res.status(503).json({
      success: false,
      error: "MCP SSE transport is not connected.",
    });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("MCP message error:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/*
 * REST API - Count rows
 */
app.post("/api/count-rows", async (req, res) => {
  const { database_id } = req.body;

  if (!database_id) {
    return res.status(400).json({ success: false, error: "database_id is required." });
  }

  try {
    const pages = await queryAllPages(database_id);
    res.json({ success: true, count: pages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - Add Row (새 행/페이지 생성)
 * 
 * Body 예시:
 * {
 *   "database_id": "노션_DB_ID",
 *   "title": "KNIME에서 전달된 질문",
 *   "title_key": "Name", // 노션 DB의 제목 컬럼 이름 (기본값: "Name")
 *   "properties": {} // 선택사항: 다른 속성들
 * }
 */
app.post("/api/add-row", async (req, res) => {
  const { database_id, title, title_key = "Name", properties = {} } = req.body;

  if (!database_id || !title) {
    return res.status(400).json({
      success: false,
      error: "database_id and title are required.",
    });
  }

  try {
    const pageProperties = {
      ...properties,
      [title_key]: {
        title: [
          {
            text: {
              content: title,
            },
          },
        ],
      },
    };

    const response = await notion.pages.create({
      parent: { database_id: database_id },
      properties: pageProperties,
    });

    res.json({
      success: true,
      id: response.id,
      url: response.url,
    });
  } catch (error) {
    console.error("add-row API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - Append Page (쿼리 파라미터 & 별칭 지원)
 *
 * 사용 예시:
 * 1. 별칭 사용: /api/append-page?page=my_page
 * 2. 쿼리로 ID 전송: /api/append-page?page_id=3bae661e00ee807c9c6ae1cb9a7e7300
 * 3. 기존 방식(Body에 포함): /api/append-page
 */
app.post("/api/append-page", async (req, res) => {
  // 1. URL 쿼리(?page=... 또는 ?page_id=...)와 Body 양쪽에서 모두 파라미터를 읽어옴
  const { page, page_id: queryPageId } = req.query;
  const { page_id: bodyPageId, text, type = "paragraph", checked = false, icon = "💡" } = req.body;

  // 2. 우선순위 적용: 
  //   ① URL 쿼리의 page_id
  //   ② URL 쿼리의 page 별칭 (Render 환경변수 MY_PAGE_PAGE_ID 등 매핑)
  //   ③ Body에 들어있는 page_id
  let targetPageId = queryPageId || bodyPageId;

  if (!targetPageId && page) {
    const envKey = `${page.toUpperCase()}_PAGE_ID`; // 예: page=report -> REPORT_PAGE_ID
    targetPageId = process.env[envKey];
  }

  // 3. 필수값 검증
  if (!targetPageId || !text) {
    return res.status(400).json({
      success: false,
      error: "target page_id (or valid 'page' alias in query/body) and text are required.",
    });
  }

  try {
    let blockObject = {};

    // ⭐️ [핵심 수정 1] KNIME에서 문자열 "true"로 올 경우를 대비한 안전한 Boolean 형변환
    const isChecked = checked === true || checked === "true";
    switch (type) {
      case "heading_1": // 제목 1
        blockObject = {
          object: "block",
          type: "heading_1",
          heading_1: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;

      case "heading_2": // 제목 2
        blockObject = {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;

      case "heading_3": // 제목 3
        blockObject = {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;
        
      case "heading_4": // 제목 4
        blockObject = {
          object: "block",
          type: "heading_4",
          heading_4: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;

      // ⭐️ [핵심 수정 3] Row 5: 체크박스 할 일 (to_do) - isChecked 적용
      case "to_do": // 체크박스 할 일
        blockObject = {
          object: "block",
          type: "to_do",
          to_do: {
            rich_text: [{ type: "text", text: { content: text } }],
            checked: isChecked,
          },
        };
        break;

      case "quote": // 인용구 (좌측 세로줄)
        blockObject = {
          object: "block",
          type: "quote",
          quote: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;

      case "callout": // 콜아웃 (아이콘 + 배경 박스)
        blockObject = {
          object: "block",
          type: "callout",
          callout: {
            rich_text: [{ type: "text", text: { content: text } }],
            icon: { type: "emoji", emoji: icon },
          },
        };
        break;

      case "bulleted_list_item": // 글머리 기호 목록 (• 항목)
        blockObject = {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;

      case "toggle": // 토글 목록 (접었다 펼치는 항목)
        blockObject = {
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;
        
      default: // 기본값: 일반 문단
        blockObject = {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: text } }],
          },
        };
        break;
    }

    const response = await notion.blocks.children.append({
      block_id: page_id,
      children: [blockObject],
    });

    res.json({
      success: true,
      type: type,
      added_blocks: response.results.length,
    });
  } catch (error) {
    console.error("append-page API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - List databases
 */
app.get("/api/databases", async (req, res) => {
  try {
    const response = await notion.search({
      filter: { property: "object", value: "database" },
      page_size: 100,
    });

    const databases = (response.results || []).map((database) => ({
      id: database.id,
      title: getDatabaseTitle(database),
      url: database.url ?? null,
    }));

    res.json({ success: true, count: databases.length, results: databases });
  } catch (error) {
    console.error("databases API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - Questions DB
 */
app.get("/api/questions", async (req, res) => {
  const databaseId = req.query.database_id || process.env.QUESTIONS_DATABASE_ID;

  if (!databaseId) {
    return res.status(400).json({
      success: false,
      error: "database_id is required. Use ?database_id=... or set QUESTIONS_DATABASE_ID in Render.",
    });
  }

  try {
    const pages = await queryAllPages(databaseId);
    const rows = pages.map(pageToJson);
    res.json({ success: true, count: rows.length, results: rows });
  } catch (error) {
    console.error("questions API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - 공용 Database 조회 (Journal, Control, Questions 등 지원)
 *
 * 사용 예시:
 * 1. DB 별칭 사용 (Render 환경변수 연동): /api/database?db=journal
 * 2. DB 별칭 사용: /api/database?db=control
 * 3. 직접 ID 입력: /api/database?database_id=3bae661e00ee807c9c6ae1cb9a7e7300
 */
app.get("/api/database", async (req, res) => {
  const { db, database_id } = req.query;

  // 1. 전달된 db 이름(Alias)을 환경변수 매핑 이름으로 변환 (예: 'journal' -> 'JOURNAL_DATABASE_ID')
  let targetDatabaseId = database_id;

  if (!targetDatabaseId && db) {
    const envKey = `${db.toUpperCase()}_DATABASE_ID`;
    targetDatabaseId = process.env[envKey];
  }

  // 2. 만약 db 지정도 없고 database_id도 없으면 기본값(QUESTIONS_DATABASE_ID) 사용
  if (!targetDatabaseId) {
    targetDatabaseId = process.env.QUESTIONS_DATABASE_ID;
  }

  // 3. 여전히 ID가 없으면 예외 처리
  if (!targetDatabaseId) {
    return res.status(400).json({
      success: false,
      error:
        "database_id or valid 'db' alias is required. " +
        "Examples: /api/database?db=journal or /api/database?database_id=YOUR_ID",
    });
  }

  try {
    const pages = await queryAllPages(targetDatabaseId);
    const rows = pages.map(pageToJson);

    res.json({
      success: true,
      db_alias: db || "custom",
      database_id: targetDatabaseId,
      count: rows.length,
      results: rows,
    });
  } catch (error) {
    console.error("Database API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - Get one Notion page
 */
app.get("/api/page/:pageId", async (req, res) => {
  try {
    const page = await notion.pages.retrieve({
      page_id: req.params.pageId,
    });
    res.json({ success: true, result: pageToJson(page) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * REST API - 노션 페이지 본문(블록 목록) 읽기
 *
 * 사용 예시:
 * 1. 쿼리 사용: GET /api/page-content?page_id=3bae661e00ee807c9c6ae1cb9a7e7300
 * 2. 별칭 사용: GET /api/page-content?page=report
 */
app.get("/api/page-content", async (req, res) => {
  const { page, page_id } = req.query;

  // 별칭(page) 또는 direct page_id 처리
  let targetPageId = page_id;
  if (!targetPageId && page) {
    const envKey = `${page.toUpperCase()}_PAGE_ID`;
    targetPageId = process.env[envKey];
  }

  if (!targetPageId) {
    return res.status(400).json({
      success: false,
      error: "page_id or valid 'page' alias query parameter is required.",
    });
  }

  try {
    const blocks = [];
    let startCursor = undefined;

    // 페이지 내의 모든 블록 가져오기 (Pagination 자동 처리)
    do {
      const response = await notion.blocks.children.list({
        block_id: targetPageId,
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      });

      blocks.push(...(response.results || []));
      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    // 블록별 텍스트 및 속성 파싱
    const parsedBlocks = blocks.map(parseBlockContent);

    // 전체 본문을 하나의 텍스트 문서로 이어 붙인 결과도 함께 제공
    const fullText = parsedBlocks
      .map((b) => (b.text ? `[${b.type}] ${b.text}` : ""))
      .filter(Boolean)
      .join("\n");

    res.json({
      success: true,
      page_id: targetPageId,
      count: parsedBlocks.length,
      full_text: fullText, // 전처리된 전체 텍스트
      blocks: parsedBlocks, // 블록별 상세 구조 배열
    });
  } catch (error) {
    console.error("page-content API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * Health check
 */
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "notion-mcp-server",
    version: "1.3.0",
    endpoints: {
      databases: "/api/databases",
      questions: "/api/questions",
      page: "/api/page/:pageId",
      countRows: "/api/count-rows",
      addRow: "/api/add-row (POST)",
      appendPage: "/api/append-page (POST)",
      mcpSse: "/sse",
      mcpMessages: "/messages",
    },
  });
});

/*
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Render MCP server is running on port ${PORT}.`);
});
