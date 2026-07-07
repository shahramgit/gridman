// The catalog builder pulls in electron (ipcMain/dialog via the ipc module
// and utils/filesystem) and the preferences store; the code under test never
// touches either, so stubs are enough.
jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() }, dialog: {} }));
jest.mock('electron-store', () => {
  return class MemoryStore {
    constructor() {
      this.data = {};
    }

    get(key, defaultValue) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], this.data);
      return value === undefined ? defaultValue : value;
    }

    set(key, value) {
      const parts = key.split('.');
      let node = this.data;
      for (const part of parts.slice(0, -1)) {
        node[part] = node[part] || {};
        node = node[part];
      }
      node[parts.at(-1)] = value;
    }

    delete(key) {
      delete this.data[key];
    }
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateApiCatalog, sortCatalogItems } = require('../../src/utils/api-catalog');
const { buildWorkspaceCatalog } = require('../../src/ipc/workspace-catalog');

// Seeded secrets — none of these may ever appear in a generated catalog.
const AUTH_TOKEN_SECRET = 'TOP-SECRET-AUTH-TOKEN-123';
const ENV_SECRET = 'ENV-SECRET-VALUE-456';
const BODY_SECRET = 'BODY-SECRET-789';
const APIKEY_SECRET = 'APIKEY-SECRET-000';

