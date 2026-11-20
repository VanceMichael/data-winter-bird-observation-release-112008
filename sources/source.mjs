import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const json = (value) => JSON.stringify(value);
const data = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));

function write(response, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const value = status === 204 || status === 304 ? '' : body;
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  response.end(value);
}

function fillFormFields(body, fieldNames, encoded) {
  const form = new URLSearchParams(encoded);
  const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return fieldNames.reduce((html, name) => {
    const value = (form.get(name) ?? '').replace(/[&<>"]/g, (character) => escaped[character]);
    return html.replaceAll('{{' + name + '}}', () => value);
  }, body);
}

export function createSource() {
  let step = data.steps[0];
  const calls = [];

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname + url.search;
      if (request.method === 'PUT' && url.pathname === '/_source_clock') {
        const next = url.searchParams.get('step');
        if (!data.steps.includes(next)) {
          write(response, 400, json({ error: '未知的演练阶段' }));
          return;
        }
        step = next;
        write(response, 200, json({ step }));
        return;
      }
      if (request.method === 'GET' && path === '/_source_calls') {
        write(response, 200, json(calls));
        return;
      }

      let requestBody = '';
      for await (const chunk of request) requestBody += chunk;
      calls.push({ step, method: request.method, path, body: requestBody });
      const key = request.method + ' ' + path;
      const route = data.routes[step]?.[key] ?? data.routes.common?.[key];
      if (!route) {
        write(response, 404, json({ error: '本地来源没有这条路径' }));
        return;
      }
      if (route.body !== undefined) {
        const body = route.formFields ? fillFormFields(route.body, route.formFields, requestBody) : route.body;
        write(response, route.status ?? 200, typeof body === 'string' && route.type ? body : json(body),
          route.type, route.headers);
        return;
      }
      write(response, route.status ?? 204, '', route.type, route.headers);
    } catch {
      if (!response.headersSent) write(response, 500, json({ error: '本地来源出错' }));
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.SOURCE_PORT ?? 4173);
  createSource().listen(port, '127.0.0.1', function () {
    process.stdout.write(`本地来源 http://127.0.0.1:${this.address().port}\n`);
  });
}
