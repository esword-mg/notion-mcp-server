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
      return property.title
        ?.map((x) => x.plain_text)
        .join("") ?? "";

    case "rich_text":
      return property.rich_text
        ?.map((x) => x.plain_text)
        .join("") ?? "";

    case "select":
      return property.select?.name ?? null;

    case "multi_select":
      return property.multi_select
        ?.map((x) => x.name) ?? [];

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
      return type
        ? property.formula[type] ?? null
        : null;
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

    const response =
      await notion.databases.query({

        database_id: databaseId,

        page_size: 100,

        ...(startCursor
          ? { start_cursor: startCursor }
          : {}),

      });

    results.push(
      ...(response.results || [])
    );

    startCursor =
      response.has_more
        ? response.next_cursor
        : undefined;

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

  for (
    const [name, property]
    of Object.entries(
      page.properties || {}
    )
  ) {

    result[name] =
      getPropertyValue(property);

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

  return database.title
    .map((item) => item.plain_text)
    .join("");
}


/*
 * MCP Server
 */
const mcpServer = new Server(

  {
    name: "notion-mcp-server",
    version: "1.2.0",
  },

  {
    capabilities: {
      tools: {},
    },
  }

);


/*
 * MCP tools
 */
mcpServer.setRequestHandler(

  ListToolsRequestSchema,

  async () => ({

    tools: [

      {
        name: "count_database_rows",

        description:
          "노션 데이터베이스의 총 행 개수를 반환합니다.",

        inputSchema: {

          type: "object",

          properties: {

            database_id: {

              type: "string",

              description:
                "노션 데이터베이스 ID",

            },

          },

          required: [
            "database_id"
          ],

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

              description:
                "노션 데이터베이스 ID",

            },

          },

          required: [
            "database_id"
          ],

        },

      },

    ],

  })

);


/*
 * MCP tool execution
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
       * Count rows
       */
      if (
        name ===
        "count_database_rows"
      ) {

        const pages =
          await queryAllPages(
            args.database_id
          );

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
       * Get all rows
       */
      if (
        name ===
        "get_database_rows"
      ) {

        const pages =
          await queryAllPages(
            args.database_id
          );

        const rows =
          pages.map(
            pageToJson
          );

        return {

          content: [

            {

              type: "text",

              text:
                JSON.stringify(

                  {

                    success: true,

                    count:
                      rows.length,

                    results:
                      rows,

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
 * MCP SSE
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

          error:
            error.message,

        });

      }

    }

  }
);


/*
 * MCP messages
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

          error:
            error.message,

        });

      }

    }

  }
);


/*
 * REST API
 *
 * Count rows
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

        count:
          pages.length,

      });


    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          error.message,

      });

    }

  }
);


/*
 * REST API
 *
 * IMPORTANT:
 * List databases that are accessible to the integration.
 *
 * This endpoint is for finding the actual
 * database IDs instead of guessing them from URLs.
 */
app.get(
  "/api/databases",
  async (req, res) => {

    try {

      const response =
        await notion.search({

          filter: {

            property: "object",

            value: "database",

          },

          page_size: 100,

        });


      const databases =
        (response.results || [])
          .map((database) => ({

            id:
              database.id,

            title:
              getDatabaseTitle(
                database
              ),

            url:
              database.url ?? null,

          }));


      res.json({

        success: true,

        count:
          databases.length,

        results:
          databases,

      });


    } catch (error) {

      console.error(
        "databases API error:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          error.message,

      });

    }

  }
);


/*
 * REST API
 *
 * Questions DB
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
        pages.map(
          pageToJson
        );


      res.json({

        success: true,

        count:
          rows.length,

        results:
          rows,

      });


    } catch (error) {

      console.error(
        "questions API error:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          error.message,

      });

    }

  }
);


/*
 * REST API
 *
 * Get one Notion page
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

        error:
          error.message,

      });

    }

  }
);


/*
 * Health check
 */
app.get(
  "/",
  (req, res) => {

    res.json({

      success: true,

      service:
        "notion-mcp-server",

      version:
        "1.2.0",

      endpoints: {

        databases:
          "/api/databases",

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
 * Start server
 */
app.listen(
  PORT,
  () => {

    console.log(
      `Render MCP server is running on port ${PORT}.`
    );

  }
);