describe('workspace api catalog', () => {
  let workspacePath;

  const write = (relative, content) => {
    const pathname = path.join(workspacePath, relative);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, content);
  };

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-catalog-'));

    write(
      'workspace.yml',
      [
        'opencollection: 1.0.0',
        'info:',
        '  name: "Acme Workspace"',
        '  type: workspace',
        '',
        'collections:',
        '  - name: "Petstore"',
        '    path: "collections/petstore"',
        '  - name: "Empty Collection"',
        '    path: "collections/empty"',
        '',
        'specs:',
        '',
        'docs: \'\'',
        ''
      ].join('\n')
    );

    for (const dir of ['petstore', 'empty']) {
      write(
        `collections/${dir}/bruno.json`,
        JSON.stringify({ version: '1', name: dir, type: 'collection' })
      );
    }

    // Environment file with a secret value — must never be read into the catalog.
    write(
      'collections/petstore/environments/prod.bru',
      `vars {\n  apiToken: ${ENV_SECRET}\n}\n`
    );

    // Two folders whose seq order (users=1, admin=2) reverses alphabetical order.
    write('collections/petstore/users/folder.bru', 'meta {\n  name: Users\n  seq: 1\n}\n');
    write('collections/petstore/admin/folder.bru', 'meta {\n  name: Admin\n  seq: 2\n}\n');

    // Request with docs, params, sensitive header, bearer auth and a json body.
    write(
      'collections/petstore/users/get-user.bru',
      `meta {
  name: Get User
  type: http
  seq: 2
}

get {
  url: https://api.example.com/users/{{userId}}
  body: json
  auth: bearer
}

params:query {
  limit: 10
  ~offset: 0
}

headers {
  X-Api-Key: ${APIKEY_SECRET}
  Accept: application/json
}

auth:bearer {
  token: ${AUTH_TOKEN_SECRET}
}

body:json {
  { "password": "${BODY_SECRET}" }
}

docs {
  Fetches a single user by id.
}
`
    );

    // Plain request without params/headers/docs — tables must be omitted.
    write(
      'collections/petstore/users/list-users.bru',
      `meta {
  name: List Users
  type: http
  seq: 1
}

get {
  url: https://api.example.com/users
  body: none
  auth: none
}
`
    );

    // Nested folder inside Admin.
    write(
      'collections/petstore/admin/reports/folder.bru',
      'meta {\n  name: Reports\n  seq: 1\n}\n'
    );
    write(
      'collections/petstore/admin/reports/run-report.bru',
      `meta {
  name: Run Report
  type: http
  seq: 1
}

post {
  url: https://api.example.com/reports
  body: none
  auth: none
}
`
    );

    // Root-level request — must appear after the folders.
    write(
      'collections/petstore/health.bru',
      `meta {
  name: Health
  type: http
  seq: 1
}

get {
  url: https://api.example.com/health
  body: none
  auth: none
}
`
    );
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  describe('sortCatalogItems', () => {
    it('puts folders first, ordered by seq, then requests by seq', () => {
      const items = [
        { type: 'http-request', name: 'B request', seq: 2 },
        { type: 'folder', name: 'A folder', seq: 2 },
        { type: 'http-request', name: 'A request', seq: 1 },
        { type: 'folder', name: 'Z folder', seq: 1 },
        { type: 'http-request', name: 'No seq request' }
      ];
      expect(sortCatalogItems(items).map((item) => item.name)).toEqual([
        'Z folder',
        'A folder',
        'A request',
        'B request',
        'No seq request'
      ]);
    });
  });

  describe('markdown catalog', () => {
    let md;

    beforeEach(() => {
      md = buildWorkspaceCatalog({ workspacePath, format: 'md' }).content;
    });

    it('titles the document with the workspace name and one section per collection', () => {
      expect(md).toContain('# Acme Workspace');
      expect(md).toContain('## Petstore');
      expect(md).toContain('## Empty Collection');
      expect(md).toContain('_This collection has no requests._');
    });

    it('orders folders by seq before requests and respects request seq', () => {
      const usersIdx = md.indexOf('### 📁 Users');
      const adminIdx = md.indexOf('### 📁 Admin');
      const healthIdx = md.indexOf('Health');
      const listUsersIdx = md.indexOf('List Users');
      const getUserIdx = md.indexOf('Get User');

      expect(usersIdx).toBeGreaterThan(-1);
      expect(adminIdx).toBeGreaterThan(-1);
      // seq order (Users=1, Admin=2) beats alphabetical order.
      expect(usersIdx).toBeLessThan(adminIdx);
      // root request comes after all folders.
      expect(healthIdx).toBeGreaterThan(adminIdx);
      // within Users, List Users (seq 1) precedes Get User (seq 2).
      expect(listUsersIdx).toBeLessThan(getUserIdx);
    });

    it('nests folders as deeper headings', () => {
      expect(md).toContain('### 📁 Admin');
      expect(md).toContain('#### 📁 Reports');
      expect(md).toContain('##### `POST` Run Report');
    });

    it('renders method, url, docs, auth and body one-liners', () => {
      expect(md).toContain('`GET` Get User');
      expect(md).toContain('https://api.example.com/users/{{userId}}');
      expect(md).toContain('> Fetches a single user by id.');
      expect(md).toContain('**Auth:** bearer');
      expect(md).toContain('**Body:** json');
    });

    it('renders params/headers tables with enabled flags and redacts sensitive values', () => {
      expect(md).toContain('| Name | Value | Enabled |');
      expect(md).toContain('| limit | 10 | Yes |');
      expect(md).toContain('| offset | 0 | No |');
      expect(md).toContain('| Accept | application/json | Yes |');
      expect(md).toContain('| X-Api-Key | [redacted] | Yes |');
    });

    it('omits params/headers tables for requests without them', () => {
      const listUsersBlock = md.slice(md.indexOf('List Users'), md.indexOf('Get User'));
      expect(listUsersBlock).not.toContain('| Name | Value | Enabled |');
    });

    it('never leaks auth credentials, env values or request bodies', () => {
      expect(md).not.toContain(AUTH_TOKEN_SECRET);
      expect(md).not.toContain(ENV_SECRET);
      expect(md).not.toContain(BODY_SECRET);
      expect(md).not.toContain(APIKEY_SECRET);
    });
  });

  describe('html catalog', () => {
    let html;

    beforeEach(() => {
      html = buildWorkspaceCatalog({ workspacePath, format: 'html' }).content;
    });

    it('contains the expected sections and collapsible folders', () => {
      expect(html).toContain('<title>Acme Workspace — API Catalog</title>');
      expect(html).toContain('<h1>Acme Workspace</h1>');
      expect(html).toContain('<h2>Petstore</h2>');
      expect(html).toContain('<h2>Empty Collection</h2>');
      expect(html).toContain('<details class="folder" open><summary>📁 Users</summary>');
      expect(html).toContain('<details class="folder" open><summary>📁 Reports</summary>');
    });

    it('renders colored method badges and request details', () => {
      expect(html).toContain('<span class="method method-get">GET</span>');
      expect(html).toContain('<span class="method method-post">POST</span>');
      expect(html).toContain('https://api.example.com/users/{{userId}}');
      expect(html).toContain('Fetches a single user by id.');
      expect(html).toContain('Auth: <strong>bearer</strong>');
      expect(html).toContain('Body: <strong>json</strong>');
      expect(html).toContain('<td>[redacted]</td>');
    });

    it('is self-contained with no external asset references', () => {
      expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
      expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
      expect(html).not.toMatch(/@import/i);
      expect(html).not.toMatch(/url\(\s*["']?https?:/i);
      expect(html).not.toContain('<script');
    });

    it('never leaks auth credentials, env values or request bodies', () => {
      expect(html).not.toContain(AUTH_TOKEN_SECRET);
      expect(html).not.toContain(ENV_SECRET);
      expect(html).not.toContain(BODY_SECRET);
      expect(html).not.toContain(APIKEY_SECRET);
    });
  });

  describe('input validation', () => {
    it('rejects unknown formats and missing workspaces', () => {
      expect(() => buildWorkspaceCatalog({ workspacePath, format: 'pdf' })).toThrow('Unsupported catalog format');
      expect(() => buildWorkspaceCatalog({ workspacePath: path.join(workspacePath, 'nope'), format: 'md' }))
        .toThrow('Workspace path does not exist');
    });

    it('generateApiCatalog handles an empty workspace', () => {
      const md = generateApiCatalog({ workspaceName: 'Bare', collections: [], format: 'md' });
      expect(md).toContain('# Bare');
      expect(md).toContain('_This workspace has no collections._');
    });
  });
});
