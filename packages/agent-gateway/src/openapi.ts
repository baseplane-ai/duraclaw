/**
 * OpenAPI 3.1 specification for the Duraclaw agent-gateway.
 * Served at GET /openapi.json for auto-discovery.
 *
 * Gateway is a thin control-plane: spawn session-runner subprocesses, list
 * and inspect them, expose project/git/kata helpers. The actual Claude SDK
 * query lives in the session-runner bin.
 */
export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Duraclaw Agent Gateway',
    version: '0.1.0',
    description:
      'Control plane for Duraclaw session-runner subprocesses. Spawns detached runners, exposes status + list endpoints, and serves project/git/kata helpers.',
  },
  servers: [{ url: 'http://127.0.0.1:9877', description: 'Local default' }],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Health check',
        description: 'Returns server status, version, and uptime. No authentication required.',
        security: [],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    version: { type: 'string', example: '0.1.0' },
                    uptime_ms: { type: 'integer' },
                  },
                  required: ['status', 'version', 'uptime_ms'],
                },
              },
            },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI specification',
        description: 'Returns this OpenAPI 3.1 spec. No authentication required.',
        security: [],
        responses: {
          '200': {
            description: 'OpenAPI spec',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/sessions/start': {
      post: {
        operationId: 'startSession',
        summary: 'Spawn a detached session-runner',
        description:
          'Writes the command to disk, spawns a detached session-runner subprocess, and returns the assigned session_id. Returns 200 within 100ms — the runner dials back to callback_url asynchronously.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  callback_url: { type: 'string', example: 'ws://worker.example.com/cb' },
                  callback_token: { type: 'string' },
                  cmd: { type: 'object' },
                },
                required: ['callback_url', 'callback_token', 'cmd'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Runner spawned',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    session_id: { type: 'string', format: 'uuid' },
                  },
                  required: ['ok', 'session_id'],
                },
              },
            },
          },
          '400': { description: 'Invalid request body' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { description: 'session-runner bin not found' },
        },
      },
    },
    '/sessions': {
      get: {
        operationId: 'listSessions',
        summary: 'List all sessions known to the gateway',
        description:
          'Scans the sessions directory for pid files and returns a status snapshot per session. Replaces the old /sessions/discover endpoint.',
        responses: {
          '200': {
            description: 'Known sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', example: true },
                    sessions: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SessionStateSnapshot' },
                    },
                  },
                  required: ['ok', 'sessions'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/sessions/{id}/status': {
      get: {
        operationId: 'getSessionStatus',
        summary: 'Get the current state of a session',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Session state snapshot',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    {
                      type: 'object',
                      properties: { ok: { type: 'boolean', example: true } },
                      required: ['ok'],
                    },
                    { $ref: '#/components/schemas/SessionStateSnapshot' },
                  ],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'No pid or exit file for this session id' },
        },
      },
    },
    '/projects': {
      get: {
        operationId: 'listProjects',
        summary: 'List discovered projects',
        description:
          'Returns all git repos under /data/projects/. When PROJECT_PATTERNS env is set, filters to matching prefixes.',
        responses: {
          '200': {
            description: 'Array of discovered projects',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ProjectInfo' },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/projects/{name}/files': {
      get: {
        operationId: 'listProjectFiles',
        summary: 'List directory entries',
        parameters: [
          { $ref: '#/components/parameters/ProjectName' },
          {
            name: 'path',
            in: 'query',
            schema: { type: 'string', default: '/' },
            description: 'Relative directory path within the project',
          },
          {
            name: 'depth',
            in: 'query',
            schema: { type: 'integer', default: 1, minimum: 1, maximum: 5 },
            description: 'Directory traversal depth (max 5)',
          },
        ],
        responses: {
          '200': {
            description: 'Directory listing',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/FileEntry' },
                    },
                  },
                  required: ['entries'],
                },
              },
            },
          },
          '400': { description: 'Path traversal not allowed' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Project or path not found' },
        },
      },
    },
    '/projects/{name}/files/{path}': {
      get: {
        operationId: 'getFileContents',
        summary: 'Read file contents',
        parameters: [
          { $ref: '#/components/parameters/ProjectName' },
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Relative file path within the project',
          },
        ],
        responses: {
          '200': { description: 'Raw file content (Content-Type varies by extension)' },
          '400': { description: 'Path traversal not allowed or path is a directory' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Project or file not found' },
          '413': { description: 'File too large (>1MB)' },
        },
      },
    },
    '/projects/{name}/git-status': {
      get: {
        operationId: 'getGitStatus',
        summary: 'Git working tree status',
        parameters: [{ $ref: '#/components/parameters/ProjectName' }],
        responses: {
          '200': {
            description: 'Per-file git status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    files: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/GitFileStatus' },
                    },
                  },
                  required: ['files'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Project not found' },
        },
      },
    },
    '/projects/{name}/kata-status': {
      get: {
        operationId: 'getKataStatus',
        summary: 'Kata workflow state',
        parameters: [{ $ref: '#/components/parameters/ProjectName' }],
        responses: {
          '200': {
            description: 'Latest kata session state for the project',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    kata_state: {
                      oneOf: [{ $ref: '#/components/schemas/KataSessionState' }, { type: 'null' }],
                    },
                  },
                  required: ['kata_state'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Project not found' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'CC_GATEWAY_API_TOKEN. Optional if token is not configured on the server.',
      },
    },
    parameters: {
      ProjectName: {
        name: 'name',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Project directory name (e.g. "baseplane-dev1")',
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid bearer token',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean', example: false }, error: { type: 'string' } },
              required: ['error'],
            },
          },
        },
      },
    },
    schemas: {
      ProjectInfo: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'baseplane-dev1' },
          path: { type: 'string', example: '/data/projects/baseplane-dev1' },
          branch: { type: 'string', example: 'main' },
          dirty: { type: 'boolean' },
          active_session: { type: ['string', 'null'] },
          repo_origin: { type: ['string', 'null'] },
        },
        required: ['name', 'path', 'branch', 'dirty', 'active_session', 'repo_origin'],
      },
      FileEntry: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string', enum: ['file', 'dir'] },
          size: { type: 'integer', description: 'File size in bytes (files only)' },
        },
        required: ['name', 'path', 'type'],
      },
      GitFileStatus: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['modified', 'staged', 'untracked', 'clean'] },
        },
        required: ['path', 'status'],
      },
      SessionStateSnapshot: {
        type: 'object',
        properties: {
          session_id: { type: 'string', format: 'uuid' },
          state: {
            type: 'string',
            enum: ['running', 'completed', 'failed', 'aborted', 'crashed'],
          },
          sdk_session_id: { type: ['string', 'null'] },
          last_activity_ts: { type: ['integer', 'null'] },
          last_event_seq: { type: 'integer' },
          cost: {
            type: 'object',
            properties: {
              input_tokens: { type: 'integer' },
              output_tokens: { type: 'integer' },
              usd: { type: 'number' },
            },
            required: ['input_tokens', 'output_tokens', 'usd'],
          },
          model: { type: ['string', 'null'] },
          turn_count: { type: 'integer' },
        },
        required: [
          'session_id',
          'state',
          'sdk_session_id',
          'last_activity_ts',
          'last_event_seq',
          'cost',
          'model',
          'turn_count',
        ],
      },
      KataSessionState: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          workflowId: { type: ['string', 'null'] },
          issueNumber: { type: ['integer', 'null'] },
          sessionType: { type: ['string', 'null'] },
          currentMode: { type: ['string', 'null'] },
          currentPhase: { type: ['string', 'null'] },
          completedPhases: { type: 'array', items: { type: 'string' } },
          template: { type: ['string', 'null'] },
          phases: { type: 'array', items: { type: 'string' } },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['sessionId', 'updatedAt'],
      },
    },
  },
  security: [{ bearerAuth: [] }],
} as const
