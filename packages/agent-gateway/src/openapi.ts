/**
 * OpenAPI 3.1 specification for CC Gateway HTTP API.
 * Served at GET /openapi.json for auto-discovery.
 */
export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'CC Gateway',
    version: '0.1.0',
    description:
      'HTTP API gateway for controlling Claude Code sessions across project worktrees. Wraps @anthropic-ai/claude-agent-sdk.',
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
    '/sessions/discover': {
      get: {
        operationId: 'discoverSessions',
        summary: 'Discover sessions from all agent sources',
        description:
          'Iterates all discovered projects, calls each registered SessionSource, returns merged results sorted by last_activity DESC.',
        parameters: [
          {
            name: 'since',
            in: 'query',
            schema: { type: 'string', format: 'date-time' },
            description: 'ISO timestamp — only sessions with activity after this time',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50 },
            description: 'Max sessions per project per source',
          },
          {
            name: 'project',
            in: 'query',
            schema: { type: 'string' },
            description: 'Filter to a specific project name',
          },
        ],
        responses: {
          '200': {
            description: 'Discovered sessions from all sources',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DiscoveredSession' },
                    },
                    sources: {
                      type: 'object',
                      additionalProperties: {
                        type: 'object',
                        properties: {
                          available: { type: 'boolean' },
                          session_count: { type: 'integer' },
                        },
                        required: ['available', 'session_count'],
                      },
                    },
                  },
                  required: ['sessions', 'sources'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
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
              properties: { error: { type: 'string' } },
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
      DiscoveredSession: {
        type: 'object',
        properties: {
          sdk_session_id: { type: 'string' },
          agent: { type: 'string', example: 'claude' },
          project_dir: { type: 'string' },
          project: { type: 'string' },
          branch: { type: 'string' },
          started_at: { type: 'string', format: 'date-time' },
          last_activity: { type: 'string', format: 'date-time' },
          summary: { type: 'string' },
          tag: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          message_count: { type: ['integer', 'null'] },
          user: { type: ['string', 'null'] },
        },
        required: [
          'sdk_session_id',
          'agent',
          'project_dir',
          'project',
          'branch',
          'started_at',
          'last_activity',
          'summary',
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
